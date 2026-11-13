import {
  type AgentProfile,
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  parseAgentMentions,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { teamDelegationRejection } from "../mcp/AgentTeams.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isActiveRun } from "./CommandPolicy.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const SETTLED_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const HANDLED_LIMIT = 500;

/** Only what a person typed: bot tasks and agent messages never fan out again. */
function isTypedMessage(message: OrchestrationV2ConversationMessage): boolean {
  return (
    message.role === "user" &&
    message.createdBy === "user" &&
    (message.creationSource === "web" || message.creationSource === "mobile") &&
    message.text.includes("@")
  );
}

/** A bot's member thread under the tagged thread, from the thread's task records. */
export interface AgentMentionMember {
  readonly profileId: string;
  readonly threadId: ThreadId;
  readonly active: boolean;
  /** Archived or deleted: a new tag starts a fresh member instead. */
  readonly closed: boolean;
}

export interface AgentMentionPlan {
  readonly commands: ReadonlyArray<OrchestrationV2Command>;
  /** Tagged bots that could not join, with the reason. */
  readonly skipped: ReadonlyArray<{ readonly profileId: string; readonly reason: string }>;
}

function mentionTask(parent: OrchestrationV2AppThread, text: string): string {
  return `You were tagged in the thread "${parent.title}". Reply to the user's message there:\n\n${text}`;
}

/**
 * What a user's message that tags bots with `@<id>` should dispatch: a follow-up to the
 * bot's existing member thread under this thread, or else a delegated task that starts one,
 * the same commands `delegate_task` and `t3_thread_send` produce. Pure, so it is tested
 * without an orchestrator.
 */
export function planAgentMentions(input: {
  readonly parent: OrchestrationV2AppThread;
  readonly run: Pick<OrchestrationV2Run, "id" | "rootNodeId">;
  readonly message: Pick<OrchestrationV2ConversationMessage, "id" | "text">;
  readonly profiles: ReadonlyArray<AgentProfile>;
  readonly members: ReadonlyArray<AgentMentionMember>;
}): AgentMentionPlan {
  const { parent, run, message } = input;
  const mentioned = parseAgentMentions(message.text, input.profiles);
  const commands: Array<OrchestrationV2Command> = [];
  const skipped: Array<{ profileId: string; reason: string }> = [];
  if (mentioned.length === 0 || run.rootNodeId === null) return { commands, skipped };
  let activeMembers = input.members.filter((member) => member.active).length;
  for (const profile of mentioned) {
    const key = `${message.id}:${profile.id}`;
    const existing = input.members
      .filter((member) => member.profileId === profile.id && !member.closed)
      .at(-1);
    if (existing !== undefined) {
      commands.push({
        type: "message.dispatch",
        commandId: CommandId.make(`server:agent-mention:${key}`),
        threadId: existing.threadId,
        messageId: MessageId.make(`message:agent-mention:${key}`),
        senderThreadId: parent.id,
        text: mentionTask(parent, message.text),
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "server",
      });
      continue;
    }
    const rejection = teamDelegationRejection(parent, activeMembers);
    if (rejection !== undefined) {
      skipped.push({ profileId: profile.id, reason: rejection });
      continue;
    }
    activeMembers += 1;
    commands.push({
      type: "delegated_task.request",
      commandId: CommandId.make(`server:agent-mention:${key}`),
      createdBy: "user",
      creationSource: "server",
      parentThreadId: parent.id,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId,
      task: mentionTask(parent, message.text),
      title: profile.name,
      modelSelection: profile.modelSelection ?? parent.modelSelection,
      runtimeMode: profile.runtimeMode ?? parent.runtimeMode,
      interactionMode: profile.interactionMode ?? parent.interactionMode,
      agentProfileId: profile.id,
      completionWake: "always",
    });
  }
  return { commands, skipped };
}

/**
 * Brings bots tagged in a user's message into the thread once the message's run starts,
 * so they join as delegated members and their results wake this thread like any task.
 * The thread's own agent still takes the message as usual.
 */
export class AgentMentionReactor extends Context.Service<
  AgentMentionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/AgentMentionReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  // Run and message events repeat; these keep the reads to once per run and message. Command
  // ids make a repeat after a restart harmless.
  const handledRuns = new Set<RunId>();
  const handledMessages = new Set<MessageId>();
  const remember = <A>(set: Set<A>, value: A) => {
    set.add(value);
    if (set.size > HANDLED_LIMIT) set.delete(set.values().next().value!);
  };

  const bringIn = Effect.fnUntraced(function* (
    threadId: ThreadId,
    run: Pick<OrchestrationV2Run, "id" | "rootNodeId">,
    message: Pick<OrchestrationV2ConversationMessage, "id" | "text">,
    profiles: ReadonlyArray<AgentProfile>,
  ) {
    remember(handledMessages, message.id);
    const mentioned = new Set(parseAgentMentions(message.text, profiles).map((bot) => bot.id));
    if (mentioned.size === 0) return;
    const { thread, subagents } = yield* projections.getThreadRecords(threadId, ["subagents"]);
    const members: Array<AgentMentionMember> = [];
    for (const task of subagents) {
      if (
        task.origin !== "app_owned" ||
        task.childThreadId === null ||
        task.agentProfileId === undefined
      ) {
        continue;
      }
      // Only a tagged bot's own thread is read; a purged one is treated as closed.
      const child = mentioned.has(task.agentProfileId)
        ? yield* projections
            .getThread(task.childThreadId)
            .pipe(Effect.orElseSucceed(() => undefined))
        : undefined;
      members.push({
        profileId: task.agentProfileId,
        threadId: task.childThreadId,
        active: !SETTLED_TASK_STATUSES.has(task.status),
        closed:
          mentioned.has(task.agentProfileId) &&
          (child === undefined || child.archivedAt !== null || child.deletedAt !== null),
      });
    }
    const plan = planAgentMentions({ parent: thread, run, message, profiles, members });
    for (const skipped of plan.skipped) {
      yield* Effect.logWarning("A tagged bot could not join the thread.", {
        threadId: thread.id,
        ...skipped,
      });
    }
    for (const command of plan.commands) {
      yield* engine.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Bringing in a tagged bot failed.", {
            threadId: thread.id,
            commandId: command.commandId,
            cause,
          }),
        ),
      );
    }
  });

  // Runs for every domain event; most return on the first checks.
  const handle: AgentMentionReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      // A message steered into a running turn joins that run without starting one.
      if (event.type === "message.updated") {
        const message = event.payload;
        if (!isTypedMessage(message) || message.runId === null || handledMessages.has(message.id)) {
          return;
        }
        const profiles = (yield* serverSettings.getSettings).agentProfiles;
        if (profiles.length === 0) return;
        const run = (yield* projections.getThreadRecords(event.threadId, ["runs"], {
          runIds: [message.runId],
        })).runs.find((candidate) => candidate.id === message.runId);
        // A queued message waits for its run to start, below.
        if (run === undefined || !isActiveRun(run) || run.rootNodeId === null) return;
        yield* bringIn(event.threadId, run, message, profiles);
        return;
      }
      if (event.type !== "run.created" && event.type !== "run.updated") return;
      const run = event.payload;
      if (
        !isActiveRun(run) ||
        run.rootNodeId === null ||
        handledRuns.has(run.id) ||
        handledMessages.has(run.userMessageId)
      ) {
        return;
      }
      const profiles = (yield* serverSettings.getSettings).agentProfiles;
      if (profiles.length === 0) return;
      const { messages } = yield* projections.getThreadRecords(event.threadId, ["messages"], {
        messageIds: [run.userMessageId],
      });
      remember(handledRuns, run.id);
      const message = messages.find((candidate) => candidate.id === run.userMessageId);
      if (message === undefined || !isTypedMessage(message)) return;
      yield* bringIn(event.threadId, run, message, profiles);
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Handling bot mentions failed.", { threadId: event.threadId, cause }),
        ),
      ),
  );

  const start: AgentMentionReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("bot mention event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies AgentMentionReactor["Service"];
});

export const layer = Layer.effect(AgentMentionReactor, make);
