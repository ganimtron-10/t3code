import {
  AgentProfileId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  areTeamSiblings,
  countPairMessages,
  pairCapRejection,
  TEAM_MAX_MEMBERS,
  TEAM_PAIR_MESSAGE_CAP,
  teamDelegationRejection,
} from "./AgentTeams.ts";

const now = DateTime.makeUnsafe("2026-10-27T00:00:00.000Z");
const chiefId = ThreadId.make("thread:chief");

function thread(
  id: string,
  options: { readonly parent?: ThreadId; readonly profile?: string } = {},
): OrchestrationV2AppThread {
  const threadId = ThreadId.make(id);
  return {
    createdBy: "agent",
    creationSource: "mcp",
    id: threadId,
    projectId: ProjectId.make("project:team"),
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...(options.profile === undefined
      ? {}
      : { agentProfileId: AgentProfileId.make(options.profile) }),
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: options.parent ?? null,
      relationshipToParent: options.parent === undefined ? null : "subagent",
      rootThreadId: options.parent === undefined ? threadId : chiefId,
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function message(
  from: OrchestrationV2AppThread,
  to: OrchestrationV2AppThread,
  index: number,
  creationSource: "mcp" | "server" = "mcp",
): OrchestrationV2ConversationMessage {
  return {
    createdBy: "agent",
    creationSource,
    senderThreadId: from.id,
    id: MessageId.make(`message:${from.id}:${to.id}:${index}`),
    threadId: to.id,
    runId: null,
    nodeId: null,
    role: "user",
    text: "hi",
    attachments: [],
    createdAt: now,
    updatedAt: now,
  } as unknown as OrchestrationV2ConversationMessage;
}

const chief = thread("thread:chief", { profile: "chief" });
const developer = thread("thread:developer", { parent: chiefId, profile: "developer" });
const qa = thread("thread:qa", { parent: chiefId, profile: "qa" });

describe("areTeamSiblings", () => {
  it("pairs profiled members of one team, but not a member with its Chief", () => {
    assert.isTrue(areTeamSiblings(developer, qa));
    assert.isFalse(areTeamSiblings(developer, chief));
    assert.isFalse(areTeamSiblings(developer, developer));
  });

  it("leaves threads without a profile and other teams alone", () => {
    assert.isFalse(areTeamSiblings(thread("thread:plain", { parent: chiefId }), qa));
    const otherTeam = { ...qa, lineage: { ...qa.lineage, rootThreadId: ThreadId.make("x") } };
    assert.isFalse(areTeamSiblings(developer, otherTeam));
  });
});

describe("pairCapRejection", () => {
  const exchange = (count: number) => ({
    developer: {
      thread: developer,
      messages: Array.from({ length: count }, (_, i) => message(qa, developer, i)),
    },
    qa: { thread: qa, messages: [] as Array<OrchestrationV2ConversationMessage> },
  });

  it("counts MCP messages both ways and ignores server replies", () => {
    const pair = exchange(3);
    pair.qa.messages = [message(developer, qa, 0), message(developer, qa, 1, "server")];
    assert.equal(countPairMessages(pair.developer, pair.qa), 4);
  });

  it("allows messages up to the cap, then points the member at the Chief", () => {
    const below = exchange(TEAM_PAIR_MESSAGE_CAP - 1);
    assert.isUndefined(pairCapRejection(below.qa, below.developer));
    const at = exchange(TEAM_PAIR_MESSAGE_CAP);
    assert.include(pairCapRejection(at.qa, at.developer), `Chief (thread ${chiefId})`);
  });

  it("never caps a member talking to its Chief", () => {
    const messages = Array.from({ length: 20 }, (_, i) => message(developer, chief, i));
    assert.isUndefined(
      pairCapRejection({ thread: developer, messages: [] }, { thread: chief, messages }),
    );
  });
});

describe("teamDelegationRejection", () => {
  it("lets a Chief add members up to the limit", () => {
    assert.isUndefined(teamDelegationRejection(chief, TEAM_MAX_MEMBERS - 1));
    assert.include(teamDelegationRejection(chief, TEAM_MAX_MEMBERS), "active members");
  });

  it("stops any delegated thread, profiled or not, from starting a team", () => {
    assert.include(teamDelegationRejection(developer, 0), "Only a top-level thread");
    assert.include(
      teamDelegationRejection(thread("thread:helper", { parent: chiefId }), 0),
      "Only a top-level thread",
    );
  });
});
