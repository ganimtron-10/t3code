import { type AgentProfile } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { agentProfileInstructions } from "./AgentProfileInstructions.ts";
import { splitCodexAdditionalContextValue } from "./CodexDeveloperInstructions.ts";

const qa = {
  id: "qa",
  name: "QA",
  avatar: "",
  role: "Verifies the change",
  instructions: "Test through the real entry point.",
  modelSelection: null,
  runtimeMode: null,
  interactionMode: null,
} as unknown as AgentProfile;

describe("agentProfileInstructions", () => {
  it("renders the profile's identity, role and inline rules when there is no SOUL.md", () => {
    assert.equal(
      agentProfileInstructions(qa, null),
      "## Agent identity\n\nYou are QA (Verifies the change).\n\nTest through the real entry point.",
    );
  });

  it("uses SOUL.md over the inline rules, and omits an empty role", () => {
    assert.equal(
      agentProfileInstructions({ ...qa, role: "" }, "  Be terse.\n"),
      "## Agent identity\n\nYou are QA.\n\nBe terse.",
    );
    assert.equal(
      agentProfileInstructions({ ...qa, role: "", instructions: "" }, null),
      "## Agent identity\n\nYou are QA.",
    );
  });
});

describe("splitCodexAdditionalContextValue", () => {
  const bytes = (text: string) => new TextEncoder().encode(text).length;

  it("keeps short text whole and returns nothing for empty text", () => {
    assert.deepEqual(splitCodexAdditionalContextValue("a\n\nb", 10), ["a\n\nb"]);
    assert.deepEqual(splitCodexAdditionalContextValue("", 10), []);
    assert.deepEqual(splitCodexAdditionalContextValue("x".repeat(10), 10), ["x".repeat(10)]);
  });

  it("breaks at paragraphs first and hard-splits only an oversized paragraph", () => {
    assert.deepEqual(splitCodexAdditionalContextValue("aaaa\n\nbbbb\n\ncc", 10), [
      "aaaa\n\nbbbb",
      "cc",
    ]);
    const pieces = splitCodexAdditionalContextValue(`ok\n\n${"é".repeat(12)}`, 10);
    assert.deepEqual(pieces, ["ok", "é".repeat(5), "é".repeat(5), "é".repeat(2)]);
    for (const piece of pieces) assert.isAtMost(bytes(piece), 10);
  });
});
