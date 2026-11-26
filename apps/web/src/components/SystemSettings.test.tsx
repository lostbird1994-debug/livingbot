// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShortcutSettings } from "./ShortcutSettings";
import { SystemSettings } from "./SystemSettings";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("shortcut settings", () => {
  it("lists the keys the app answers, grouped by where they apply", async () => {
    await act(async () => root.render(<ShortcutSettings />));
    expect(host.textContent).toContain("新建对话");
    expect(host.textContent).toContain("命令菜单");
    // Without a shell there is no window chrome and no global voice key to promise.
    expect(host.textContent).not.toContain("语音助手");
  });
});

describe("system settings", () => {
  it("leaves the shell-only choices idle until a shell can carry them out", async () => {
    await act(async () => root.render(<SystemSettings />));
    const linkMode = host.querySelector<HTMLButtonElement>('[data-testid="link-open-system"]');
    const startAtLogin = host.querySelector<HTMLButtonElement>('[data-testid="start-at-login-toggle"]');
    expect(linkMode?.disabled).toBe(true);
    // The switch marks itself disabled the way the design system does, not with the raw attribute.
    expect(
      startAtLogin?.matches("[disabled], [data-disabled], [aria-disabled='true']"),
    ).toBe(true);
    // Previewing a file needs no shell, so that choice stays live.
    expect(host.querySelector<HTMLButtonElement>('[data-testid="file-open-preview"]')?.disabled).toBe(
      false,
    );
  });
});
