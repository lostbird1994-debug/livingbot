// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const files = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => {
  const client = { computer: { files } };
  return { rpc: client, createSpaceRpc: () => client, rpcForSpace: () => client,
    selectedSpaceId: () => "space-a" };
});
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
import { QueryUserProvider } from "../../lib/query";
import { SpaceRpcProvider } from "../../lib/space-rpc";
import { BotFilesPanel } from "./bot-files-panel";

it("reopens cached files during refresh, retains them on failure and isolates bots and spaces", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const client = new QueryClient({ defaultOptions: { queries: {
    retry: false, staleTime: 0, refetchOnMount: "always",
  } } });
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = async (botId: string | null, spaceId = "space-a") => {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <QueryUserProvider value="user-a">
          <SpaceRpcProvider spaceId={spaceId}>
            {botId && <BotFilesPanel botId={botId} />}
          </SpaceRpcProvider>
        </QueryUserProvider>
      </QueryClientProvider>,
    ));
    await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
  };
  const file = { path: "bots/bot-a/result.md", kind: "file", size: 10 };
  try {
    files.mockResolvedValueOnce([file]);
    await render("bot-a");
    expect(host.querySelectorAll('[data-testid="bot-file-reveal"]')).toHaveLength(1);
    await render(null);
    let reject!: (error: Error) => void;
    files.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }));
    await render("bot-a");
    expect(host.querySelectorAll('[data-testid="bot-file-reveal"]')).toHaveLength(1);
    expect(host.querySelector('[aria-label="Loading files…"]')).toBeNull();
    await act(async () => reject(Error("offline")));
    await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
    expect(host.querySelectorAll('[data-testid="bot-file-reveal"]')).toHaveLength(1);
    files.mockImplementation(() => new Promise(() => {}));
    await render("bot-b");
    expect(host.querySelectorAll('[data-testid="bot-file-reveal"]')).toHaveLength(0);
    await render("bot-a", "space-b");
    expect(host.querySelectorAll('[data-testid="bot-file-reveal"]')).toHaveLength(0);
    expect(files.mock.calls.map(call => call[0])).toEqual([
      { botId: "bot-a", path: "bots/bot-a" },
      { botId: "bot-a", path: "bots/bot-a" },
      { botId: "bot-b", path: "bots/bot-b" },
      { botId: "bot-a", path: "bots/bot-a" },
    ]);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    vi.unstubAllGlobals();
  }
});
