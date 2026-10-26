import { AgentProfileId, DEFAULT_AGENT_PROFILES } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { resolveAgentInstructions } from "./AgentProfileInstructions.ts";

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
