import { type AgentProfile, AgentProfileId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_AGENT_BOT_DRAFT,
  agentBotAvatar,
  agentBotDraftErrors,
  agentBotDraftFromProfile,
  agentBotIdFromName,
  agentProfileFromDraft,
  duplicateAgentBotDraft,
  hasAgentBotDraftErrors,
  removeAgentProfile,
  uniqueAgentBotId,
  upsertAgentProfile,
  withAgentBotName,
} from "./agentsSettings.logic";

const reviewer: AgentProfile = {
  id: AgentProfileId.make("reviewer"),
  name: "Reviewer",
  avatar: "🔎",
  role: "Reviews diffs",
  instructions: "Inline rules.",
  modelSelection: null,
  runtimeMode: null,
  interactionMode: "plan",
};

describe("bot handles", () => {
  it("derives a slug from the name", () => {
    expect(agentBotIdFromName("Code Reviewer!")).toBe("code-reviewer");
    expect(agentBotIdFromName("  Café  QA 2 ")).toBe("cafe-qa-2");
    expect(agentBotIdFromName("🤖")).toBe("");
    expect(agentBotIdFromName(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
  });

  it("picks a free handle", () => {
    expect(uniqueAgentBotId("qa", new Set())).toBe("qa");
    expect(uniqueAgentBotId("qa", new Set(["qa", "qa-2"]))).toBe("qa-3");
    expect(uniqueAgentBotId("", new Set())).toBe("bot");
  });

  it("follows the name until the handle is edited, and never for a saved bot", () => {
    expect(withAgentBotName(EMPTY_AGENT_BOT_DRAFT, "Infra Lead").id).toBe("infra-lead");
    const edited = { ...EMPTY_AGENT_BOT_DRAFT, id: "ops", idEdited: true };
    expect(withAgentBotName(edited, "Infra Lead").id).toBe("ops");
    const saved = agentBotDraftFromProfile(reviewer, null);
    expect(withAgentBotName(saved, "Senior Reviewer").id).toBe("reviewer");
  });
});

describe("bot drafts", () => {
  it("edits SOUL.md, falling back to the inline instructions when the file is missing", () => {
    expect(agentBotDraftFromProfile(reviewer, "# Soul").soul).toBe("# Soul");
    expect(agentBotDraftFromProfile(reviewer, null).soul).toBe("Inline rules.");
  });

  it("duplicates into an unsaved bot with a free name and handle", () => {
    const copy = duplicateAgentBotDraft(reviewer, "# Soul", [
      reviewer,
      { ...reviewer, id: AgentProfileId.make("reviewer-copy") },
    ]);
    expect(copy).toMatchObject({
      savedId: null,
      name: "Reviewer copy",
      id: "reviewer-copy-2",
      soul: "# Soul",
      interactionMode: "plan",
    });
  });

  it("validates name, handle and SOUL.md size", () => {
    expect(hasAgentBotDraftErrors(agentBotDraftErrors(EMPTY_AGENT_BOT_DRAFT, []))).toBe(true);
    const draft = withAgentBotName(EMPTY_AGENT_BOT_DRAFT, "Reviewer");
    expect(agentBotDraftErrors(draft, [])).toEqual({});
    expect(agentBotDraftErrors(draft, [reviewer]).id).toBe("@reviewer is already taken.");
    expect(agentBotDraftErrors(agentBotDraftFromProfile(reviewer, null), [reviewer])).toEqual({});
    for (const id of ["../x", "Up", "a/b", "-a", "a".repeat(65)]) {
      expect(agentBotDraftErrors({ ...draft, id }, []).id, id).toBeDefined();
    }
    expect(agentBotDraftErrors({ ...draft, soul: "x".repeat(20_001) }, []).soul).toBeDefined();
  });

  it("saves metadata only, trimmed, and keeps the list order", () => {
    const profile = agentProfileFromDraft({
      ...agentBotDraftFromProfile(reviewer, "# Soul"),
      name: " Reviewer 2 ",
    });
    expect(profile).toEqual({ ...reviewer, name: "Reviewer 2", instructions: "" });
    const qa = { ...reviewer, id: AgentProfileId.make("qa") };
    expect(upsertAgentProfile([reviewer, qa], profile)).toEqual([profile, qa]);
    expect(upsertAgentProfile([qa], profile)).toEqual([qa, profile]);
    expect(removeAgentProfile([reviewer, qa], "reviewer")).toEqual([qa]);
  });

  it("shows the avatar, else the name's initials", () => {
    expect(agentBotAvatar(reviewer)).toBe("🔎");
    expect(agentBotAvatar({ avatar: "", name: "code reviewer bot" })).toBe("CR");
  });
});
