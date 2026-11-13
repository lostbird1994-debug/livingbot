import { Trans, useLingui } from "@lingui/react/macro";
import type { SpaceSetting } from "@livingbot/contracts";
import { Button, Input } from "@livingbot/ui-web";
import { useEffect, useId, useState } from "react";
import { InheritanceBadge } from "../components/InheritanceBadge";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";
import type { SettingsSpace } from "./shell/dialogs";
import type { SettingsSection } from "./shell-overlay";

/** The settings a workspace may keep its own copy of, and the page each one lives on. */
const OWNED: ReadonlyArray<{ setting: SpaceSetting; section: SettingsSection }> = [
  { setting: "models", section: "space-models" },
  { setting: "voice", section: "space-voice" },
  { setting: "confirmations", section: "space-confirmations" },
  { setting: "credentials", section: "space-vault" },
];

/** One space's overview: its name and which settings it owns. Deleting stays in the sidebar menu. */
export function SpaceSettingsPanel({
  space,
  onRename,
  onBusyChange,
  onOpenSection,
  overrides,
}: {
  space: SettingsSpace;
  onRename: (name: string) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  onOpenSection?: (section: SettingsSection) => void;
  /** The settings this workspace keeps its own copy of; undefined hides the summary. */
  overrides?: readonly string[];
}) {
  const { t } = useLingui();
  const nameId = useId();
  const [draft, setDraft] = useState(space.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onBusyChange?.(pending);
  }, [pending, onBusyChange]);

  async function save() {
    const trimmed = draft.trim();
    if (pending) return;
    // An empty or unchanged name keeps the current one without a request.
    if (!trimmed || trimmed === space.name) {
      setDraft(space.name);
      setError(null);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onRename(trimmed);
      setDraft(trimmed);
    } catch (err) {
      setError(
        err instanceof Error && err.message.trim() ? err.message : t`Could not rename space`,
      );
    } finally {
      setPending(false);
    }
  }

  const labels: Record<SpaceSetting, string> = {
    models: t`Models`,
    voice: t`Voice`,
    confirmations: t`Approvals`,
    credentials: t`Vault`,
  };

  return (
    <div className="space-y-8" data-testid="space-settings">
      {space.canRename ? (
        <SettingsGroup>
          <SettingsRow
            label={
              <label htmlFor={nameId}>
                <Trans>Name</Trans>
              </label>
            }
            control={
              <Input
                id={nameId}
                className="w-56"
                maxLength={60}
                value={draft}
                disabled={pending}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError(null);
                }}
                onBlur={() => void save()}
                onKeyDown={(event) => {
                  if (event.key === "Escape") event.stopPropagation();
                  // Enter or Escape that ends an IME composition is not a commit or cancel.
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    setDraft(space.name);
                    setError(null);
                  }
                }}
              />
            }
          >
            {error ? (
              <p role="alert" className="pt-2 text-[12.5px] text-destructive">
                {error}
              </p>
            ) : null}
          </SettingsRow>
        </SettingsGroup>
      ) : null}
      {overrides ? (
        <section data-testid="space-settings-overrides" className="space-y-2">
          <h3 className="px-1 text-[14px] font-medium text-foreground">
            <Trans>This workspace's own settings</Trans>
          </h3>
          <div className="divide-y divide-border rounded-xl border border-border">
            {OWNED.map((item) => {
              const own = overrides.includes(item.setting);
              return (
                <div
                  key={item.setting}
                  data-testid={`space-override-${item.setting}`}
                  className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2 text-[14px] text-foreground">
                    <span>{labels[item.setting]}</span>
                    <InheritanceBadge
                      own={own}
                      ownLabel={t`Customized`}
                      inheritedLabel={t`Following the global default`}
                    />
                  </div>
                  {onOpenSection ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="rounded-full"
                      aria-label={t`Open`}
                      onClick={() => onOpenSection(item.section)}
                    >
                      <Trans>Open</Trans>
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
