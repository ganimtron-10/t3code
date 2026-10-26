import { AgentProfileId, DEFAULT_AGENT_PROFILES } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { resolveAgentInstructions } from "./AgentProfileInstructions.ts";
import { splitCodexAdditionalContextValue } from "./CodexDeveloperInstructions.ts";

describe("resolveAgentInstructions", () => {
  it("renders the profile's identity, role and rules", () => {
    const text = resolveAgentInstructions(DEFAULT_AGENT_PROFILES, AgentProfileId.make("qa"));
    assert.isDefined(text);
    assert.match(text!, /^## Agent identity\n\nYou are QA \(Verifies the change\)\.\n\n/);
    assert.include(text!, "real entry point");
  });

  it("returns nothing for threads without a profile or with a deleted one", () => {
    assert.isUndefined(resolveAgentInstructions(DEFAULT_AGENT_PROFILES, undefined));
    assert.isUndefined(
      resolveAgentInstructions(DEFAULT_AGENT_PROFILES, AgentProfileId.make("deleted")),
    );
  });

  it("omits an empty role", () => {
    const text = resolveAgentInstructions(
      [{ ...DEFAULT_AGENT_PROFILES[0]!, role: "", instructions: "" }],
      AgentProfileId.make("chief"),
    );
    assert.equal(text, "## Agent identity\n\nYou are Chief.");
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
