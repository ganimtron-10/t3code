import {
  AgentProfileId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as TeamReplyReactor from "./TeamReplyReactor.ts";

const chiefId = ThreadId.make("thread:chief");
const runId = RunId.make("run:qa-1");

const member = (id: string, profile: string | undefined, parent: ThreadId | null = chiefId) =>
  ({
    id: ThreadId.make(id),
    title: id,
    ...(profile === undefined ? {} : { agentProfileId: AgentProfileId.make(profile) }),
    lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: chiefId },
    archivedAt: null,
    deletedAt: null,
  }) as unknown as OrchestrationV2AppThread;

const developer = member("thread:developer", "developer");
const chief = member("thread:chief", "chief", null);
const qa = member("thread:qa", "qa");

const message = (fields: Partial<OrchestrationV2ConversationMessage>) =>
  ({
    createdBy: "agent",
    creationSource: "mcp",
    runId,
    role: "user",
    text: "",
    ...fields,
  }) as OrchestrationV2ConversationMessage;

const runEvent = (status: string) =>
  ({
    type: "run.updated",
    threadId: qa.id,
    payload: { id: runId, status, userMessageId: MessageId.make("message:chief-task") },
  }) as unknown as OrchestrationV2DomainEvent;

function handleWith(input: {
  readonly sender: OrchestrationV2AppThread;
  readonly trigger: Partial<OrchestrationV2ConversationMessage>;
  readonly others?: ReadonlyArray<OrchestrationV2AppThread>;
  readonly answer?: string;
  readonly status?: string;
}) {
  const dispatched: Array<OrchestrationV2Command> = [];
  const layer = TeamReplyReactor.layer.pipe(
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        dispatch: (command) => {
          dispatched.push(command as OrchestrationV2Command);
          return Effect.succeed({ sequence: 1 } as never);
        },
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThread: (id) =>
          Effect.succeed(
            [input.sender, ...(input.others ?? []), chief].find((thread) => thread.id === id)!,
          ),
        getThreadRecords: () =>
          Effect.succeed({
            thread: qa,
            messages: [
              // The Chief's task started the run; the sibling's message steered in.
              message({ id: MessageId.make("message:chief-task"), senderThreadId: chiefId }),
              message({ id: MessageId.make("message:ask"), ...input.trigger }),
              ...(input.others ?? []).map((other) =>
                message({ id: MessageId.make(`message:${other.id}`), senderThreadId: other.id }),
              ),
              ...(input.answer === undefined
                ? []
                : [
                    message({
                      id: MessageId.make("message:answer"),
                      role: "assistant",
                      text: input.answer,
                    }),
                  ]),
            ],
          } as never),
      }),
    ),
  );
  return Effect.gen(function* () {
    const reactor = yield* TeamReplyReactor.TeamReplyReactor;
    yield* reactor.handle(runEvent(input.status ?? "completed"));
    return dispatched;
  }).pipe(Effect.provide(layer));
}

it.effect("answers every sibling whose message steered into the run, once each", () =>
  Effect.gen(function* () {
    const infra = member("thread:infra", "infra");
    const dispatched = yield* handleWith({
      sender: developer,
      trigger: { senderThreadId: developer.id },
      others: [infra],
      answer: "Done.",
    });
    assert.deepEqual(
      dispatched.map((command) => (command as { threadId: string }).threadId),
      [developer.id, infra.id],
    );
  }),
);

it.effect("queues a sibling's answer back to the member that asked", () =>
  Effect.gen(function* () {
    const dispatched = yield* handleWith({
      sender: developer,
      trigger: { senderThreadId: developer.id },
      answer: "All 12 tests pass.",
    });
    assert.lengthOf(dispatched, 1);
    assert.deepInclude(dispatched[0], {
      type: "message.dispatch",
      threadId: developer.id,
      senderThreadId: qa.id,
      text: "Reply to your message:\n\nAll 12 tests pass.",
      createdBy: "agent",
      creationSource: "server",
      dispatchMode: { type: "queue_after_active" },
    });
  }),
);

it.effect("tells the asker when the sibling's turn failed", () =>
  Effect.gen(function* () {
    const dispatched = yield* handleWith({
      sender: developer,
      trigger: { senderThreadId: developer.id },
      status: "failed",
    });
    assert.include((dispatched[0] as { text: string }).text, "turn failed");
  }),
);

it.effect("sends no reply for replies, the Chief, threads without a profile, or users", () =>
  Effect.gen(function* () {
    const cases = [
      {
        sender: developer,
        trigger: { senderThreadId: developer.id, creationSource: "server" as const },
      },
      { sender: chief, trigger: { senderThreadId: chiefId } },
      {
        sender: member("thread:plain", undefined),
        trigger: { senderThreadId: ThreadId.make("thread:plain") },
      },
      { sender: developer, trigger: { senderThreadId: developer.id, createdBy: "user" as const } },
    ];
    for (const testCase of cases) {
      assert.lengthOf(yield* handleWith({ ...testCase, answer: "done" }), 0);
    }
  }),
);
