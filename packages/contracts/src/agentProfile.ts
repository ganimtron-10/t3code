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

/** No bots ship by default; users create their own in Settings > Agents. */
export const DEFAULT_AGENT_PROFILES: ReadonlyArray<AgentProfile> = [];

/** A bot id is its @handle and its folder name under `<T3 home>/agents`. */
export const AGENT_BOT_ID_MAX_LENGTH = 64;
const AGENT_BOT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isAgentBotId(value: string): boolean {
  return value.length <= AGENT_BOT_ID_MAX_LENGTH && AGENT_BOT_ID_PATTERN.test(value);
}

export const AgentBotId = Schema.String.check(
  Schema.isMaxLength(AGENT_BOT_ID_MAX_LENGTH),
  Schema.isPattern(AGENT_BOT_ID_PATTERN),
);

export const AGENT_SOUL_MAX_LENGTH = AGENT_PROFILE_INSTRUCTIONS_MAX_LENGTH;

export const AgentSoulTarget = Schema.Struct({ id: AgentBotId });
export const AgentSoulReadResult = Schema.Struct({ content: Schema.NullOr(Schema.String) });
export const AgentSoulWriteInput = Schema.Struct({
  id: AgentBotId,
  content: Schema.String.check(Schema.isMaxLength(AGENT_SOUL_MAX_LENGTH)),
});

export class AgentSoulError extends Schema.TaggedError<AgentSoulError>()("AgentSoulError", {
  id: Schema.String,
  operation: Schema.Literals(["read", "write", "remove"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Could not ${this.operation} SOUL.md for bot "${this.id}".`;
  }
}

const AGENT_MENTION_REGEX =
  /(?:^|[\s(])@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?=$|\s|[.,;:!?)](?:\s|$))/g;

/** Profiles a message tags with `@<id>`, in first-mention order, each once. */
export function parseAgentMentions(
  text: string,
  profiles: ReadonlyArray<AgentProfile>,
): ReadonlyArray<AgentProfile> {
  if (profiles.length === 0 || !text.includes("@")) return [];
  const mentioned: Array<AgentProfile> = [];
  for (const match of text.matchAll(AGENT_MENTION_REGEX)) {
    const profile = profiles.find((candidate) => candidate.id === match[1]);
    if (profile !== undefined && !mentioned.includes(profile)) mentioned.push(profile);
  }
  return mentioned;
}

export function findAgentProfile(
  profiles: ReadonlyArray<AgentProfile>,
  id: AgentProfileId | null | undefined,
): AgentProfile | undefined {
  return id == null ? undefined : profiles.find((profile) => profile.id === id);
}
