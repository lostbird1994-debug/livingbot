// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { DocumentTab } from "../../lib/document-tabs";
import type { BotTaskTabs } from "./task-tabs";
import { TaskTabs } from "./task-tabs";

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray) => strings.join("");
  return { useLingui: () => ({ t }) };
});

it.each([true, false])(
  "shares navigation with file tabs even when task sessions are enabled=%s",
  async (enabled) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    const root = createRoot(host);
    const select = vi.fn();
    const onSelectDocument = vi.fn();
    const onCloseDocument = vi.fn();
    const file: DocumentTab = {
      id: "file",
      kind: "artifact",
      artifactId: "a",
      name: "report.md",
      target: { botId: "bot" },
    };
    const state = {
      enabled,
      selected: null,
      opened: [],
      tasks: [],
      drafts: [],
      select,
      history: false,
      stopList: null,
      stopping: false,
      error: null,
    } as unknown as BotTaskTabs;
    try {
      await act(async () =>
        root.render(
          <TaskTabs
            state={state}
            documents={[file]}
            selectedDocument="file"
            onSelectDocument={onSelectDocument}
            onCloseDocument={onCloseDocument}
          />,
        ),
      );
      const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      expect([...tabs].map((tab) => tab.textContent)).toEqual(["主会话", "report.md"]);
      expect(tabs[0]?.getAttribute("aria-selected")).toBe("false");
      expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
      await act(async () => tabs[0]!.click());
      expect(select).toHaveBeenCalledWith(null);
      await act(async () => tabs[1]!.click());
      expect(onSelectDocument).toHaveBeenCalledWith("file");
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>('button[aria-label="Close preview report.md"]')!
          .click(),
      );
      expect(onCloseDocument).toHaveBeenCalledWith("file");
      const mobile = host.querySelector("select")!;
      await act(async () => {
        mobile.value = "main";
        mobile.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(select).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
