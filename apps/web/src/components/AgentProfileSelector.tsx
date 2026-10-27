import type { AgentProfile, AgentProfileId } from "@t3tools/contracts";
import { UserRoundIcon } from "lucide-react";
import { memo } from "react";

import { ComposerSelectControl } from "./chat/ComposerControl";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { ComposerContextLabel } from "./ComposerContextLabel";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";

const NO_PROFILE = "";

interface AgentProfileSelectorProps {
  profiles: ReadonlyArray<AgentProfile>;
  value: AgentProfileId | null;
  onChange: (profile: AgentProfile | null) => void;
}

/** Picks the identity a new chat starts with. Only shown before the thread exists. */
export const AgentProfileSelector = memo(function AgentProfileSelector({
  profiles,
  value,
  onChange,
}: AgentProfileSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const items = [
    { value: NO_PROFILE, label: "No agent" },
    ...profiles.map((profile) => ({
      value: profile.id,
      label: profile.avatar === "" ? profile.name : `${profile.avatar} ${profile.name}`,
    })),
  ];
  return (
    <Select
      modal={false}
      value={value ?? NO_PROFILE}
      onValueChange={(next: string | null) =>
        onChange(profiles.find((profile) => profile.id === next) ?? null)
      }
      items={items}
    >
      <ComposerSelectControl
        size="xs"
        className="min-w-0 shrink"
        aria-label="Agent"
        data-composer-context-control
      >
        {value === null ? <UserRoundIcon className="size-3" /> : null}
        <ComposerContextLabel>
          <SelectValue />
        </ComposerContextLabel>
      </ComposerSelectControl>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>Agent</SelectGroupLabel>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
