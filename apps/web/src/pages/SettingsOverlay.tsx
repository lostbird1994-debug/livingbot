import { useLingui } from "@lingui/react/macro";
import type { Bot, SpaceMemoryConfig } from "@rakazo/contracts";
import { UPSTREAM_UPDATES_ENABLED } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApprovalRulesSettings } from "../components/ApprovalRulesSettings";
import { computersAreUnavailable } from "../components/ComputersUnavailableHint";
import { InheritanceBadge } from "../components/InheritanceBadge";
import { SETTINGS_CONTENT_WIDTH } from "../components/SettingsRows";
import { VaultSettings } from "../components/VaultSettings";
import { desktopBridge } from "../lib/desktop";
import { useSpaceQueries } from "../lib/query";
import { SpaceRpcProvider, useSpaceRpc } from "../lib/space-rpc";
import {
  ComputerSettingsPanel,
  GeneralSettingsPanels,
  UpdatesSettingsPanel,
  UsageSettingsPanel,
} from "./AccountSettingsOverlay";
import { BillingSettingsPanel } from "./BillingSettingsPanel";
import { MemorySettingsOverlay } from "./MemorySettingsOverlay";
import { MessagingSettingsPanel } from "./MessagingSettingsPanel";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";
import { PaymentWalletSettingsPanel } from "./PaymentWalletSettingsPanel";
import { SpaceSettingSection } from "./SpaceSettingSection";
import { SpaceSettingsPanel } from "./SpaceSettingsPanel";
import type { SettingsPanel } from "./settings-nav";
import {
  SETTINGS_PANEL_DEFAULT,
  settingsPanelOf,
  useSettingsNavItems,
  useSettingsPanelLabels,
} from "./settings-nav";
import type { BotSettingsPage } from "./shell/bot-panel";
import { BotSettings } from "./shell/bot-panel";
import type { SettingsSpace } from "./shell/dialogs";
import type { SettingsSection } from "./shell-overlay";
import { VoiceSettingsOverlay } from "./VoiceSettingsOverlay";

