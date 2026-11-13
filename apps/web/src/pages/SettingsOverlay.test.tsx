// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en" },
  }),
}));

vi.mock("@livingbot/ui-web", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Dialog: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogClose: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    initialFocus: _initialFocus,
    ...props
  }: { children?: ReactNode; showCloseButton?: boolean; initialFocus?: unknown } & Omit<
    React.ComponentProps<"div">,
    "children"
  >) => <div {...props}>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  NativeSelect: ({ children, ...props }: React.ComponentProps<"select">) => (
    <select {...props}>{children}</select>
  ),
  NativeSelectOption: ({ children, ...props }: React.ComponentProps<"option">) => (
    <option {...props}>{children}</option>
  ),
}));

vi.mock("./AccountSettingsOverlay", () => ({
  ComputerSettingsPanel: () => null,
  GeneralSettingsPanels: () => <div data-testid="general-pages" />,
  UpdatesSettingsPanel: () => null,
  UsageSettingsPanel: () => <div data-testid="usage-pages" />,
}));
vi.mock("./BillingSettingsPanel", () => ({
  BillingSettingsPanel: () => <div data-testid="billing-pages" />,
}));
vi.mock("./PaymentWalletSettingsPanel", () => ({ PaymentWalletSettingsPanel: () => null }));
vi.mock("./MemorySettingsOverlay", () => ({
  MemorySettingsOverlay: () => <div data-testid="memory-pages" />,
}));
vi.mock("./SpaceSettingsPanel", () => ({
  SpaceSettingsPanel: ({ space }: { space: { name: string } }) => (
    <div data-testid="space-pages">{space.name}</div>
  ),
}));
vi.mock("./SpaceSettingSection", () => ({
  SpaceSettingSection: ({ setting }: { setting: string }) => (
    <div data-testid={`space-setting-${setting}`} />
  ),
}));
vi.mock("./ModelSettingsOverlay", () => ({
  ModelSettingsOverlay: ({ scope }: { scope: string }) => (
    <div data-testid="models-pages">{scope}</div>
  ),
}));
vi.mock("./VoiceSettingsOverlay", () => ({
  VoiceSettingsOverlay: ({ scope }: { scope: string }) => (
    <div data-testid="voice-pages">{scope}</div>
  ),
}));
vi.mock("../components/ApprovalRulesSettings", () => ({
  ApprovalRulesSettings: ({ scope }: { scope: string }) => (
    <div data-testid="confirmations-pages">{scope}</div>
  ),
}));
vi.mock("../components/VaultSettings", () => ({
  VaultSettings: ({ scope }: { scope: string }) => <div data-testid="vault-pages">{scope}</div>,
}));
// The bot panel owns its own fields; the dialog only has to hand it one page at a time.
vi.mock("./shell/bot-panel", () => ({
  BotSettings: ({ bot, page }: { bot: { name: string }; page: string }) => (
    <div data-testid={`bot-page-${page}`}>{bot.name}</div>
  ),
}));
vi.mock("../components/SettingsRows", () => ({ SETTINGS_CONTENT_WIDTH: "" }));
vi.mock("../components/ComputersUnavailableHint", () => ({
  computersAreUnavailable: () => false,
}));
vi.mock("../lib/desktop", () => ({
  desktopBridge: () => (globalThis as { rakazoDesktop?: unknown }).rakazoDesktop,
}));
vi.mock("../lib/rpc", () => ({
  rpc: {},
  createSpaceRpc: () => ({}),
  rpcForSpace: () => ({}),
  selectedSpaceId: () => null,
}));

const { bots } = vi.hoisted(() => ({
  bots: [
    { id: "bot-1", name: "小K", archivedAt: null },
    { id: "bot-2", name: "Scout", archivedAt: null },
  ],
}));

vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({
    bots: { list: { queryOptions: () => ({ queryKey: ["bots"], queryFn: async () => bots }) } },
    memory: {
      providerConfig: { queryOptions: () => ({ queryKey: ["memory"], queryFn: async () => null }) },
    },
    usage: {
      summary: { queryOptions: () => ({ queryKey: ["usage"], queryFn: async () => null }) },
    },
    spaceSettings: {
      overrides: { queryOptions: () => ({ queryKey: ["overrides"], queryFn: async () => [] }) },
    },
  }),
  queryClient: { setQueryData: () => undefined, invalidateQueries: () => undefined },
}));

import { SettingsOverlay } from "./SettingsOverlay";

const acme = { id: "space-a", name: "Acme" };
const spaces = [acme, { id: "space-b", name: "Beta" }];

