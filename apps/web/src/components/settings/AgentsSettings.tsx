import { useAtomValue } from "@effect/atom-react";
import {
  type AgentProfile,
  type EnvironmentId,
  isAgentBotId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { createModelSelection } from "@t3tools/shared/model";
import {
  BotIcon,
  CopyIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentBotAvatar } from "../AgentBotAvatar";
import ChatMarkdown from "../ChatMarkdown";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import {
  type AgentBotDraft,
  EMPTY_AGENT_BOT_DRAFT,
  agentBotDraftErrors,
  agentBotDraftFromProfile,
  agentProfileFromDraft,
  duplicateAgentBotDraft,
  hasAgentBotDraftErrors,
  removeAgentProfile,
  upsertAgentProfile,
  withAgentBotName,
} from "./agentsSettings.logic";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const INHERIT = "inherit";

const INTERACTION_MODE_LABELS: Record<ProviderInteractionMode, string> = {
  default: "Build",
  plan: "Plan",
};

function reportFailure(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}

export function AgentsSettings() {
  const { environment, connectedEnvironments } = useSettingsScope();
  const environmentId = (environment ?? connectedEnvironments[0])?.environmentId;
  if (environmentId === undefined) {
    return (
      <SettingsPageContainer>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BotIcon />
            </EmptyMedia>
            <EmptyTitle>No environments available</EmptyTitle>
            <EmptyDescription>Connect an environment to manage its bots.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SettingsPageContainer>
    );
  }
  return <AgentsEnvironmentSettings key={environmentId} environmentId={environmentId} />;
}

function AgentsEnvironmentSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const profiles = useEnvironmentSettings(environmentId, (settings) => settings.agentProfiles);
  const canWrite = useAtomValue(serverEnvironment.writeAgentSoul.permissionAtom(environmentId));
  const readSoul = useAtomCommand(serverEnvironment.readAgentSoul, { reportFailure: false });
  const removeSoul = useAtomCommand(serverEnvironment.removeAgentSoul, { reportFailure: false });
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [editor, setEditor] = useState<AgentBotDraft | null>(null);

  const openWithSoul = async (
    profile: AgentProfile,
    toDraft: (soul: string | null) => AgentBotDraft,
  ) => {
    // A profile saved by hand with a non-slug id has no SOUL.md; it edits its inline rules.
    if (!isAgentBotId(profile.id)) {
      setEditor(toDraft(null));
      return;
    }
    const result = await readSoul({ environmentId, input: { id: profile.id } });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not read SOUL.md", squashAtomCommandFailure(result));
      }
      return;
    }
    setEditor(toDraft(result.value.content));
  };

  const remove = async (profile: AgentProfile) => {
    const message = `Remove ${profile.name}?\nIts SOUL.md is deleted too. Threads it already joined stay.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    const saved = await saveSettings({
      environmentId,
      input: { patch: { agentProfiles: removeAgentProfile(profiles, profile.id) } },
    });
    if (saved._tag === "Failure") {
      if (!isAtomCommandInterrupted(saved)) {
        reportFailure("Could not remove the bot", squashAtomCommandFailure(saved));
      }
      return;
    }
    if (!isAgentBotId(profile.id)) return;
    const removed = await removeSoul({ environmentId, input: { id: profile.id } });
    if (removed._tag === "Failure" && !isAtomCommandInterrupted(removed)) {
      reportFailure(
        "The bot was removed, but its SOUL.md was not",
        squashAtomCommandFailure(removed),
      );
    }
  };

  const newBotButton = (size: "xs" | "sm") => (
    <Button
      size={size}
      variant={size === "xs" ? "ghost-muted" : "default"}
      disabled={!canWrite}
      onClick={() => setEditor(EMPTY_AGENT_BOT_DRAFT)}
    >
      <PlusIcon className="size-3" />
      New bot
    </Button>
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="agent-bots"
        title="Agents"
        variant="plain"
        headerAction={profiles.length > 0 ? newBotButton("xs") : null}
      >
        {profiles.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BotIcon />
              </EmptyMedia>
              <EmptyTitle>No bots yet</EmptyTitle>
              <EmptyDescription>
                A bot is an agent with its own name, model and SOUL.md. Tag it with @handle in any
                thread and it joins the conversation, works on your message in its own thread, and
                reports back.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>{newBotButton("sm")}</EmptyContent>
          </Empty>
        ) : (
          <SettingsSection title="Bots" hideTitle>
            {profiles.map((profile) => (
              <SettingsRow
                key={profile.id}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <AgentBotAvatar profile={profile} size="md" />
                    <span className="min-w-0 truncate">{profile.name}</span>
                    <span className="truncate font-normal text-muted-foreground">
                      @{profile.id}
                    </span>
                  </span>
                }
                description={profile.role === "" ? undefined : profile.role}
                control={
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={!canWrite}
                          aria-label={`Actions for ${profile.name}`}
                        />
                      }
                    >
                      <MoreHorizontalIcon className="size-4" />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem
                        onClick={() =>
                          void openWithSoul(profile, (soul) =>
                            agentBotDraftFromProfile(profile, soul),
                          )
                        }
                      >
                        <PencilIcon />
                        Edit
                      </MenuItem>
                      <MenuItem
                        onClick={() =>
                          void openWithSoul(profile, (soul) =>
                            duplicateAgentBotDraft(profile, soul, profiles),
                          )
                        }
                      >
                        <CopyIcon />
                        Duplicate
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem onClick={() => void remove(profile)}>
                        <Trash2Icon />
                        Remove
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                }
              />
            ))}
          </SettingsSection>
        )}
      </SettingsSection>
      {editor ? (
        <AgentBotEditorDialog
          key={editor.savedId ?? "new"}
          environmentId={environmentId}
          profiles={profiles}
          initialDraft={editor}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  error,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly htmlFor?: string;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function AgentBotEditorDialog({
  environmentId,
  profiles,
  initialDraft,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly profiles: ReadonlyArray<AgentProfile>;
  readonly initialDraft: AgentBotDraft;
  readonly onClose: () => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const writeSoul = useAtomCommand(serverEnvironment.writeAgentSoul, { reportFailure: false });
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [draft, setDraft] = useState(initialDraft);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [soulView, setSoulView] = useState<"write" | "preview">("write");
  const errors = agentBotDraftErrors(draft, profiles);
  const visibleErrors = showErrors ? errors : {};

  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
  const defaultSelection =
    settings.defaultModelSelection ??
    (instanceEntries[0]
      ? createModelSelection(
          instanceEntries[0].instanceId,
          instanceEntries[0].models[0]?.slug ?? "",
        )
      : null);
  const selection = draft.modelSelection;
  const selectionEntry =
    selection === null
      ? undefined
      : instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const modelOptionsByInstance =
    selection === null
      ? new Map()
      : getCustomModelOptionsByInstance(settings, providers, selection.instanceId, selection.model);

  const save = async () => {
    if (hasAgentBotDraftErrors(errors)) {
      setShowErrors(true);
      return;
    }
    const profile = agentProfileFromDraft(draft);
    setSaving(true);
    // SOUL.md first: a bot listed in settings without its file would run on stale rules.
    const wrote = isAgentBotId(profile.id)
      ? await writeSoul({ environmentId, input: { id: profile.id, content: draft.soul } })
      : null;
    if (wrote?._tag === "Failure") {
      setSaving(false);
      if (!isAtomCommandInterrupted(wrote)) {
        reportFailure("Could not save SOUL.md", squashAtomCommandFailure(wrote));
      }
      return;
    }
    const saved = await saveSettings({
      environmentId,
      input: { patch: { agentProfiles: upsertAgentProfile(profiles, profile) } },
    });
    setSaving(false);
    if (saved._tag === "Failure") {
      if (!isAtomCommandInterrupted(saved)) {
        reportFailure("Could not save the bot", squashAtomCommandFailure(saved));
      }
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {draft.savedId === null ? "New bot" : `Edit ${initialDraft.name}`}
          </DialogTitle>
          <DialogDescription>
            Tag it with @{draft.id || "handle"} in any thread to bring it in.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="min-w-0 space-y-5">
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3">
              <Field label="Avatar" htmlFor="agent-bot-avatar">
                <Input
                  id="agent-bot-avatar"
                  value={draft.avatar}
                  maxLength={16}
                  placeholder="🤖"
                  onChange={(event) => setDraft({ ...draft, avatar: event.target.value })}
                />
              </Field>
              <Field label="Name" htmlFor="agent-bot-name" error={visibleErrors.name}>
                <Input
                  id="agent-bot-name"
                  value={draft.name}
                  maxLength={64}
                  placeholder="Reviewer"
                  autoFocus
                  onChange={(event) => setDraft(withAgentBotName(draft, event.target.value))}
                />
              </Field>
            </div>
            <Field
              label="Handle"
              hint={
                draft.savedId === null
                  ? "Lowercase letters, digits and hyphens"
                  : "Fixed once saved"
              }
              htmlFor="agent-bot-id"
              error={visibleErrors.id}
            >
              <Input
                id="agent-bot-id"
                value={draft.id}
                maxLength={64}
                placeholder="reviewer"
                disabled={draft.savedId !== null}
                onChange={(event) =>
                  setDraft({ ...draft, id: event.target.value.toLowerCase(), idEdited: true })
                }
              />
            </Field>
            <Field label="Role" hint="Optional" htmlFor="agent-bot-role">
              <Input
                id="agent-bot-role"
                value={draft.role}
                maxLength={200}
                placeholder="Reviews diffs before they merge"
                onChange={(event) => setDraft({ ...draft, role: event.target.value })}
              />
            </Field>
            <Field label="Model">
              <div className="flex flex-wrap items-center gap-2">
                <Switch
                  checked={selection !== null}
                  aria-label="Use its own model"
                  disabled={selection === null && defaultSelection === null}
                  onCheckedChange={(checked) =>
                    setDraft({ ...draft, modelSelection: checked ? defaultSelection : null })
                  }
                />
                {selection === null ? (
                  <span className="text-sm text-muted-foreground">
                    Same model as the thread that tags it
                  </span>
                ) : (
                  <>
                    <ProviderModelPicker
                      environmentId={environmentId}
                      activeInstanceId={selection.instanceId}
                      model={selection.model}
                      lockedProvider={null}
                      instanceEntries={instanceEntries}
                      modelOptionsByInstance={modelOptionsByInstance}
                      isComposerOwned={false}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      triggerAriaLabel="Bot model"
                      onInstanceModelChange={(instanceId, model) =>
                        setDraft({
                          ...draft,
                          modelSelection: createModelSelection(instanceId, model),
                        })
                      }
                    />
                    {selectionEntry ? (
                      <TraitsPicker
                        provider={selectionEntry.driverKind}
                        models={selectionEntry.models}
                        model={selection.model}
                        modelOptions={selection.options ?? []}
                        allowPromptInjectedEffort={false}
                        planModeEnabled={settings.planModeEnabled}
                        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                        onModelOptionsChange={(options) =>
                          setDraft({
                            ...draft,
                            modelSelection: createModelSelection(
                              selection.instanceId,
                              selection.model,
                              options,
                            ),
                          })
                        }
                      />
                    ) : null}
                  </>
                )}
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Access">
                <Select
                  value={draft.runtimeMode ?? INHERIT}
                  onValueChange={(value) =>
                    setDraft({
                      ...draft,
                      runtimeMode: value === INHERIT ? null : (value as RuntimeMode),
                    })
                  }
                  items={[
                    { value: INHERIT, label: "Same as the thread" },
                    ...runtimeModeOptions.map((mode) => ({
                      value: mode,
                      label: runtimeModeConfig[mode].label,
                    })),
                  ]}
                >
                  <SelectTrigger aria-label="Bot access">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={INHERIT}>Same as the thread</SelectItem>
                    {runtimeModeOptions.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {runtimeModeConfig[mode].label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Field label="Mode">
                <Select
                  value={draft.interactionMode ?? INHERIT}
                  onValueChange={(value) =>
                    setDraft({
                      ...draft,
                      interactionMode:
                        value === INHERIT ? null : (value as ProviderInteractionMode),
                    })
                  }
                  items={[
                    { value: INHERIT, label: "Same as the thread" },
                    { value: "default", label: INTERACTION_MODE_LABELS.default },
                    { value: "plan", label: INTERACTION_MODE_LABELS.plan },
                  ]}
                >
                  <SelectTrigger aria-label="Bot mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={INHERIT}>Same as the thread</SelectItem>
                    <SelectItem value="default">{INTERACTION_MODE_LABELS.default}</SelectItem>
                    <SelectItem value="plan">{INTERACTION_MODE_LABELS.plan}</SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="agent-bot-soul">SOUL.md</Label>
                <ToggleGroup
                  aria-label="SOUL.md view"
                  value={[soulView]}
                  onValueChange={(values) => {
                    const next = values[0];
                    if (next === "write" || next === "preview") setSoulView(next);
                  }}
                >
                  <Toggle value="write" size="xs">
                    Write
                  </Toggle>
                  <Toggle value="preview" size="xs">
                    Preview
                  </Toggle>
                </ToggleGroup>
              </div>
              {soulView === "write" ? (
                <Textarea
                  id="agent-bot-soul"
                  className="max-h-80 min-h-40 overflow-y-auto"
                  placeholder={
                    "# Who you are\nYou review diffs for correctness first, then readability.\n\n# How you answer\nList findings by severity, each with file and line."
                  }
                  value={draft.soul}
                  onChange={(event) => setDraft({ ...draft, soul: event.target.value })}
                />
              ) : (
                <div className="max-h-80 min-h-40 overflow-y-auto rounded-lg border px-3 py-2 text-sm">
                  {draft.soul.trim() === "" ? (
                    <p className="text-muted-foreground">Nothing to preview yet.</p>
                  ) : (
                    <ChatMarkdown text={draft.soul} cwd={undefined} />
                  )}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                The bot's persona and rules, saved as agents/{draft.id || "<handle>"}/SOUL.md in the
                T3 home folder. Edits there apply on its next turn.
              </p>
              {visibleErrors.soul ? (
                <p className="text-xs text-destructive">{visibleErrors.soul}</p>
              ) : null}
            </div>
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            {draft.savedId === null ? "Create bot" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
