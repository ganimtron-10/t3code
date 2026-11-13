import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { type AgentProfile, AgentBotId, isAgentBotId, parseAgentMentions } from "./agentProfile.ts";

const isAgentBotIdSchema = Schema.is(AgentBotId);
const profile = (id: string) => ({ id, name: id }) as unknown as AgentProfile;

describe("isAgentBotId", () => {
  it.each([
    ["reviewer", true],
    ["code-reviewer-2", true],
    ["a".repeat(64), true],
    ["a".repeat(65), false],
    ["", false],
    ["-reviewer", false],
    ["reviewer-", false],
    ["Reviewer", false],
    ["../etc", false],
    ["a/b", false],
    ["a.b", false],
    ["a b", false],
  ])("%s -> %s", (value, valid) => {
    expect(isAgentBotId(value)).toBe(valid);
    expect(isAgentBotIdSchema(value)).toBe(valid);
  });
});

describe("parseAgentMentions", () => {
  const reviewer = profile("reviewer");
  const qa = profile("qa");
  const profiles = [reviewer, qa];

  it("finds each tagged bot once, in mention order", () => {
    expect(parseAgentMentions("@qa and @reviewer, then @qa again", profiles)).toEqual([
      qa,
      reviewer,
    ]);
    expect(parseAgentMentions("(@reviewer) check this.", profiles)).toEqual([reviewer]);
    expect(parseAgentMentions("ping @qa.", profiles)).toEqual([qa]);
  });

  it("ignores unknown handles, emails, paths and partial words", () => {
    expect(parseAgentMentions("@nobody please", profiles)).toEqual([]);
    expect(parseAgentMentions("mail me@qa now", profiles)).toEqual([]);
    expect(parseAgentMentions("open @qa.md and @qa/notes", profiles)).toEqual([]);
    expect(parseAgentMentions("@reviewers look", profiles)).toEqual([]);
    expect(parseAgentMentions("@qa", [])).toEqual([]);
  });
});
