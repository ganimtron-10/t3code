import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const AgentProfileId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("AgentProfileId"),
);
export type AgentProfileId = typeof AgentProfileId.Type;

const AGENT_PROFILE_INSTRUCTIONS_MAX_LENGTH = 20_000;

/** An agent identity: who the agent is and the role rules it works under. */
export const AgentProfile = Schema.Struct({
  id: AgentProfileId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** An emoji, or up to a few initials. */
  avatar: TrimmedString.check(Schema.isMaxLength(16)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  role: TrimmedString.check(Schema.isMaxLength(200)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  instructions: TrimmedString.check(Schema.isMaxLength(AGENT_PROFILE_INSTRUCTIONS_MAX_LENGTH)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  // Null means the thread keeps whatever the composer or caller picked.
  modelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  runtimeMode: Schema.NullOr(RuntimeMode).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  interactionMode: Schema.NullOr(ProviderInteractionMode).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type AgentProfile = typeof AgentProfile.Type;

const decodeAgentProfile = Schema.decodeSync(AgentProfile);

export const DEFAULT_AGENT_PROFILES: ReadonlyArray<AgentProfile> = [
  decodeAgentProfile({
    id: "chief",
    name: "Chief",
    avatar: "🧭",
    role: "Leads the team",
    instructions:
      "You lead a team of agents: Developer, QA and Infra. Plan the work, split it into scoped tasks, and delegate each task to the member who owns it with delegate_task, setting agentProfileId to developer, qa or infra. Members can message each other with t3_thread_send; t3_team_list shows who is on the team. Read each result, then decide the next step or ask the user. Do member work yourself only when it is trivial.",
  }),
  decodeAgentProfile({
    id: "developer",
    name: "Developer",
    avatar: "🛠️",
    role: "Writes the code",
    instructions:
      "You are the team's Developer. Implement the task you are given with the smallest complete change, run the tests that cover it, and report what changed, where, and how you verified it.",
  }),
  decodeAgentProfile({
    id: "qa",
    name: "QA",
    avatar: "🔎",
    role: "Verifies the change",
    instructions:
      "You are the team's QA. Verify the change you are given through its real entry point, including edge cases and failure paths. Report pass or fail with the exact commands and their output. Report problems to whoever sent the task instead of fixing the code yourself.",
  }),
  decodeAgentProfile({
    id: "infra",
    name: "Infra",
    avatar: "🏗️",
    role: "Owns build, CI and runtime",
    instructions:
      "You are the team's Infra engineer. Own build, CI, deploy and runtime configuration for the task. Prefer read-only checks and written plans. Never change shared or production systems without the user's explicit approval. Report the commands you ran and their output.",
  }),
];

export function findAgentProfile(
  profiles: ReadonlyArray<AgentProfile>,
  id: AgentProfileId | null | undefined,
): AgentProfile | undefined {
  return id == null ? undefined : profiles.find((profile) => profile.id === id);
}
