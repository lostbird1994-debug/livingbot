import { useLingui } from "@lingui/react/macro";
import {
  Brain,
  CloudDownload,
  Cpu,
  CreditCard,
  Database,
  Gauge,
  KeyRound,
  LayoutGrid,
  MessageCircle,
  Monitor,
  Plug,
  Settings,
  ShieldCheck,
  UserRound,
  Volume2,
  Wallet,
  Wrench,
} from "lucide-react";
import type { ComponentType } from "react";
import type { SettingsSection } from "./shell-overlay";

/** The three independent settings panels the account menu opens. */
export type SettingsPanel = "global" | "workspace" | "bot";

export const SETTINGS_PANELS: readonly SettingsPanel[] = ["global", "workspace", "bot"];

export type SettingsNavItem = {
  id: SettingsSection;
  label: string;
  keywords?: string;
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
  bot: ["bot-role", "bot-model", "bot-memory", "bot-voice", "bot-tools"],
};

const SECTION_PANEL = new Map<SettingsSection, SettingsPanel>(
  SETTINGS_PANELS.flatMap((panel) => PANEL_SECTIONS[panel].map((id) => [id, panel] as const)),
);

/** The panel a section belongs to; anything unmapped is account-wide. */
export function settingsPanelOf(section: SettingsSection, native = false): SettingsPanel {
  if (native && ["memory", "connections", "data"].includes(section)) return "global";
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
  native?: boolean;
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
  chat: MessageCircle,
  regional: Settings,
  advanced: Settings,
  connections: Plug,
  data: Database,
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
  "bot-model": Cpu,
  "bot-memory": Brain,
  "bot-voice": Volume2,
  "bot-tools": Wrench,
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
    general: available.native ? "外观" : t`Account and preferences`,
    chat: "聊天",
    regional: "语言与地区",
    advanced: "高级",
    connections: "连接与账号",
    data: "数据与导入",
    space: t`Overview`,
    models: t`Models`,
    "space-models": t`Models`,
    memory: t`Memory`,
    voice: t`Voice`,
    "space-voice": available.native ? "语音偏好" : t`Voice`,
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
    "bot-model": t`Model and thinking`,
    "bot-memory": available.native ? "记忆" : t`Memory scope`,
    "bot-voice": t`Voice and notifications`,
    "bot-tools": available.native ? "工具与连接" : t`Tools and permissions`,
  };
  const sections: readonly SettingsSection[] = available.native
    ? panel === "global"
      ? [
          "general",
          "chat",
          "regional",
          "models",
          "voice",
          "confirmations",
          "memory",
          "advanced",
        ]
      : panel === "workspace"
        ? ["space", "space-voice", "usage"]
        : PANEL_SECTIONS.bot
    : PANEL_SECTIONS[panel];
  const keywords: Partial<Record<SettingsSection, string>> = {
    general: "外观 主题 深色 浅色 侧栏 密度 appearance theme density",
    chat: "聊天 回车 流式 思考 执行过程 图片 streaming thinking",
    regional: "语言 时区 地区 language timezone locale",
    models: "模型 服务地址 API 密钥 上下文 输出 token 思考强度 provider context reasoning model",
    voice: "语音 听写 麦克风 识别 朗读 声音 speech voice dictation tts stt",
    confirmations: "审批 确认 权限 授权 规则 approval permission",
    connections: "连接 账号 MCP OAuth 登录 工具 服务 connection login authorization",
    memory: "记忆 检索 搜索 来源 恢复 memory retrieval",
    advanced: "高级 能力 审计 超级管理员 定期 频率 迁移 导入 旧版 migration import audit administrator",
    data: "导入 迁移 备份 1.0 历史 import migration backup",
  };
  return sections
    .filter((id) => {
      const need = NEEDS[id];
      return need ? available[need] : true;
    })
    .map((id) => ({ id, label: labels[id], icon: ICONS[id], keywords: keywords[id] }));
}
