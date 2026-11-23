import { useLingui } from "@lingui/react/macro";
import type { Bot, SpaceMemoryConfig } from "@livingbot/contracts";
import { UPSTREAM_UPDATES_ENABLED } from "@livingbot/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@livingbot/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApprovalRulesSettings } from "../components/ApprovalRulesSettings";
import { computersAreUnavailable } from "../components/ComputersUnavailableHint";
import { InheritanceBadge } from "../components/InheritanceBadge";
import { SETTINGS_CONTENT_WIDTH, SettingsGroup, SettingsRow } from "../components/SettingsRows";
import { VaultSettings } from "../components/VaultSettings";
import { desktopBridge } from "../lib/desktop";
import { localConnected } from "../lib/local-workbench";
import { thinkingLevelLabel } from "../lib/model-catalog";
import { useSpaceQueries } from "../lib/query";
import { SpaceRpcProvider, useSpaceRpc } from "../lib/space-rpc";
import {
  ComputerSettingsPanel,
  GeneralSettingsPanels,
  UpdatesSettingsPanel,
  UsageSettingsPanel,
} from "./AccountSettingsOverlay";
import { BillingSettingsPanel } from "./BillingSettingsPanel";
import { LocalKnowledgeSettings } from "./LocalKnowledgeSettings";
import { MemorySettingsOverlay } from "./MemorySettingsOverlay";
import { MessagingSettingsPanel } from "./MessagingSettingsPanel";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";
import { NativeAdvancedSettings, NativeMemorySettings } from "./NativeSystemSettings";
import { PaymentWalletSettingsPanel } from "./PaymentWalletSettingsPanel";
import { SpaceSettingSection } from "./SpaceSettingSection";
import { SpaceSettingsPanel } from "./SpaceSettingsPanel";
import type { SettingsPanel } from "./settings-nav";
import { settingsPanelOf, useSettingsNavItems, useSettingsPanelLabels } from "./settings-nav";
import type { BotSettingsPage } from "./shell/bot-panel";
import { BotSettings } from "./shell/bot-panel";
import type { SettingsSpace } from "./shell/dialogs";
import type { SettingsSection } from "./shell-overlay";
import { VoiceSettingsOverlay } from "./VoiceSettingsOverlay";
import "./settings-layout.css";

