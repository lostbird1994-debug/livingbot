import { useLingui } from "@lingui/react/macro";
import {
  Brain,
  CloudDownload,
  Cpu,
  CreditCard,
  Database,
  Gauge,
  KeyRound,
  Keyboard,
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

type NavGroupSpec = { label: string; sections: readonly SettingsSection[] };

/** How a panel's sections group in the nav: preferences, what the app can do, what is risky. */
const NESTED_GROUPS: Record<SettingsPanel, readonly NavGroupSpec[]> = {
  global: [
    { label: "偏好", sections: ["general", "chat", "regional", "system", "shortcuts"] },
    { label: "能力", sections: ["models", "voice", "memory"] },
    { label: "安全", sections: ["confirmations", "advanced"] },
  ],
  workspace: [{ label: "工作区", sections: ["space", "space-voice", "usage"] }],
  bot: [
    { label: "身份", sections: ["bot-role"] },
    { label: "能力", sections: ["bot-model", "bot-memory", "bot-voice", "bot-tools"] },
  ],
};

/** The hosted build lists other account pages, so it groups them its own way. */
const HOSTED_GROUPS: Record<SettingsPanel, readonly NavGroupSpec[]> = {
  global: [
    { label: "通用", sections: ["general"] },
    { label: "能力", sections: ["models", "voice"] },
    { label: "安全", sections: ["confirmations", "vault"] },
    { label: "连接与设备", sections: ["messaging", "computer"] },
    { label: "账户", sections: ["wallet", "billing", "updates"] },
  ],
  workspace: [
    { label: "工作区", sections: ["space", "memory", "usage"] },
    { label: "能力", sections: ["space-models", "space-voice"] },
    { label: "安全", sections: ["space-confirmations", "space-vault"] },
  ],
  bot: [
    { label: "身份", sections: ["bot-role"] },
    { label: "能力", sections: ["bot-model", "bot-memory", "bot-voice", "bot-tools"] },
  ],
};

export type SettingsNavSection = { label: string; items: SettingsNavItem[] };

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
  system: Monitor,
  shortcuts: Keyboard,
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
    system: "系统",
    shortcuts: "键盘快捷键",
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
          "system",
          "shortcuts",
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
    system: "系统 链接 打开方式 文件 开机 启动 登录 system link open file login start",
    shortcuts: "快捷键 组合键 键盘 shortcut keyboard keys",
    models: "模型 服务地址 API 密钥 上下文 输出 token 思考强度 provider context reasoning model",
    voice: "语音 听写 麦克风 识别 朗读 声音 speech voice dictation tts stt",
    confirmations: "审批 确认 权限 授权 规则 approval permission",
    connections: "连接 账号 MCP OAuth 登录 工具 服务 connection login authorization",
    memory: "记忆 检索 搜索 来源 恢复 memory retrieval",
    advanced: "高级 能力 审计 超级管理员 定期 频率 audit administrator",
  };
  return sections
    .filter((id) => {
      const need = NEEDS[id];
      return need ? available[need] : true;
    })
    .map((id) => ({ id, label: labels[id], icon: ICONS[id], keywords: keywords[id] }));
}

/**
 * One panel's nav, grouped by what the settings are about. A section the group list does not
 * mention still shows, appended to the last group, so a new section is never silently hidden.
 */
export function groupSettingsNav(
  panel: SettingsPanel,
  items: readonly SettingsNavItem[],
  native: boolean,
): SettingsNavSection[] {
  const specs = (native ? NESTED_GROUPS : HOSTED_GROUPS)[panel];
  const byId = new Map(items.map((item) => [item.id, item]));
  const groups = specs
    .map((spec) => ({
      label: spec.label,
      items: spec.sections.flatMap((id) => byId.get(id) ?? []),
    }))
    .filter((group) => group.items.length > 0);
  const grouped = new Set(groups.flatMap((group) => group.items.map((item) => item.id)));
  const rest = items.filter((item) => !grouped.has(item.id));
  if (rest.length > 0) {
    groups.push({ label: "其他", items: rest });
  }
  return groups;
}
