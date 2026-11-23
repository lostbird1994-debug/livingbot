// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const active = new Set<string>();
vi.mock("./task-conversation", () => ({
  TaskConversation: ({ tabKey, findRequest }: { tabKey: string; findRequest: number }) => {
    const [draft, setDraft] = useState("");
    useEffect(() => {
      active.add(tabKey);
      return () => {
        active.delete(tabKey);
      };
    }, [tabKey]);
    return (
      <textarea
        data-session={tabKey}
        data-find={findRequest}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    );
  },
}));

import { TaskConversationPanels } from "./task-conversation-panels";

it("preserves open editors and their drafts while pausing inactive subscriptions", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const props = {
    bot: { id: "bot" },
    opened: ["first", "second"],
    sessions: [],
    draftTitleFor: () => undefined,
    findRequest: 0,
  } as unknown as ComponentProps<typeof TaskConversationPanels>;
  const render = async (tabKey: string, findRequest = 0, opened = props.opened) =>
    act(async () =>
      root.render(
        <TaskConversationPanels
          {...props}
          tabKey={tabKey}
          opened={opened}
          findRequest={findRequest}
        />,
      ),
    );
  try {
    await render("first");
    const first = container.querySelector<HTMLTextAreaElement>('[data-session="first"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(first, "Keep this draft");
      first.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(active).toEqual(new Set(["first"]));
    await render("second", 1);
    expect(active).toEqual(new Set(["second"]));
    expect(first.value).toBe("Keep this draft");
    await render("first", 1);
    expect(container.querySelector('[data-session="first"]')).toBe(first);
    expect(first.value).toBe("Keep this draft");
    expect(first.dataset.find).toBe("0");
    expect(active).toEqual(new Set(["first"]));
    await render("first", 1, ["first"]);
    expect(container.querySelector('[data-session="second"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    expect(active.size).toBe(0);
  }
});
