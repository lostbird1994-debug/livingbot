// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fileInfo: vi.fn(async () => ({ name: "report.md", path: "/Users/test/report.md", size: 2048 })),
  fileAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../lib/rpc", () => ({ rpc: { threads: api } }));
vi.mock("./ArtifactFileCard", () => ({ ArtifactFileCard: () => null }));
vi.mock("./DeliveryFileCard", () => ({
  DeliveryFileCard: ({
    name,
    size,
    onOpen,
    onReveal,
  }: {
    name: string;
    size?: number;
    onOpen(): Promise<void>;
    onReveal(): Promise<void>;
  }) => (
    <div>
      {name}:{size}
      <button type="button" onClick={() => void onOpen()}>
        open
      </button>
      <button type="button" onClick={() => void onReveal()}>
        folder
      </button>
    </div>
  ),
}));

import { DocumentTabsProvider } from "../lib/document-tabs";
import { MessageDeliveryFiles, messageFileReferences } from "./MessageDeliveryFiles";

it("deduplicates exact references and does not treat ordinary text as a delivered file", () => {
  expect(
    messageFileReferences([
      { kind: "text", text: "普通说明 /Users/test/a.md 与 `/Users/test/a.md`" },
    ]),
  ).toEqual(["/Users/test/a.md"]);
});

it("opens a referenced Markdown file in a tab while keeping its original authorization scope", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.fileAction.mockClear();
  const openDocument = vi.fn();
  const host = document.createElement("div");
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const target = { botId: "bot", taskSessionId: "task" };
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <DocumentTabsProvider value={openDocument}>
            <MessageDeliveryFiles
              target={target}
              message={
                {
                  id: "msg",
                  role: "bot",
                  blocks: [{ kind: "text", text: "`/bots/bot/report.md`" }],
                } as never
              }
            />
          </DocumentTabsProvider>
        </QueryClientProvider>,
      ),
    );
    await act(async () => host.querySelector("button")!.click());
    expect(openDocument).toHaveBeenCalledWith({
      kind: "message",
      name: "report.md",
      target,
      messageId: "msg",
      path: "/bots/bot/report.md",
    });
    expect(api.fileAction).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    vi.unstubAllGlobals();
  }
});
it("reads real metadata and routes both operations through the original message path", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"),
    root = createRoot(host),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MessageDeliveryFiles
            target={{ botId: "bot" }}
            message={
              {
                id: "msg",
                role: "bot",
                blocks: [{ kind: "text", text: "`/bots/bot/report.md`" }],
              } as never
            }
          />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(host.textContent).toContain("report.md:2048");
    for (const button of host.querySelectorAll("button")) await act(async () => button.click());
    expect(api.fileAction).toHaveBeenCalledWith({
      botId: "bot",
      messageId: "msg",
      path: "/bots/bot/report.md",
      action: "open",
    });
    expect(api.fileAction).toHaveBeenCalledWith({
      botId: "bot",
      messageId: "msg",
      path: "/bots/bot/report.md",
      action: "reveal",
    });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    vi.unstubAllGlobals();
  }
});
