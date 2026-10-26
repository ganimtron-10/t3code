import { CommandId, MessageId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { areTeamSiblings } from "../mcp/AgentTeams.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const MAX_REPLY_CHARS = 8_000;

/**
 * Parent and child already wake each other through delegated task results.
 * Team siblings have no such link, so when a member's turn that another member
 * started with t3_thread_send ends, its answer is queued back to the sender.
 * Replies are server-sourced, so a reply never asks for another reply.
 */
export class TeamReplyReactor extends Context.Service<
  TeamReplyReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/TeamReplyReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  // Runs for every domain event; most return on the first check.
  const handle: TeamReplyReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "run.updated") return;
      const run = event.payload;
      if (run.status !== "completed" && run.status !== "failed") return;
      const recipient = yield* projections.getThreadRecords(event.threadId, ["messages"]);
      const trigger = recipient.messages.find((message) => message.id === run.userMessageId);
      if (
        trigger === undefined ||
        trigger.createdBy !== "agent" ||
        trigger.creationSource !== "mcp" ||
        trigger.senderThreadId === undefined
      ) {
        return;
      }
      const sender = yield* projections.getThread(trigger.senderThreadId);
      if (
        !areTeamSiblings(sender, recipient.thread) ||
        sender.archivedAt !== null ||
        sender.deletedAt !== null
      ) {
        return;
      }
      const answer = recipient.messages
        .findLast((message) => message.runId === run.id && message.role === "assistant")
        ?.text.trim();
      const readHint = `Read the full thread with t3_thread_read on thread ${recipient.thread.id}.`;
      const text =
        run.status === "failed"
          ? `Your message did not get a reply: this teammate's turn failed. ${readHint}`
          : answer === undefined || answer === ""
            ? `This teammate finished your request without a written reply. ${readHint}`
            : answer.length > MAX_REPLY_CHARS
              ? `Reply to your message (cut to ${MAX_REPLY_CHARS} characters; ${readHint}):\n\n${answer.slice(0, MAX_REPLY_CHARS)}`
              : `Reply to your message:\n\n${answer}`;
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:team-reply:${run.id}`),
        threadId: sender.id,
        messageId: MessageId.make(`message:team-reply:${run.id}`),
        senderThreadId: recipient.thread.id,
        text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delivering a team reply failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: TeamReplyReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("team reply event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies TeamReplyReactor["Service"];
});

export const layer = Layer.effect(TeamReplyReactor, make);
