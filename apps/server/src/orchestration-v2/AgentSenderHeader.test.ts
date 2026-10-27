import {
  AgentProfileId,
  DEFAULT_AGENT_PROFILES,
  type OrchestrationV2AppThread,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { agentSenderHeader, withAgentSenderHeader } from "./AgentSenderHeader.ts";

const thread = (id: string, profile?: string) =>
  ({
    id: ThreadId.make(id),
    title: `${id} title`,
    ...(profile === undefined ? {} : { agentProfileId: AgentProfileId.make(profile) }),
  }) as OrchestrationV2AppThread;

const qa = thread("thread:qa", "qa");
const developer = thread("thread:developer", "developer");

describe("agentSenderHeader", () => {
  it("names the sending profile and thread", () => {
    const header = agentSenderHeader({
      message: { createdBy: "agent", senderThreadId: qa.id },
      recipient: developer,
      sender: qa,
      profiles: DEFAULT_AGENT_PROFILES,
    });
    assert.equal(header, "[From QA (thread thread:qa)]");
    assert.equal(withAgentSenderHeader("Run the tests.", header), `${header}\n\nRun the tests.`);
  });

  it("falls back to the profile id, then the thread title", () => {
    const message = { createdBy: "agent" as const, senderThreadId: qa.id };
    assert.equal(
      agentSenderHeader({ message, recipient: developer, sender: qa }),
      "[From qa (thread thread:qa)]",
    );
    const plain = thread("thread:qa");
    assert.equal(
      agentSenderHeader({ message, recipient: developer, sender: plain }),
      '[From "thread:qa title" (thread thread:qa)]',
    );
  });

  it("adds nothing for users, self-sends or threads without a profile", () => {
    const base = { recipient: developer, sender: qa };
    assert.isUndefined(
      agentSenderHeader({ ...base, message: { createdBy: "user", senderThreadId: qa.id } }),
    );
    assert.isUndefined(
      agentSenderHeader({
        message: { createdBy: "agent", senderThreadId: developer.id },
        recipient: developer,
        sender: developer,
      }),
    );
    const plainSender = thread("thread:a");
    assert.isUndefined(
      agentSenderHeader({
        message: { createdBy: "agent", senderThreadId: plainSender.id },
        recipient: thread("thread:b"),
        sender: plainSender,
      }),
    );
    assert.equal(withAgentSenderHeader("text", undefined), "text");
  });
});
