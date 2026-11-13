import {
  type AgentProfile,
  AgentProfileId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as AgentMentionReactor from "./AgentMentionReactor.ts";
import { type AgentMentionMember, planAgentMentions } from "./AgentMentionReactor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const parentId = ThreadId.make("thread:main");
const modelSelection = { instanceId: "claudeAgent", model: "claude-haiku" };
const parent = {
  id: parentId,
  title: "Fix login",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentId },
  archivedAt: null,
  deletedAt: null,
} as unknown as OrchestrationV2AppThread;

const profile = (id: string, fields: Partial<AgentProfile> = {}) =>
  ({
    id: AgentProfileId.make(id),
    name: id.toUpperCase(),
    modelSelection: null,
    runtimeMode: null,
    interactionMode: null,
    ...fields,
  }) as AgentProfile;

const member = (id: string, profileId: string, active = false): AgentMentionMember => ({
  thread: {
    ...parent,
    id: ThreadId.make(id),
    agentProfileId: AgentProfileId.make(profileId),
    lineage: { parentThreadId: parentId, relationshipToParent: "subagent", rootThreadId: parentId },
  } as OrchestrationV2AppThread,
  active,
});

const run = { id: RunId.make("run:1"), rootNodeId: NodeId.make("node:root") };
const message = (text: string) => ({ id: MessageId.make("message:1"), text });

describe("planAgentMentions", () => {
  it("delegates a task to each newly tagged bot with its own model and modes", () => {
    const reviewer = profile("reviewer", {
      modelSelection: { instanceId: "codex", model: "gpt-5" } as never,
      runtimeMode: "approval-required" as never,
    });
    const plan = planAgentMentions({
      parent,
      run,
      message: message("@reviewer and @qa look at this"),
      profiles: [reviewer, profile("qa"), profile("infra")],
      members: [],
    });
    assert.deepEqual(plan.skipped, []);
    assert.deepEqual(
      plan.commands.map((command) => command.type),
      ["delegated_task.request", "delegated_task.request"],
    );
    assert.deepInclude(plan.commands[0] as Record<string, unknown>, {
      commandId: "server:agent-mention:message:1:reviewer",
      parentThreadId: parentId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId,
      title: "REVIEWER",
      agentProfileId: "reviewer",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "user",
    });
    assert.deepInclude(plan.commands[1] as Record<string, unknown>, {
      agentProfileId: "qa",
      modelSelection,
    });
    assert.include((plan.commands[0] as { task: string }).task, 'tagged in the thread "Fix login"');
  });

  it("hands the message to the bot's existing member thread instead of starting another", () => {
    const plan = planAgentMentions({
      parent,
      run,
      message: message("@qa again please"),
      profiles: [profile("qa")],
      members: [member("thread:qa-old", "qa"), member("thread:qa", "qa")],
    });
    assert.lengthOf(plan.commands, 1);
    assert.deepInclude(plan.commands[0] as Record<string, unknown>, {
      type: "message.dispatch",
      threadId: "thread:qa",
      senderThreadId: parentId,
      createdBy: "user",
      dispatchMode: { type: "queue_after_active" },
    });
  });

  it("keeps the team guardrails: nested threads and full teams add no new members", () => {
    const nested = planAgentMentions({
      parent: member("thread:child", "dev").thread,
      run,
      message: message("@qa"),
      profiles: [profile("qa")],
      members: [],
    });
    assert.lengthOf(nested.commands, 0);
    assert.equal(nested.skipped[0]?.profileId, "qa");

    const full = planAgentMentions({
      parent,
      run,
      message: message("@qa"),
      profiles: [profile("qa")],
      members: Array.from({ length: 6 }, (_, index) => member(`thread:m${index}`, "dev", true)),
    });
    assert.lengthOf(full.commands, 0);
    assert.lengthOf(full.skipped, 1);
  });

  it("does nothing without a known tag or a started run", () => {
    const profiles = [profile("qa")];
    for (const plan of [
      planAgentMentions({ parent, run, message: message("@nobody hi"), profiles, members: [] }),
      planAgentMentions({ parent, run, message: message("no tags"), profiles, members: [] }),
      planAgentMentions({
        parent,
        run: { ...run, rootNodeId: null },
        message: message("@qa"),
        profiles,
        members: [],
      }),
    ]) {
      assert.deepEqual(plan, { commands: [], skipped: [] });
    }
  });
});

describe("AgentMentionReactor", () => {
  const handleRun = (creationSource: string, events = 1) => {
    const dispatched: Array<unknown> = [];
    const layer = AgentMentionReactor.layer.pipe(
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          dispatch: (command) => {
            dispatched.push(command);
            return Effect.succeed({ sequence: 1 } as never);
          },
          streamDomainEvents: Stream.empty,
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () => Effect.die("no members"),
          getThreadRecords: () =>
            Effect.succeed({
              thread: parent,
              subagents: [],
              messages: [
                {
                  id: MessageId.make("message:1"),
                  role: "user",
                  createdBy: "user",
                  creationSource,
                  text: "@qa check this",
                },
              ],
            } as never),
        }),
      ),
      Layer.provide(
        ServerSettings.layerTest({ agentProfiles: [{ id: "qa", name: "QA" }] as never }),
      ),
    );
    return Effect.gen(function* () {
      const reactor = yield* AgentMentionReactor.AgentMentionReactor;
      for (let index = 0; index < events; index += 1) {
        yield* reactor.handle({
          type: "run.updated",
          threadId: parentId,
          payload: {
            id: run.id,
            status: "running",
            rootNodeId: run.rootNodeId,
            userMessageId: MessageId.make("message:1"),
          },
        } as never);
      }
      return dispatched;
    }).pipe(Effect.provide(layer));
  };

  it.effect("brings in bots a person tagged, once per run", () =>
    Effect.gen(function* () {
      const dispatched = yield* handleRun("web", 3);
      assert.lengthOf(dispatched, 1);
      assert.deepInclude(dispatched[0] as Record<string, unknown>, {
        type: "delegated_task.request",
        agentProfileId: "qa",
      });
    }),
  );

  it.effect("ignores tags in bot tasks and agent messages, so bots never fan out again", () =>
    Effect.gen(function* () {
      assert.lengthOf(yield* handleRun("server"), 0);
      assert.lengthOf(yield* handleRun("mcp"), 0);
    }),
  );
});