/** Which workspace or bot a panel edits, shown above its pages so the target is never implied. */
function ScopeBar({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div data-testid="settings-scope" className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
      <span className="shrink-0 text-[12.5px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function WorkspaceScope({
  spaces,
  space,
  onSpaceChange,
  disabled = false,
}: {
  spaces: { id: string; name: string }[];
  space: SettingsSpace | null;
  onSpaceChange: (spaceId: string) => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  return (
    <ScopeBar label={t`Editing`}>
      <NativeSelect
        aria-label={t`Workspace`}
        className="max-w-64"
        value={space?.id ?? ""}
        disabled={disabled || spaces.length < 2}
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
  disabled = false,
}: {
  botId: string | null;
  onBotChange: (botId: string) => void;
  disabled?: boolean;
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
        value={bots.find((bot) => bot.id === botId)?.id ?? bots[0]?.id ?? ""}
        disabled={disabled || bots.length < 2}
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
  if (localConnected() && section === "memory")
    return <NativeMemorySettings onBusyChange={onVoiceBusy} />;
  if (localConnected() && section === "advanced")
    return <NativeAdvancedSettings onBusyChange={onVoiceBusy} />;
  if (section === "general" || section === "chat" || section === "regional") {
    return (
      <GeneralSettingsPanels
        section={localConnected() ? (section === "general" ? "appearance" : section) : undefined}
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
  if (section === "vault") return <VaultPage scope="account" />;
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
    return (
      <ModelSettingsOverlay embedded scope="account" onClose={onClose} onBusyChange={onVoiceBusy} />
    );
  }
  if (section === "voice") {
    return (
      <VoiceSettingsOverlay embedded scope="account" onClose={onClose} onBusyChange={onVoiceBusy} />
    );
  }
  return null;
}

function VaultPage({ scope }: { scope: "account" | "space" }) {
  if (localConnected()) {
    return <p className="text-sm text-muted-foreground">本机模式暂不支持凭据库。</p>;
  }
  return <VaultSettings scope={scope} />;
}

/** The memory provider the bound workspace uses. */
function MemoryPage({
  onClose,
  onBusyChange,
}: {
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  if (localConnected()) return <LocalKnowledgeSettings />;
  return <RemoteMemoryPage onClose={onClose} onBusyChange={onBusyChange} />;
}

function RemoteMemoryPage({
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
  const overrides = useQuery({
    ...queries.spaceSettings.overrides.queryOptions(),
    enabled: !localConnected(),
  });
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
  if (section === "space-models") {
    if (localConnected())
      return <ModelSettingsOverlay embedded scope="account" onClose={onClose} />;
    return <SpaceSettingSection setting="models" onClose={onClose} />;
  }
  if (section === "space-voice") {
    if (localConnected()) {
      return (
        <VoiceSettingsOverlay
          embedded
          scope="space"
          onClose={onClose}
          onBusyChange={onBusyChange}
        />
      );
    }
    return <SpaceSettingSection setting="voice" onClose={onClose} onBusyChange={onBusyChange} />;
  }
  if (section === "space-confirmations") {
    return <SpaceSettingSection setting="confirmations" onClose={onClose} />;
  }
  if (section === "space-vault") {
    if (localConnected()) return <VaultPage scope="space" />;
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

function NativeModelInheritance({ onEdit }: { onEdit: () => void }) {
  const queries = useSpaceQueries();
  const modelQuery = useQuery(queries.models.credentials.queryOptions());
  const model = modelQuery.data?.find((item) => item.isDefault) ?? modelQuery.data?.[0];
  return (
    <div className="space-y-4" data-testid="local-model-inheritance">
      <p className="text-sm text-muted-foreground">此 Bot 使用全局模型与思考设置。</p>
      {modelQuery.error ? (
        <p role="alert" className="text-sm text-destructive">
          {modelQuery.error.message}
        </p>
      ) : (
        model && (
          <SettingsGroup>
            <SettingsRow
              label="模型"
              control={<span className="break-all text-sm">{model.modelId}</span>}
            />
            <SettingsRow
              label="思考强度"
              control={
                <span className="text-sm">
                  {model.reasoning
                    ? model.thinkingLevel
                      ? thinkingLevelLabel(model.thinkingLevel)
                      : "自动"
                    : "关闭"}
                </span>
              }
            />
            <SettingsRow
              label="上下文限制"
              control={<span className="text-sm tabular-nums">{model.contextWindow}</span>}
            />
            <SettingsRow
              label="最大输出 token 数"
              control={<span className="text-sm tabular-nums">{model.maxTokens}</span>}
            />
          </SettingsGroup>
        )
      )}
      {!modelQuery.isPending && !modelQuery.error && !model && (
        <p className="text-sm text-muted-foreground">尚未配置模型</p>
      )}
      <Button variant="outline" onClick={onEdit}>
        修改全局模型
      </Button>
    </div>
  );
}

/** One bot's own settings; the shared header selects its target. */
function BotPages({
  section,
  botId,
  onSectionChange,
  onBusyChange,
}: {
  onSectionChange: (section: SettingsSection) => void;
  section: SettingsSection;
  botId: string | null;
  onBusyChange: (busy: boolean) => void;
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
    <div
      data-testid="settings-scroll"
      className="settings-content rk-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-6 md:px-8"
    >
      <div className={`settings-page-content space-y-4 ${SETTINGS_CONTENT_WIDTH}`}>
        {bot ? (
          <>
            {!localConnected() && <BotPageStatus bot={bot} page={page} />}
            {localConnected() && page === "model" ? (
              <SpaceRpcProvider spaceId={null}>
                <NativeModelInheritance onEdit={() => onSectionChange("models")} />
              </SpaceRpcProvider>
            ) : localConnected() && page === "memory" ? (
              <LocalKnowledgeSettings key={bot.id} botId={bot.id} onBusyChange={onBusyChange} />
            ) : localConnected() && page === "tools" ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">工具与连接由所有 Bot 共用。</p>
                <div className="flex flex-wrap gap-3">
                  <a
                    href="/app?view=abilities"
                    className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm hover:bg-accent"
                  >
                    共享能力
                  </a>
                </div>
              </div>
            ) : (
              <BotSettings
                key={bot.id}
                page={page}
                bot={bot}
                memoryProviderConfigured={memoryQuery.data != null}
                onSave={async ({ computerMode, ...patch }) => {
                  onBusyChange(true);
                  try {
                    if (computerMode !== undefined && computerMode !== bot.computerMode) {
                      await rpc.bots.setComputer({ botId: bot.id, mode: computerMode });
                    }
                    await rpc.bots.update({ botId: bot.id, ...patch });
                    await queryClient.invalidateQueries({ queryKey: queries.bots.list.queryKey() });
                  } finally {
                    onBusyChange(false);
                  }
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
            )}
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
  );
}

export function SettingsOverlay({
  embedded = false,
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
  onBusyChange,
}: {
  onBusyChange?: (busy: boolean) => void;
  embedded?: boolean;
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
  const { t } = useLingui();
  const panelRef = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (embedded) setHost(document.getElementById("workspace-settings-host"));
  }, [embedded]);
  const [settingsSearch, setSettingsSearch] = useState("");
  // Voice, memory and a workspace's own pages each hold the dialog while they save.
  const [busy, setBusy] = useState(false);
  const [keepComputerRecovery, setKeepComputerRecovery] = useState(false);
  const recoveryHoldTimer = useRef<number | undefined>(undefined);
  const showComputer = keepComputerRecovery || computersAreUnavailable(sandboxProvider);
  const showUpdates = UPSTREAM_UPDATES_ENABLED && Boolean(desktopBridge()?.update);
  const native = localConnected();
  const panelLabels = useSettingsPanelLabels();
  const availability = {
    native,
    messaging: messagingEnabled,
    wallet: Boolean(paymentWalletProvider),
    computer: showComputer,
    billing: billingEnabled,
    updates: showUpdates,
  };
  const globalNav = useSettingsNavItems("global", availability);
  const workspaceNav = useSettingsNavItems("workspace", availability);
  const botNav = useSettingsNavItems("bot", availability);
  const groups = [
    { panel: "global" as const, items: globalNav },
    { panel: "workspace" as const, items: workspaceNav },
    { panel: "bot" as const, items: botNav },
  ];
  const allItems = groups.flatMap((group) => group.items);
  const oldSection: Partial<Record<SettingsSection, SettingsSection>> = native
    ? {
        data: "advanced",
        "space-models": "models",
        "space-confirmations": "confirmations",
        vault: "general",
        "space-vault": "general",
      }
    : {};
  const requested = oldSection[requestedSection] ?? requestedSection;
  const section = allItems.some((item) => item.id === requested) ? requested : "general";
  const panel: SettingsPanel = settingsPanelOf(section, native);
  const navItems = groups.find((group) => group.panel === panel)!.items;
  const term = settingsSearch.trim().toLocaleLowerCase();
  const visibleGroups = groups
    .filter((group) => term || group.panel === panel)
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        `${item.label} ${item.keywords ?? ""}`.toLocaleLowerCase().includes(term),
      ),
    }));
  const visibleItems = visibleGroups.flatMap((group) => group.items);
  const panelBusy = busy;
  useEffect(() => {
    onBusyChange?.(panelBusy);
    return () => onBusyChange?.(false);
  }, [panelBusy, onBusyChange]);
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

  const content = (
    <div
      ref={panelRef}
      data-testid="user-settings"
      data-settings-section={section}
      data-settings-panel={panel}
      className={`${desktopBridge()?.platform === "darwin" ? "settings-native-mac" : ""} settings-workspace flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background`}
    >
      <header
        data-testid="settings-header"
        className="app-drag flex settings-topbar min-h-16 shrink-0 flex-wrap items-center gap-4 border-b border-border px-5 py-3 md:px-7"
      >
        {embedded ? (
          <h2 className="text-lg font-semibold">设置</h2>
        ) : (
          <DialogTitle className="text-lg font-semibold">设置</DialogTitle>
        )}
        <fieldset aria-label="设置范围" className="app-no-drag flex items-center gap-1">
          {(["global", "workspace", "bot"] as const).map((target) => (
            <Button
              key={target}
              variant={panel === target ? "secondary" : "ghost"}
              aria-pressed={panel === target}
              disabled={panelBusy}
              onClick={() => {
                setSettingsSearch("");
                onSectionChange(
                  target === "global" ? "general" : target === "workspace" ? "space" : "bot-role",
                );
              }}
            >
              {target === "global" ? "全局" : target === "workspace" ? "工作区" : "Bot"}
            </Button>
          ))}
        </fieldset>
        <div className="app-no-drag ms-auto flex min-w-0 flex-wrap items-center gap-3">
          <SpaceRpcProvider spaceId={boundSpaceId}>
            {panel === "global" ? null : panel === "workspace" ? (
              <WorkspaceScope
                disabled={panelBusy}
                spaces={spaces}
                space={space ?? null}
                onSpaceChange={(next) => onSpaceChange?.(next)}
              />
            ) : (
              <BotScope
                botId={botId}
                disabled={panelBusy}
                onBotChange={(next) => onBotChange?.(next)}
              />
            )}
          </SpaceRpcProvider>
          {embedded ? (
            <Button
              aria-label={t`Close settings`}
              variant="ghost"
              size="icon-sm"
              disabled={panelBusy}
              onClick={requestClose}
            >
              <XIcon />
            </Button>
          ) : (
            <DialogClose
              aria-label={t`Close settings`}
              disabled={panelBusy}
              render={<Button variant="ghost" size="icon-sm" />}
            >
              <XIcon />
            </DialogClose>
          )}
        </div>
      </header>
      <div className="settings-layout min-h-0 flex-1">
        <aside className="settings-sidebar min-h-0 border-e border-border">
          <div className="settings-search relative mx-3 mb-4">
            <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              type="search"
              aria-label="搜索设置"
              placeholder="搜索设置"
              value={settingsSearch}
              disabled={panelBusy}
              onChange={(event) => setSettingsSearch(event.target.value)}
              className="h-9 ps-9"
            />
          </div>
          <nav
            data-testid="settings-nav"
            aria-label="设置分类"
            className="settings-desktop-nav rk-scroll min-h-0 overflow-y-auto px-3 pb-5"
          >
            {visibleGroups.map(
              (group) =>
                group.items.length > 0 && (
                  <section key={group.panel} className="mb-4">
                    {term && (
                      <h2 className="mb-1.5 px-2.5 text-xs text-muted-foreground">
                        {panelLabels[group.panel]}
                      </h2>
                    )}
                    <div className="space-y-0.5">
                      {group.items.map((item) => {
                        const Icon = item.icon;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            data-testid={`settings-nav-${item.id}`}
                            aria-current={item.id === section ? "page" : undefined}
                            disabled={panelBusy}
                            onClick={() => onSectionChange(item.id)}
                            className={`flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-sm transition-colors disabled:pointer-events-none disabled:opacity-50 ${item.id === section ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
                          >
                            <Icon className="size-4 shrink-0" strokeWidth={1.75} />
                            <span>{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ),
            )}
            {!visibleGroups.some((group) => group.items.length) && (
              <p role="status" className="px-2.5 text-sm text-muted-foreground">
                没有匹配的设置
              </p>
            )}
          </nav>
          <div className="settings-mobile-nav px-3 pb-3">
            <NativeSelect
              aria-label="设置分类"
              value={visibleItems.some((item) => item.id === section) ? section : ""}
              disabled={panelBusy}
              onChange={(event) => onSectionChange(event.target.value as SettingsSection)}
            >
              <NativeSelectOption value="" disabled>
                {visibleItems.length ? "选择设置" : "没有匹配的设置"}
              </NativeSelectOption>
              {visibleGroups.map((group) => (
                <optgroup key={group.panel} label={panelLabels[group.panel]}>
                  {group.items.map((item) => (
                    <NativeSelectOption key={item.id} value={item.id}>
                      {item.label}
                    </NativeSelectOption>
                  ))}
                </optgroup>
              ))}
            </NativeSelect>
          </div>
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="settings-page-heading px-5 pt-7 pb-1 md:px-8">
            <h2 className="text-xl font-semibold">{sectionTitle}</h2>
          </div>
          <SpaceRpcProvider spaceId={boundSpaceId}>
            {panel === "bot" ? (
              <BotPages
                section={section}
                botId={botId}
                onBusyChange={setBusy}
                onSectionChange={onSectionChange}
              />
            ) : (
              <div
                key={boundSpaceId ?? panel}
                data-testid="settings-scroll"
                className="settings-content rk-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-6 md:px-8"
              >
                <div className="settings-page-content w-full min-w-0">
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
        </div>
      </div>
    </div>
  );
  if (embedded) return host ? createPortal(content, host) : null;
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
        showCloseButton={false}
        initialFocus={() => panelRef.current}
        className="flex h-[min(760px,calc(100%-2rem))] max-h-[calc(100%-2rem)] w-[min(1280px,calc(100%-2rem))] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-h-[calc(100%-5rem)] sm:max-w-[1280px]"
      >
        {content}
      </DialogContent>
    </Dialog>
  );
}
