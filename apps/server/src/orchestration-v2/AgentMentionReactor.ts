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
const HANDLED_RUNS_LIMIT = 500;

export interface AgentMentionMember {
  readonly thread: OrchestrationV2AppThread;
  readonly active: boolean;
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
  let activeMembers = input.members.filter(
    (member) => member.active && member.thread.agentProfileId !== undefined,
  ).length;
  for (const profile of mentioned) {
    const key = `${message.id}:${profile.id}`;
    const existing = input.members
      .filter(
        (member) =>
          member.thread.agentProfileId === profile.id &&
          member.thread.archivedAt === null &&
          member.thread.deletedAt === null,
      )
      .at(-1);
    if (existing !== undefined) {
      commands.push({
        type: "message.dispatch",
        commandId: CommandId.make(`server:agent-mention:${key}`),
        threadId: existing.thread.id,
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
  // A run updates many times; this keeps the message read to once per run. Command ids make
  // a repeat after a restart harmless.
  const handledRuns = new Set<RunId>();

  // Runs for every domain event; most return on the first checks.
  const handle: AgentMentionReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "run.created" && event.type !== "run.updated") return;
      const run = event.payload;
      if (!isActiveRun(run) || run.rootNodeId === null || handledRuns.has(run.id)) return;
      const profiles = (yield* serverSettings.getSettings).agentProfiles;
      if (profiles.length === 0) return;
      handledRuns.add(run.id);
      if (handledRuns.size > HANDLED_RUNS_LIMIT) {
        handledRuns.delete(handledRuns.values().next().value!);
      }
      const { thread, messages, subagents } = yield* projections.getThreadRecords(
        event.threadId,
        ["messages", "subagents"],
        { messageIds: [run.userMessageId] },
      );
      const message = messages.find((candidate) => candidate.id === run.userMessageId);
      // Only what a person typed: bot tasks and agent messages never fan out again.
      if (
        message === undefined ||
        message.createdBy !== "user" ||
        (message.creationSource !== "web" && message.creationSource !== "mobile")
      ) {
        return;
      }
      if (parseAgentMentions(message.text, profiles).length === 0) return;
      const members: Array<AgentMentionMember> = [];
      for (const task of subagents) {
        if (
          task.origin !== "app_owned" ||
          task.childThreadId === null ||
          task.agentProfileId === undefined
        ) {
          continue;
        }
        const child = yield* projections.getThread(task.childThreadId);
        members.push({ thread: child, active: !SETTLED_TASK_STATUSES.has(task.status) });
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
