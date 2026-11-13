import type { AgentProfile } from "@t3tools/contracts";

/** The bot's SOUL.md wins over the inline instructions saved in settings. */
export function agentProfileInstructions(profile: AgentProfile, soul: string | null): string {
  const role = profile.role === "" ? "" : ` (${profile.role})`;
  return [
    `## Agent identity`,
    `You are ${profile.name}${role}.`,
    soul?.trim() ?? profile.instructions,
  ]
    .filter((line) => line !== "")
    .join("\n\n");
}
