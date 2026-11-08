import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";
import type { SettingsSpace } from "./shell/dialogs";

/** One space's overview: its name. Deleting a space stays in the sidebar's own menu. */
export function SpaceSettingsPanel({
  space,
  onRename,
  onBusyChange,
}: {
  space: SettingsSpace;
  onRename: (name: string) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
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
    </div>
  );
}
