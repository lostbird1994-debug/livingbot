import { useLingui } from "@lingui/react/macro";
import type { SpaceSetting } from "@rakazo/contracts";
import { writeSaved } from "@rakazo/core/query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "@rakazo/ui-web";
import type { QueryKey } from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";
import { ApprovalRulesSettings } from "../components/ApprovalRulesSettings";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";
import { VaultSettings } from "../components/VaultSettings";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";
import { VoiceSettingsOverlay } from "./VoiceSettingsOverlay";

/**
 * One account setting the bound Space may keep its own copy of. Until it is customized the
 * Space follows the account's; afterwards this page edits the Space's copy alone.
 */
export function SpaceSettingSection({
  setting,
  onClose,
  onBusyChange,
}: {
  setting: SpaceSetting;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const overrides = useQuery(queries.spaceSettings.overrides.queryOptions());
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  // A credential still saving would land in the vault a reset is deleting.
  const [vaultBusy, setVaultBusy] = useState(false);

  const panels: Record<SpaceSetting, () => ReactNode> = {
    models: () => <ModelSettingsOverlay embedded scope="space" onClose={onClose} />,
    voice: () => (
      <VoiceSettingsOverlay embedded scope="space" onClose={onClose} onBusyChange={onBusyChange} />
    ),
    confirmations: () => <ApprovalRulesSettings scope="space" />,
    credentials: () => <VaultSettings scope="space" onBusyChange={setVaultBusy} />,
  };

  async function setOverride(enabled: boolean) {
    if (pending) return;
    setPending(true);
    setActionError(null);
    try {
      const next = await rpc.spaceSettings.setOverride({ setting, enabled });
      await writeSaved(queryClient, queries.spaceSettings.overrides.queryKey(), () => next);
      // Reads that omit a scope get whichever copy applies, so they change with the override.
      const affected: Record<SpaceSetting, QueryKey[]> = {
        models: [queries.models.key(), queries.me.key()],
        voice: [queries.voice.key()],
        confirmations: [queries.approvalRules.key(), queries.autoReview.key()],
        credentials: [queries.vault.key()],
      };
      for (const queryKey of affected[setting]) void queryClient.invalidateQueries({ queryKey });
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setPending(false);
    }
  }

  if (overrides.data === undefined) {
    return overrides.isError ? (
      <div role="alert" className="text-[12.5px] text-destructive">
        {errorText(overrides.error)}
        <Button variant="ghost" size="sm" onClick={() => void overrides.refetch()}>
          {t`Retry`}
        </Button>
      </div>
    ) : null;
  }

  const custom = overrides.data.includes(setting);

  return (
    <div className="space-y-3" data-testid={`space-setting-section-${setting}`}>
      <SettingsGroup>
        <SettingsRow
          label={
            <>
              <p>{custom ? t`Only this workspace` : t`Following the global default`}</p>
              <p className="text-[13px] text-muted-foreground">
                {custom
                  ? t`This workspace keeps its own copy; the global one is untouched.`
                  : t`Customize to give this workspace its own copy.`}
              </p>
            </>
          }
          control={
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full"
              aria-label={custom ? t`Use defaults` : t`Customize`}
              disabled={pending || vaultBusy}
              onClick={() => {
                if (custom && setting === "credentials") setConfirmingReset(true);
                else void setOverride(!custom);
              }}
            >
              {custom ? t`Use default` : t`Customize`}
            </Button>
          }
        />
      </SettingsGroup>
      {custom ? (
        <div data-testid={`space-setting-panel-${setting}`}>{panels[setting]()}</div>
      ) : null}
      {actionError ? (
        <p role="alert" className="text-[12.5px] text-destructive">
          {actionError}
        </p>
      ) : null}
      {confirmingReset ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !pending) setConfirmingReset(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t`Delete this workspace's credentials?`}</AlertDialogTitle>
              <AlertDialogDescription>{t`This can't be undone.`}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>{t`Cancel`}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={pending}
                onClick={() =>
                  void setOverride(false).then(() => setConfirmingReset(false))
                }
              >
                {t`Delete`}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
