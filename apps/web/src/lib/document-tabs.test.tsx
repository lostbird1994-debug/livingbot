// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { MarkdownDocument } from "./document-tabs";
import { useDocumentTabs } from "./document-tabs";

it("deduplicates files, closes only the requested tab, and isolates chats", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let tabs!: ReturnType<typeof useDocumentTabs>;
  function Harness({ scope }: { scope: string }) {
    tabs = useDocumentTabs(scope);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const file: MarkdownDocument = {
    kind: "artifact",
    artifactId: "a",
    name: "report.md",
    target: { botId: "bot" },
  };
  try {
    await act(async () => root.render(<Harness scope="chat-1" />));
    await act(async () => {
      tabs.open(file);
      tabs.open(file);
    });
    expect(tabs.opened).toHaveLength(1);
    const first = tabs.selected!.id;
    await act(async () => tabs.open({ ...file, artifactId: "b" }));
    expect(tabs.opened).toHaveLength(2);
    await act(async () => tabs.close(first));
    expect(tabs.selected).toMatchObject({ kind: "artifact", artifactId: "b" });
    await act(async () => tabs.select(null));
    expect(tabs.selected).toBeUndefined();
    expect(tabs.opened).toHaveLength(1);
    await act(async () => tabs.select(tabs.opened[0]!.id));
    await act(async () => root.render(<Harness scope="chat-2" />));
    expect(tabs.opened).toEqual([]);
    expect(tabs.selected).toBeUndefined();
    await act(async () => tabs.open({ ...file, target: { botId: "other" } }));
    await act(async () => tabs.close(tabs.selected!.id));
    expect(tabs.opened).toEqual([]);
    expect(tabs.selected).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
