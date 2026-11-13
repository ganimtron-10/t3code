import type { AgentProfile } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { agentBotAvatar } from "./settings/agentsSettings.logic";

const SIZE_CLASS_NAME = {
  xs: "size-4 text-[0.55rem]",
  sm: "size-5 text-2xs",
  md: "size-8 text-sm",
} as const;

/** A bot's emoji or initials in a round badge. */
export function AgentBotAvatar({
  profile,
  size = "sm",
  className,
}: {
  readonly profile: Pick<AgentProfile, "avatar" | "name">;
  readonly size?: keyof typeof SIZE_CLASS_NAME;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full bg-muted font-medium leading-none text-foreground",
        SIZE_CLASS_NAME[size],
        className,
      )}
    >
      {agentBotAvatar(profile)}
    </span>
  );
}
