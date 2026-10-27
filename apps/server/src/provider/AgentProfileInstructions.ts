import { type AgentProfile, type AgentProfileId, findAgentProfile } from "@t3tools/contracts";

function buildAgentProfileInstructions(profile: AgentProfile): string {
  const role = profile.role === "" ? "" : ` (${profile.role})`;
  return [`## Agent identity`, `You are ${profile.name}${role}.`, profile.instructions]
    .filter((line) => line !== "")
    .join("\n\n");
}

/** Undefined when the thread has no profile or its profile was deleted, so it runs as before. */
export function resolveAgentInstructions(
  profiles: ReadonlyArray<AgentProfile>,
  agentProfileId: AgentProfileId | undefined,
): string | undefined {
  const profile = findAgentProfile(profiles, agentProfileId);
  return profile === undefined ? undefined : buildAgentProfileInstructions(profile);
}
