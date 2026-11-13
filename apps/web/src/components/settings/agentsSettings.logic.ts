import {
  AGENT_BOT_ID_MAX_LENGTH,
  AGENT_SOUL_MAX_LENGTH,
  type AgentProfile,
  AgentProfileId,
  isAgentBotId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";

export interface AgentBotDraft {
  /** The id a saved bot already has; null while creating one. */
  readonly savedId: string | null;
  readonly id: string;
  /** Once the user types a handle, renaming the bot stops rewriting it. */
  readonly idEdited: boolean;
  readonly name: string;
  readonly avatar: string;
  readonly role: string;
  readonly soul: string;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode | null;
  readonly interactionMode: ProviderInteractionMode | null;
}

export interface AgentBotDraftErrors {
  readonly name?: string;
  readonly id?: string;
  readonly soul?: string;
}

/** "Code Reviewer!" becomes "code-reviewer", the handle used after @. */
export function agentBotIdFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, AGENT_BOT_ID_MAX_LENGTH)
    .replace(/-+$/g, "");
}

export function uniqueAgentBotId(base: string, taken: ReadonlySet<string>): string {
  const root = base === "" ? "bot" : base;
  if (!taken.has(root)) return root;
  for (let index = 2; ; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${root.slice(0, AGENT_BOT_ID_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export const EMPTY_AGENT_BOT_DRAFT: AgentBotDraft = {
  savedId: null,
  id: "",
  idEdited: false,
  name: "",
  avatar: "",
  role: "",
  soul: "",
  modelSelection: null,
  runtimeMode: null,
  interactionMode: null,
};

/** A saved bot without a SOUL.md yet edits its inline instructions as the file's first text. */
export function agentBotDraftFromProfile(
  profile: AgentProfile,
  soul: string | null,
): AgentBotDraft {
  return {
    savedId: profile.id,
    id: profile.id,
    idEdited: true,
    name: profile.name,
    avatar: profile.avatar,
    role: profile.role,
    soul: soul ?? profile.instructions,
    modelSelection: profile.modelSelection,
    runtimeMode: profile.runtimeMode,
    interactionMode: profile.interactionMode,
  };
}

/** A copy is a new, unsaved bot with a free name and handle. */
export function duplicateAgentBotDraft(
  profile: AgentProfile,
  soul: string | null,
  profiles: ReadonlyArray<AgentProfile>,
): AgentBotDraft {
  const name = `${profile.name} copy`.slice(0, 64);
  return {
    ...agentBotDraftFromProfile(profile, soul),
    savedId: null,
    name,
    id: uniqueAgentBotId(agentBotIdFromName(name), new Set(profiles.map((entry) => entry.id))),
    idEdited: false,
  };
}

export function withAgentBotName(draft: AgentBotDraft, name: string): AgentBotDraft {
  return draft.idEdited || draft.savedId !== null
    ? { ...draft, name }
    : { ...draft, name, id: agentBotIdFromName(name) };
}

export function agentBotDraftErrors(
  draft: AgentBotDraft,
  profiles: ReadonlyArray<AgentProfile>,
): AgentBotDraftErrors {
  const name = draft.name.trim();
  const id = draft.id.trim();
  return {
    ...(name === ""
      ? { name: "Give the bot a name." }
      : name.length > 64
        ? { name: "Use at most 64 characters." }
        : {}),
    ...(!isAgentBotId(id)
      ? {
          id: "Use lowercase letters, digits and single hyphens, starting and ending with a letter or digit.",
        }
      : draft.savedId === null && profiles.some((profile) => profile.id === id)
        ? { id: `@${id} is already taken.` }
        : {}),
    ...(draft.soul.length > AGENT_SOUL_MAX_LENGTH
      ? { soul: `Keep SOUL.md under ${AGENT_SOUL_MAX_LENGTH.toLocaleString()} characters.` }
      : {}),
  };
}

export function hasAgentBotDraftErrors(errors: AgentBotDraftErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** The settings entry keeps metadata only; the persona lives in SOUL.md. */
export function agentProfileFromDraft(draft: AgentBotDraft): AgentProfile {
  return {
    id: AgentProfileId.make(draft.id.trim()),
    name: draft.name.trim(),
    avatar: draft.avatar.trim(),
    role: draft.role.trim(),
    instructions: "",
    modelSelection: draft.modelSelection,
    runtimeMode: draft.runtimeMode,
    interactionMode: draft.interactionMode,
  };
}

/** Replaces the bot with the same id in place, or appends a new one. */
export function upsertAgentProfile(
  profiles: ReadonlyArray<AgentProfile>,
  profile: AgentProfile,
): ReadonlyArray<AgentProfile> {
  return profiles.some((entry) => entry.id === profile.id)
    ? profiles.map((entry) => (entry.id === profile.id ? profile : entry))
    : [...profiles, profile];
}

export function removeAgentProfile(
  profiles: ReadonlyArray<AgentProfile>,
  id: string,
): ReadonlyArray<AgentProfile> {
  return profiles.filter((entry) => entry.id !== id);
}

/** An emoji or initials; falls back to the name's initials. */
export function agentBotAvatar(profile: Pick<AgentProfile, "avatar" | "name">): string {
  if (profile.avatar !== "") return profile.avatar;
  const initials = profile.name
    .split(/\s+/)
    .filter((word) => word !== "")
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
  return initials === "" ? "?" : initials;
}