/** Which workspace or bot a panel edits, shown above its pages so the target is never implied. */
function ScopeBar({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div
      data-testid="settings-scope"
      className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-2.5 sm:px-8"
    >
      <span className="shrink-0 text-[12.5px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function WorkspaceScope({
  spaces,
  space,
  onSpaceChange,
}: {
  spaces: { id: string; name: string }[];
  space: SettingsSpace | null;
  onSpaceChange: (spaceId: string) => void;
}) {
  const { t } = useLingui();
  return (
    <ScopeBar label={t`Editing`}>
      <NativeSelect
        aria-label={t`Workspace`}
        className="max-w-64"
        value={space?.id ?? ""}
        disabled={spaces.length < 2}
        onChange={(event) => {
          if (event.target.value) onSpaceChange(event.target.value);
        }}
      >
        {spaces.length ? null : (
          <NativeSelectOption value="">{t`No workspaces yet`}</NativeSelectOption>
        )}
        {spaces.map((option) => (
          <NativeSelectOption key={option.id} value={option.id}>
            {option.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </ScopeBar>
  );
}

function BotScope({
  botId,
  onBotChange,
}: {
  botId: string | null;
  onBotChange: (botId: string) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const botsQuery = useQuery(queries.bots.list.queryOptions());
  const bots = (botsQuery.data ?? []).filter((bot) => !bot.archivedAt);
  return (
    <ScopeBar label={t`Editing`}>
      <NativeSelect
        aria-label={t`Bot`}
        className="max-w-64"
        value={botId ?? bots[0]?.id ?? ""}
        disabled={bots.length < 2}
        onChange={(event) => {
          if (event.target.value) onBotChange(event.target.value);
        }}
      >
        {bots.length ? null : (
          <NativeSelectOption value="">{t`No bots in this workspace yet`}</NativeSelectOption>
        )}
        {bots.map((bot) => (
          <NativeSelectOption key={bot.id} value={bot.id}>
            {bot.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </ScopeBar>
  );
}

/** The account's own settings: one copy every workspace starts from. */
function GlobalPages({
  section,
  email,
  name,
  onNameSaved,
  timezone,
  onTimezoneChange,
  onAccountImported,
  onImportAgent,
  billingEnabled,
  sandboxProvider,
  onSandboxProviderChange,
  messagingEnabled,
  paymentWalletProvider,
  onClose,
  onVoiceBusy,
  holdComputerRecovery,
  releaseComputerRecovery,
  showComputer,
  showUpdates,
}: {
  section: SettingsSection;
  email?: string | null;
  name: string;
  onNameSaved?: () => Promise<void>;
  timezone: string | null;
  onTimezoneChange: (timezone: string) => Promise<void>;
  onAccountImported?: () => Promise<void>;
  onImportAgent?: () => void;
  billingEnabled: boolean;
  sandboxProvider?: string | null;
  onSandboxProviderChange?: (sandboxProvider: string) => void;
  messagingEnabled: boolean;
  paymentWalletProvider: { id: string; name: string } | null;
  onClose: () => void;
  onVoiceBusy: (busy: boolean) => void;
  holdComputerRecovery: () => void;
  releaseComputerRecovery: () => void;
  showComputer: boolean;
  showUpdates: boolean;
}) {
  if (section === "general") {
    return (
      <GeneralSettingsPanels
        email={email}
        name={name}
        onNameSaved={onNameSaved}
        timezone={timezone}
        onTimezoneChange={onTimezoneChange}
        onAccountImported={onAccountImported}
        onImportAgent={onImportAgent}
      />
    );
  }
  if (section === "confirmations") return <ApprovalRulesSettings scope="account" />;
  if (section === "vault") return <VaultSettings scope="account" />;
  if (section === "messaging" && messagingEnabled) return <MessagingSettingsPanel />;
  if (section === "wallet" && paymentWalletProvider) {
    return <PaymentWalletSettingsPanel provider={paymentWalletProvider} />;
  }
  if (section === "computer" && showComputer) {
    return (
      <ComputerSettingsPanel
        sandboxProvider={sandboxProvider}
        onSandboxProviderChange={(next) => {
          onSandboxProviderChange?.(next);
          holdComputerRecovery();
        }}
        onRecoveryDismissed={releaseComputerRecovery}
      />
    );
  }
  if (section === "billing" && billingEnabled) return <BillingSettingsPanel />;
  if (section === "updates" && showUpdates) return <UpdatesSettingsPanel />;
  if (section === "models") {
    return <ModelSettingsOverlay embedded scope="account" onClose={onClose} />;
  }
  if (section === "voice") {
    return (
      <VoiceSettingsOverlay embedded scope="account" onClose={onClose} onBusyChange={onVoiceBusy} />
    );
  }
  return null;
}

/** The memory provider the bound workspace uses. */
function MemoryPage({
  onClose,
  onBusyChange,
}: {
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const queries = useSpaceQueries();
  const config = useQuery(queries.memory.providerConfig.queryOptions());
  const [local, setLocal] = useState<SpaceMemoryConfig | null | undefined>(undefined);
  const value = local !== undefined ? local : config.isError ? null : config.data;
  return (
    <MemorySettingsOverlay
      embedded
      onClose={onClose}
      config={value}
      onConfigChange={setLocal}
      onBusyChange={onBusyChange}
    />
  );
}

/** Usage for the bound workspace, read on its own so switching workspaces follows along. */
function UsagePage() {
  const queries = useSpaceQueries();
  const usage = useQuery(queries.usage.summary.queryOptions());
  const ref = useRef<HTMLDivElement>(null);
  return <UsageSettingsPanel usage={usage.data ?? null} panelRef={ref} />;
}

/** One workspace's own settings. */
function WorkspacePages({
  section,
  space,
  onRenameSpace,
  onClose,
  onBusyChange,
  onSectionChange,
}: {
  section: SettingsSection;
  space: SettingsSpace | null;
  onRenameSpace?: (spaceId: string, name: string) => Promise<void>;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onSectionChange: (section: SettingsSection) => void;
}) {
  const queries = useSpaceQueries();
  const overrides = useQuery(queries.spaceSettings.overrides.queryOptions());
  if (section === "space") {
    return space ? (
      <SpaceSettingsPanel
        key={space.id}
        space={space}
        onRename={(name) => onRenameSpace?.(space.id, name) ?? Promise.resolve()}
        onBusyChange={onBusyChange}
        onOpenSection={onSectionChange}
        overrides={overrides.data}
      />
    ) : null;
  }
  if (section === "space-models") return <SpaceSettingSection setting="models" onClose={onClose} />;
  if (section === "space-voice") {
    return <SpaceSettingSection setting="voice" onClose={onClose} onBusyChange={onBusyChange} />;
  }
  if (section === "space-confirmations") {
    return <SpaceSettingSection setting="confirmations" onClose={onClose} />;
  }
  if (section === "space-vault") {
    return <SpaceSettingSection setting="credentials" onClose={onClose} />;
  }
  if (section === "memory") return <MemoryPage onClose={onClose} onBusyChange={onBusyChange} />;
  if (section === "usage") return <UsagePage />;
  return null;
}

/** The section id a Bot page lives at. */
const BOT_PAGES: Partial<Record<SettingsSection, BotSettingsPage>> = {
  "bot-role": "role",
  "bot-model": "model",
  "bot-memory": "memory",
  "bot-voice": "voice",
  "bot-tools": "tools",
};

/** Says whether this page's setting belongs to the bot or comes from the level above it. */
function BotPageStatus({ bot, page }: { bot: Bot; page: BotSettingsPage }) {
  const { t } = useLingui();
  if (page === "model") {
    return (
      <InheritanceBadge
        own={Boolean(bot.modelProvider && bot.modelId)}
        inheritedLabel={t`Space default`}
      />
    );
  }
  if (page === "memory") {
    return <InheritanceBadge own={bot.memoryScope != null} inheritedLabel={t`Inherit default`} />;
  }
  if (page === "voice") {
    return <InheritanceBadge own={Boolean(bot.voiceId)} inheritedLabel={t`Account default`} />;
  }
  return null;
}

/** One bot's own settings, with its own bot picker so the panel never depends on the open chat. */
function BotPages({
  section,
  botId,
  onBotChange,
}: {
  section: SettingsSection;
  botId: string | null;
  onBotChange: (botId: string) => void;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const botsQuery = useQuery(queries.bots.list.queryOptions());
  const bots = (botsQuery.data ?? []).filter((bot) => !bot.archivedAt);
  const bot: Bot | undefined = bots.find((item) => item.id === botId) ?? bots[0];
  const memoryQuery = useQuery({
    ...queries.memory.providerConfig.queryOptions(),
    enabled: Boolean(bot),
  });
  const page = BOT_PAGES[section] ?? "role";
  return (
    <>
      <BotScope botId={bot?.id ?? null} onBotChange={onBotChange} />
      <div
        data-testid="settings-scroll"
        className="rk-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-8 pt-5 sm:px-8"
      >
        <div className={`space-y-4 ${SETTINGS_CONTENT_WIDTH}`}>
          {bot ? (
            <>
              <BotPageStatus bot={bot} page={page} />
              <BotSettings
                key={bot.id}
                page={page}
                bot={bot}
                memoryProviderConfigured={memoryQuery.data != null}
                onSave={async ({ computerMode, ...patch }) => {
                  if (computerMode !== undefined && computerMode !== bot.computerMode) {
                    await rpc.bots.setComputer({ botId: bot.id, mode: computerMode });
                  }
                  await rpc.bots.update({ botId: bot.id, ...patch });
                  await queryClient.invalidateQueries({ queryKey: queries.bots.list.queryKey() });
                }}
                onExport={async () => {
                  const manifest = await rpc.export.bot({ botId: bot.id });
                  const blob = new Blob([JSON.stringify(manifest, null, 2)], {
                    type: "application/json",
                  });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = `${bot.name.toLowerCase().replace(/\s+/g, "-")}-export.json`;
                  link.click();
                  URL.revokeObjectURL(url);
                }}
                // Clearing a conversation stays in the bot panel, where the confirmation lives.
                onClear={() => undefined}
              />
            </>
          ) : (
            <div className="space-y-1">
              <p className="text-sm text-foreground">{t`No bots in this workspace yet`}</p>
              <p className="text-[13px] text-muted-foreground">
                {t`Create a bot in the sidebar to configure it here.`}
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export function SettingsOverlay({
  space,
  spaces = [],
  onSpaceChange,
  onRenameSpace,
  botId = null,
  onBotChange,
  email,
  name,
  onNameSaved,
  timezone,
  onTimezoneChange,
  onAccountImported,
  onImportAgent,
  billingEnabled = false,
  sandboxProvider,
  onSandboxProviderChange,
  messagingEnabled = false,
  paymentWalletProvider = null,
  requestedSection,
  onSectionChange,
  onClose,
  onVoiceStatusMaybeChanged,
}: {
  /** The space the workspace panel edits; it need not be the selected space. */
  space?: SettingsSpace | null;
  spaces?: { id: string; name: string }[];
  onSpaceChange?: (spaceId: string) => void;
  onRenameSpace?: (spaceId: string, name: string) => Promise<void>;
  /** The bot the bot panel edits; null follows the first bot of the workspace. */
  botId?: string | null;
  onBotChange?: (botId: string) => void;
  email?: string | null;
  name: string;
  onNameSaved?: () => Promise<void>;
  timezone: string | null;
  onTimezoneChange: (timezone: string) => Promise<void>;
  onAccountImported?: () => Promise<void>;
  onImportAgent?: () => void;
  billingEnabled?: boolean;
  sandboxProvider?: string | null;
  onSandboxProviderChange?: (sandboxProvider: string) => void;
  messagingEnabled?: boolean;
  /** The wallet this deployment lets bots spend from; none hides Wallet. */
  paymentWalletProvider?: { id: string; name: string } | null;
  requestedSection: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onClose: () => void;
  onVoiceStatusMaybeChanged?: () => void | Promise<void>;
}) {
  const { t, i18n } = useLingui();
  const panelRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const [navOverflow, setNavOverflow] = useState({ previous: false, next: false });
  // Voice, memory and a workspace's own pages each hold the dialog while they save.
  const [busy, setBusy] = useState(false);
  const [keepComputerRecovery, setKeepComputerRecovery] = useState(false);
  const recoveryHoldTimer = useRef<number | undefined>(undefined);
  const showComputer = keepComputerRecovery || computersAreUnavailable(sandboxProvider);
  const showUpdates = UPSTREAM_UPDATES_ENABLED && Boolean(desktopBridge()?.update);
  const panel: SettingsPanel = settingsPanelOf(requestedSection);
  const panelLabels = useSettingsPanelLabels();
  const navItems = useSettingsNavItems(panel, {
    messaging: messagingEnabled,
    wallet: Boolean(paymentWalletProvider),
    computer: showComputer,
    billing: billingEnabled,
    updates: showUpdates,
  });
  // A section this panel does not offer (one another panel owns, or one this deployment
  // hides) opens the panel's first page rather than an empty pane.
  const section = navItems.some((item) => item.id === requestedSection)
    ? requestedSection
    : (navItems[0]?.id ?? SETTINGS_PANEL_DEFAULT[panel]);
  const panelBusy = busy;
  // Every panel acts on one target: the workspace panel binds the space it edits, the bot
  // panel binds that space's bots, and the global panel reads account-wide.
  const boundSpaceId = panel === "global" ? null : (space?.id ?? null);

  const releaseComputerRecovery = useCallback(() => {
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = undefined;
    setKeepComputerRecovery(false);
  }, []);
  const holdComputerRecovery = useCallback(() => {
    setKeepComputerRecovery(true);
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = window.setTimeout(() => {
      recoveryHoldTimer.current = undefined;
      setKeepComputerRecovery(false);
    }, 4000);
  }, []);

  useEffect(() => {
    if (section !== "computer") releaseComputerRecovery();
  }, [section, releaseComputerRecovery]);
  useEffect(() => () => window.clearTimeout(recoveryHoldTimer.current), []);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const offset = Math.abs(nav.scrollLeft);
      setNavOverflow({
        previous: offset > 1,
        next: nav.scrollWidth - nav.clientWidth - offset > 1,
      });
    };
    const revealSection = () => {
      if (nav.scrollWidth > nav.clientWidth) {
        nav.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({
          block: "nearest",
          inline: "nearest",
        });
      }
      measure();
    };
    revealSection();
    nav.addEventListener("scroll", measure);
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(revealSection);
    observer?.observe(nav);
    return () => {
      nav.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [section, panel, i18n.locale, navItems.length]);

  function scrollSections(direction: number) {
    const nav = navRef.current;
    if (!nav) return;
    const rtl = getComputedStyle(nav).direction === "rtl";
    nav.scrollBy({ left: nav.clientWidth * 0.75 * direction * (rtl ? -1 : 1), behavior: "smooth" });
  }

  const sectionTitle = navItems.find((item) => item.id === section)?.label ?? panelLabels[panel];

  async function refreshVoiceStatus() {
    await onVoiceStatusMaybeChanged?.();
  }

  // Leaving is immediate, so the URL updates in the same tick; voice readiness refreshes behind it.
  function leaveSettings(next: () => void) {
    if (panelBusy) return;
    void refreshVoiceStatus();
    next();
  }

  function requestClose() {
    leaveSettings(onClose);
  }

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (panelBusy) {
          details.cancel();
          return;
        }
        requestClose();
      }}
    >
      <DialogContent
        ref={panelRef}
        data-testid="user-settings"
        data-settings-section={section}
        data-settings-panel={panel}
        showCloseButton={false}
        initialFocus={() => panelRef.current}
        className="flex h-[min(760px,calc(100%-2rem))] max-h-[calc(100%-2rem)] w-[min(1080px,calc(100%-2rem))] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-h-[calc(100%-5rem)] sm:max-w-[1080px]"
      >
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 md:contents">
            {/* Reserve arrow space so showing controls does not change the overflow measurement. */}
            <Button
              variant="ghost"
              size="icon-sm"
              className={`shrink-0 md:hidden ${navOverflow.previous || navOverflow.next ? "" : "invisible"}`}
              aria-label={t`Previous settings sections`}
              disabled={!navOverflow.previous || panelBusy}
              onClick={() => scrollSections(-1)}
            >
              <ChevronLeft className="rtl:rotate-180" />
            </Button>
            <nav
              ref={navRef}
              data-testid="settings-nav"
              aria-label={panelLabels[panel]}
              className="flex min-w-0 flex-1 flex-row gap-1 overflow-x-auto py-3 md:w-[200px] md:shrink-0 md:flex-none md:flex-col md:overflow-y-auto md:border-e md:border-border md:px-3 md:py-4"
            >
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = item.id === section;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`settings-nav-${item.id}`}
                    aria-current={active ? "page" : undefined}
                    disabled={panelBusy}
                    onClick={() => onSectionChange(item.id)}
                    className={`flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13.5px] transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    }`}
                  >
                    <Icon className="size-4 shrink-0" strokeWidth={1.75} />
                    <span className="whitespace-nowrap">{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <Button
              variant="ghost"
              size="icon-sm"
              className={`shrink-0 md:hidden ${navOverflow.previous || navOverflow.next ? "" : "invisible"}`}
              aria-label={t`Next settings sections`}
              disabled={!navOverflow.next || panelBusy}
              onClick={() => scrollSections(1)}
            >
              <ChevronRight className="rtl:rotate-180" />
            </Button>
          </div>

          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <div
              data-testid="settings-header"
              className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 pb-4 pt-6 sm:px-8 sm:pt-7"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <DialogTitle className="min-w-0 break-words text-heading2 font-medium text-foreground">
                  {panelLabels[panel]}
                </DialogTitle>
                <p className="truncate text-[12.5px] text-muted-foreground">{sectionTitle}</p>
              </div>
              <DialogClose
                aria-label={t`Close settings`}
                disabled={panelBusy}
                render={<Button variant="ghost" size="icon-sm" />}
              >
                <XIcon />
              </DialogClose>
            </div>

            <SpaceRpcProvider spaceId={boundSpaceId}>
              {panel === "global" ? <ScopeBar label={t`Applies to every workspace`} /> : null}
              {panel === "workspace" ? (
                <WorkspaceScope
                  spaces={spaces}
                  space={space ?? null}
                  onSpaceChange={(next) => onSpaceChange?.(next)}
                />
              ) : null}
              {panel === "bot" ? (
                <BotPages
                  section={section}
                  botId={botId}
                  onBotChange={(next) => onBotChange?.(next)}
                />
              ) : (
                <div
                  key={boundSpaceId ?? panel}
                  data-testid="settings-scroll"
                  className={`min-h-0 flex-1 ${
                    section === "memory"
                      ? "flex flex-col overflow-hidden"
                      : "rk-scroll overflow-y-auto overscroll-contain px-6 pb-6 pt-6 sm:px-8 sm:pb-8"
                  }`}
                >
                  {/* Memory scrolls its own body and applies the same width there; Usage's table needs the room. */}
                  <div
                    className={
                      section === "memory" || section === "usage"
                        ? "contents"
                        : SETTINGS_CONTENT_WIDTH
                    }
                  >
                    {panel === "workspace" ? (
                      <WorkspacePages
                        section={section}
                        space={space ?? null}
                        onRenameSpace={onRenameSpace}
                        onClose={requestClose}
                        onBusyChange={setBusy}
                        onSectionChange={onSectionChange}
                      />
                    ) : (
                      <GlobalPages
                        section={section}
                        email={email}
                        name={name}
                        onNameSaved={onNameSaved}
                        timezone={timezone}
                        onTimezoneChange={onTimezoneChange}
                        onAccountImported={onAccountImported}
                        onImportAgent={onImportAgent}
                        billingEnabled={billingEnabled}
                        sandboxProvider={sandboxProvider}
                        onSandboxProviderChange={onSandboxProviderChange}
                        messagingEnabled={messagingEnabled}
                        paymentWalletProvider={paymentWalletProvider}
                        onClose={requestClose}
                        onVoiceBusy={setBusy}
                        holdComputerRecovery={holdComputerRecovery}
                        releaseComputerRecovery={releaseComputerRecovery}
                        showComputer={showComputer}
                        showUpdates={showUpdates}
                      />
                    )}
                  </div>
                </div>
              )}
            </SpaceRpcProvider>
            {section === "memory" || panel === "bot" ? null : (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-[var(--dialog)] to-transparent"
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