async function render(props: Partial<React.ComponentProps<typeof SettingsOverlay>>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rerender = async (next: Partial<React.ComponentProps<typeof SettingsOverlay>>) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SettingsOverlay
            name="Jamie"
            timezone={null}
            onTimezoneChange={async () => undefined}
            onClose={() => undefined}
            requestedSection="general"
            onSectionChange={() => undefined}
            {...next}
          />
        </QueryClientProvider>,
      );
    });
  };
  await rerender(props);
  return {
    container,
    rerender,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

/** Lets the bot list land before the panel is inspected. */
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const shown = (container: HTMLElement) =>
  container.querySelector("[data-settings-section]")?.getAttribute("data-settings-section");
const panelOf = (container: HTMLElement) =>
  container.querySelector("[data-settings-panel]")?.getAttribute("data-settings-panel");
const nav = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-testid="settings-nav-${id}"]`);

it("opens the global panel with only the account's own pages", async () => {
  const { container, cleanup } = await render({ requestedSection: "models", space: acme, spaces });
  try {
    expect(panelOf(container)).toBe("global");
    expect(container.querySelector("h2")?.textContent).toBe("Global settings");
    expect(nav(container, "models")).not.toBeNull();
    // Workspace pages stay out of the account panel.
    expect(nav(container, "usage")).toBeNull();
    expect(nav(container, "space-models")).toBeNull();
    // The account panel says it covers every workspace, and offers nothing to pick.
    const scope = container.querySelector('[data-testid="settings-scope"]');
    expect(scope?.textContent).toContain("Applies to every workspace");
    expect(scope?.querySelector("select")).toBeNull();
    expect(container.querySelector('[data-testid="models-pages"]')?.textContent).toBe("account");
  } finally {
    await cleanup();
  }
});

it("opens the workspace panel with that workspace's pages", async () => {
  const { container, cleanup } = await render({ requestedSection: "space", space: acme, spaces });
  try {
    expect(panelOf(container)).toBe("workspace");
    expect(container.querySelector("h2")?.textContent).toBe("Workspace settings");
    for (const id of ["space", "space-models", "memory", "usage"]) {
      expect(nav(container, id)).not.toBeNull();
    }
    // Account pages stay out of the workspace panel.
    expect(nav(container, "general")).toBeNull();
    expect(nav(container, "billing")).toBeNull();
    expect(container.querySelector('[data-testid="settings-scope"]')?.textContent).toContain(
      "Acme",
    );
  } finally {
    await cleanup();
  }
});

it("switches the workspace from inside the panel", async () => {
  const onSpaceChange = vi.fn();
  const { container, cleanup } = await render({
    requestedSection: "space-models",
    space: acme,
    spaces,
    onSpaceChange,
  });
  try {
    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="settings-scope"] select',
    );
    if (!select) throw new Error("Missing workspace picker");
    await act(async () => {
      select.value = "space-b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSpaceChange).toHaveBeenCalledWith("space-b");
    // The workspace copy, not the account's.
    expect(container.querySelector('[data-testid="space-setting-models"]')).not.toBeNull();
  } finally {
    await cleanup();
  }
});

it("opens the bot panel with a bot picker and that bot's pages", async () => {
  const { container, cleanup } = await render({
    requestedSection: "bot-role",
    space: acme,
    spaces,
  });
  try {
    await flush();
    expect(panelOf(container)).toBe("bot");
    expect(container.querySelector("h2")?.textContent).toBe("Bot settings");
    for (const id of ["bot-role", "bot-model", "bot-memory", "bot-voice", "bot-tools"]) {
      expect(nav(container, id)).not.toBeNull();
    }
    const options = [...container.querySelectorAll('[data-testid="settings-scope"] option')].map(
      (option) => option.textContent,
    );
    expect(options).toEqual(["小K", "Scout"]);
    expect(container.querySelector('[data-testid="bot-page-role"]')?.textContent).toBe("小K");
  } finally {
    await cleanup();
  }
});

it("gives each bot page its own fields and says what the bot inherits", async () => {
  const { container, rerender, cleanup } = await render({
    requestedSection: "bot-model",
    space: acme,
    spaces,
    botId: "bot-1",
  });
  try {
    await flush();
    expect(container.querySelector('[data-testid="bot-page-model"]')).not.toBeNull();
    // A bot without its own model follows the workspace default.
    const badge = container.querySelector('[data-testid="inheritance-badge"]');
    expect(badge?.getAttribute("data-own")).toBe("false");
    expect(badge?.textContent).toContain("Space default");
    await rerender({ requestedSection: "bot-tools", space: acme, spaces, botId: "bot-1" });
    expect(container.querySelector('[data-testid="bot-page-tools"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="bot-page-model"]')).toBeNull();
  } finally {
    await cleanup();
  }
});

it("switches the bot from inside the panel", async () => {
  const onBotChange = vi.fn();
  const { container, cleanup } = await render({
    requestedSection: "bot-voice",
    space: acme,
    spaces,
    botId: "bot-1",
    onBotChange,
  });
  try {
    await flush();
    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="settings-scope"] select',
    );
    if (!select) throw new Error("Missing bot picker");
    await act(async () => {
      select.value = "bot-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onBotChange).toHaveBeenCalledWith("bot-2");
    expect(container.querySelector('[data-testid="bot-page-voice"]')).not.toBeNull();
  } finally {
    await cleanup();
  }
});

it("opens the panel's first page when the linked section is hidden", async () => {
  const { container, rerender, cleanup } = await render({
    requestedSection: "billing",
    billingEnabled: false,
  });
  try {
    expect(shown(container)).toBe("general");
    await rerender({ requestedSection: "billing", billingEnabled: true });
    expect(shown(container)).toBe("billing");
  } finally {
    await cleanup();
  }
});

it("hides Updates outside the desktop app", async () => {
  const { container, cleanup } = await render({});
  try {
    expect(nav(container, "updates")).toBeNull();
  } finally {
    await cleanup();
  }
});
