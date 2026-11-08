import { useLingui } from "@lingui/react/macro";
import {
  Brain,
  CloudDownload,
  Cpu,
  CreditCard,
  Gauge,
  KeyRound,
  LayoutGrid,
  MessageCircle,
  Monitor,
  Settings,
  ShieldCheck,
  UserRound,
  Volume2,
  Wallet,
} from "lucide-react";
import type { ComponentType } from "react";
import type { SettingsSection } from "./shell-overlay";

/** The three independent settings panels the account menu opens. */
export type SettingsPanel = "global" | "workspace" | "bot";

export const SETTINGS_PANELS: readonly SettingsPanel[] = ["global", "workspace", "bot"];

export type SettingsNavItem = {
  id: SettingsSection;
  label: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
};

/** The sections each panel shows, in nav order. */
const PANEL_SECTIONS: Record<SettingsPanel, readonly SettingsSection[]> = {
  global: [
    "general",
    "models",
    "voice",
    "confirmations",
    "vault",
    "messaging",
    "wallet",
    "computer",
    "billing",
    "updates",
  ],
  workspace: [
    "space",
    "space-models",
    "space-voice",
    "space-confirmations",
    "space-vault",
    "memory",
    "usage",
  ],
  bot: ["bot-role", "bot-voice"],
};

const SECTION_PANEL = new Map<SettingsSection, SettingsPanel>(
  SETTINGS_PANELS.flatMap((panel) => PANEL_SECTIONS[panel].map((id) => [id, panel] as const)),
);

/** The panel a section belongs to; anything unmapped is account-wide. */
export function settingsPanelOf(section: SettingsSection): SettingsPanel {
  return SECTION_PANEL.get(section) ?? "global";
}

/** The section each panel opens on when the account menu picks it. */
export const SETTINGS_PANEL_DEFAULT: Record<SettingsPanel, SettingsSection> = {
  global: "general",
  workspace: "space",
  bot: "bot-role",
};

/** The sections this deployment offers. A hidden section is not a nav item anywhere. */
export type SettingsAvailability = {
  messaging: boolean;
  wallet: boolean;
  computer: boolean;
  billing: boolean;
  updates: boolean;
};

const NEEDS: Partial<Record<SettingsSection, keyof SettingsAvailability>> = {
  messaging: "messaging",
  wallet: "wallet",
  computer: "computer",
  billing: "billing",
  updates: "updates",
};

const ICONS: Record<SettingsSection, SettingsNavItem["icon"]> = {
  general: Settings,
  space: LayoutGrid,
  models: Cpu,
  "space-models": Cpu,
  memory: Brain,
  voice: Volume2,
  "space-voice": Volume2,
  confirmations: ShieldCheck,
  "space-confirmations": ShieldCheck,
  vault: KeyRound,
  "space-vault": KeyRound,
  messaging: MessageCircle,
  wallet: Wallet,
  usage: Gauge,
  computer: Monitor,
  billing: CreditCard,
  updates: CloudDownload,
  "bot-role": UserRound,
  "bot-voice": Volume2,
};

/** The names the three panels carry in the account menu and their headers. */
export function useSettingsPanelLabels(): Record<SettingsPanel, string> {
  const { t } = useLingui();
  return {
    global: t`Global settings`,
    workspace: t`Workspace settings`,
    bot: t`Bot settings`,
  };
}

/** One panel's nav items, in order, with the sections this deployment hides left out. */
export function useSettingsNavItems(
  panel: SettingsPanel,
  available: SettingsAvailability,
): SettingsNavItem[] {
  const { t } = useLingui();
  const labels: Record<SettingsSection, string> = {
    general: t`Account and preferences`,
    space: t`Overview`,
    models: t`Models`,
    "space-models": t`Models`,
    memory: t`Memory`,
    voice: t`Voice`,
    "space-voice": t`Voice`,
    confirmations: t`Approvals`,
    "space-confirmations": t`Approvals`,
    vault: t`Vault`,
    "space-vault": t`Vault`,
    messaging: t`Messaging`,
    wallet: t`Wallet`,
    usage: t`Usage`,
    computer: t`Computer`,
    billing: t`Billing`,
    updates: t`Updates`,
    "bot-role": t`Role and instructions`,
    "bot-voice": t`Voice and notifications`,
  };
  return PANEL_SECTIONS[panel]
    .filter((id) => {
      const need = NEEDS[id];
      return need ? available[need] : true;
    })
    .map((id) => ({ id, label: labels[id], icon: ICONS[id] }));
}
