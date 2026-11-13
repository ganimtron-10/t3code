import type { AgentProfile, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useThreadProjection } from "../../state/entities";
import { AgentBotAvatar } from "../AgentBotAvatar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const selectAgentProfiles = (settings: { agentProfiles: ReadonlyArray<AgentProfile> }) =>
  settings.agentProfiles;

/** The bots in this conversation: the thread's own bot and the bots tagged into it. */
export function ThreadAgentParticipants({
  threadRef,
  onOpenThread,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const profiles = useEnvironmentSettings(threadRef.environmentId, selectAgentProfiles);
  const members: Array<{ profileId: string; threadId: ThreadId }> = [];
  if (projection?.thread.agentProfileId !== undefined) {
    members.push({ profileId: projection.thread.agentProfileId, threadId: threadRef.threadId });
  }
  for (const task of projection?.subagents ?? []) {
    if (task.agentProfileId !== undefined && task.childThreadId !== null) {
      members.push({ profileId: task.agentProfileId, threadId: task.childThreadId });
    }
  }
  const participants: Array<{ profile: AgentProfile; threadId: ThreadId }> = [];
  for (const member of members) {
    const profile = profiles.find((candidate) => candidate.id === member.profileId);
    if (profile === undefined) continue;
    const existing = participants.findIndex((entry) => entry.profile.id === profile.id);
    // The newest member thread of a bot is the one a new tag reaches.
    if (existing >= 0) participants[existing] = { profile, threadId: member.threadId };
    else participants.push({ profile, threadId: member.threadId });
  }
  if (participants.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-1" aria-label="Bots in this conversation">
      {participants.map(({ profile, threadId }) => (
        <Tooltip key={profile.id}>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Open ${profile.name}'s thread`}
                disabled={threadId === threadRef.threadId}
                onClick={() => onOpenThread(threadId)}
                className="inline-flex max-w-32 cursor-pointer items-center gap-1 rounded-full py-0.5 pe-1.5 ps-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            <AgentBotAvatar profile={profile} />
            <span className="truncate">{profile.name}</span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {profile.role === "" ? `@${profile.id}` : `@${profile.id} · ${profile.role}`}
          </TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}
