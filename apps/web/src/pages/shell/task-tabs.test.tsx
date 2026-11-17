// @vitest-environment jsdom

import type { TaskSession } from "@livingbot/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { composerDraftStorageKey } from "../../lib/composer-draft";
import type { DocumentTab } from "../../lib/document-tabs";
import type { BotTaskTabs } from "./task-tabs";
import { TaskTabs, useBotTaskTabs } from "./task-tabs";

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

it("renames drafts and saved sessions, keeps failed deletes open, and restores deleted history", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  const saved = {
    id: "session",
    botId: "bot",
    title: "Original",
    status: "completed",
    archivedAt: null,
  } as TaskSession;
  let rows = [saved];
  const rename = vi.fn(async ({ title }: { title: string }) => {
    rows = [{ ...saved, title }];
  });
  const remove = vi.fn(async () => {
    rows = rows.map((row) => ({ ...row, archivedAt: "2026-01-01T00:00:00Z" }));
  });
  const restore = vi.fn(async () => {
    rows = rows.map((row) => ({ ...row, archivedAt: null }));
  });
  const rpc = {
    taskSessions: {
      capabilities: async () => ({ enabled: true }),
      list: async () => rows,
      rename,
      delete: remove,
      archive: restore,
    },
  };
  let state: BotTaskTabs;
  function Harness() {
    state = useBotTaskTabs({ id: "bot" } as never, rpc as never, "test", null);
    return <TaskTabs state={state} />;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <Harness />
        </MemoryRouter>,
      ),
    );
    await act(async () => state!.create());
    const draft = state!.selected!;
    const tab = host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
    await act(async () => {
      tab.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: 20, clientY: 20 }),
      );
    });
    const menuItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "重命名",
    );
    expect(menuItem).toBeTruthy();
    await act(async () => menuItem!.click());
    expect(state!.editing?.id).toBe(draft);
    await act(async () => state!.setEditing({ id: draft, title: "Trip planning" }));
    await act(async () => state!.rename());
    expect(state!.draftTitle(draft)).toBe("Trip planning");
    expect(host.textContent).toContain("Trip planning");
    expect(rename).not.toHaveBeenCalled();
    await act(async () => state!.close(draft));
    await act(async () => state!.select(draft));
    expect(state!.draftTitle(draft)).toBe("Trip planning");

    await act(async () => state!.setEditing({ id: "session", title: "Renamed" }));
    await act(async () => state!.rename());
    expect(rename).toHaveBeenCalledWith({
      botId: "bot",
      taskSessionId: "session",
      title: "Renamed",
    });
    expect(state!.tasks[0]?.title).toBe("Renamed");
    await act(async () => state!.select("session"));
    await act(async () => state!.setDeleting("session"));
    remove.mockRejectedValueOnce(new Error("offline"));
    await act(async () => state!.remove());
    expect(state!.deleting).toBe("session");
    expect(state!.opened).toContain("session");
    expect(state!.error).toBeTruthy();
    await act(async () => state!.remove());
    expect(state!.deleting).toBeNull();
    expect(state!.opened).not.toContain("session");
    expect(state!.selected).toBe(draft);
    expect(state!.tasks[0]?.archivedAt).toBeTruthy();
    await act(async () => state!.restore("session"));
    expect(restore).toHaveBeenCalledWith({
      botId: "bot",
      taskSessionId: "session",
      archived: false,
    });
    expect(state!.tasks[0]?.archivedAt).toBeNull();

    const storageKey = composerDraftStorageKey(`task:test:bot:${draft}`);
    localStorage.setItem(storageKey, "draft text");
    await act(async () => state!.setDeleting(draft));
    await act(async () => state!.remove());
    expect(state!.drafts).not.toContain(draft);
    expect(localStorage.getItem(storageKey)).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
  }
});
