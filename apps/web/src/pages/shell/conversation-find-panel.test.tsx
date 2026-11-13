// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ find: vi.fn(), fileInfo: vi.fn() }));
vi.mock("../../lib/query", () => ({
  useSpaceQueries: () => ({
    threads: {
      find: { queryKey: ({ input }: any) => ["test-user", "test-space", "find", input] },
      fileInfo: { queryKey: ({ input }: any) => ["local", input] },
    },
    artifacts: { fileInfo: { queryKey: ({ input }: any) => ["artifact", input] } },
  }),
}));
vi.mock("../../lib/user-error", () => ({ errorText: (e: any) => e.message }));
vi.mock("./sidebar-layout", () => ({ useBotsSidebarWidth: () => 0 }));
vi.mock("../../components/ArtifactFileCard", () => ({
  ArtifactFileCard: ({ name, sourceAvailable }: any) => (
    <div>
      {name}
      {sourceAvailable ? <button type="button">源文件夹</button> : null}
    </div>
  ),
}));
vi.mock("../../components/DeliveryFileCard", () => ({
  DeliveryFileCard: ({ name, status }: any) => (
    <div>
      {name}
      {status}
    </div>
  ),
}));
vi.mock("@livingbot/ui-web", async () => {
  const React = await import("react");
  const TabsContext = React.createContext<(s: string) => void>(() => {});
  return {
    Button: ({ children, variant, size, ...rest }: any) => (
      <button type="button" {...rest}>
        {children}
      </button>
    ),
    Input: ({ ref, ...rest }: any) => <input ref={ref} {...rest} />,
    NativeSelect: ({ children, ...rest }: any) => <select {...rest}>{children}</select>,
    NativeSelectOption: ({ children, ...rest }: any) => <option {...rest}>{children}</option>,
    SectionHeading: ({ children }: any) => <h2>{children}</h2>,
    Spinner: () => <span>loading</span>,
    Tabs: ({ children, onValueChange }: any) => (
      <TabsContext.Provider value={onValueChange}>{children}</TabsContext.Provider>
    ),
    TabsList: ({ children }: any) => <div>{children}</div>,
    TabsTrigger: ({ children, value }: any) => {
      const change = React.useContext(TabsContext);
      return (
        <button type="button" onClick={() => change(value)}>
          {children}
        </button>
      );
    },
  };
});

import { ConversationFindPanel } from "./conversation-find-panel";

let cleanup: () => Promise<void> = async () => {};
afterEach(async () => {
  await cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerWidth", 1200);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const jump = vi.fn(async () => {}),
    close = vi.fn();
  let botId = "bot-a",
    open = true;
  async function render() {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ConversationFindPanel
            key={botId}
            rpc={{ threads: api, artifacts: api } as never}
            target={{ botId }}
            open={open}
            onClose={close}
            onJump={jump}
          />
        </QueryClientProvider>,
      ),
    );
    await act(async () => new Promise((r) => setTimeout(r, 20)));
  }
  cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  };
  await render();
  const click = async (text: string) => {
    const b = [...host.querySelectorAll("button")].find((b) => b.textContent === text);
    expect(b).toBeTruthy();
    await act(async () => b!.click());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
  };
  return {
    host,
    jump,
    close,
    click,
    render,
    switchBot: async (id: string) => {
      botId = id;
      await render();
    },
    setOpen: async (v: boolean) => {
      open = v;
      await render();
    },
  };
}
it("browses files from the real entry, keeps same-name versions, and jumps without closing desktop results", async () => {
  api.find.mockResolvedValue({
    items: ["a", "b"].map((id, i) => ({
      kind: "file",
      id,
      messageId: id,
      seq: i,
      role: "bot",
      senderName: "Bot",
      createdAt: "2026-11-10T10:00:00Z",
      artifactId: id,
      name: "same.xlsx",
      mimeType: "application/octet-stream",
      size: 10,
    })),
    nextBefore: null,
  });
  api.fileInfo.mockResolvedValue({ sourcePath: null });
  const f = await setup();
  expect(api.find).not.toHaveBeenCalled();
  await f.click("聊天文件");
  expect(f.host.textContent?.match(/same.xlsx/g)).toHaveLength(2);
  expect(f.host.textContent).not.toContain("源文件夹");
  const original = [...f.host.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("查看原消息"),
  );
  await act(async () => original!.click());
  expect(f.jump).toHaveBeenCalledWith("a");
  expect(f.close).not.toHaveBeenCalled();
  await f.setOpen(false);
  await f.setOpen(true);
  expect(f.host.textContent).toContain("same.xlsx");
});
it("shows failure and retries rather than claiming there are no files", async () => {
  api.find
    .mockRejectedValueOnce(Error("offline"))
    .mockResolvedValue({ items: [], nextBefore: null });
  const f = await setup();
  await f.click("聊天文件");
  expect(f.host.textContent).toContain("查找失败");
  expect(f.host.textContent).not.toContain("还没有收发过文件");
  await f.click("重试");
  expect(f.host.textContent).toContain("还没有收发过文件");
});
it("does not claim an empty end when older pages remain", async () => {
  api.find
    .mockResolvedValueOnce({ items: [], nextBefore: 100 })
    .mockResolvedValue({ items: [], nextBefore: null });
  const f = await setup();
  await f.click("聊天文件");
  expect(f.host.textContent).toContain("继续查找较早记录");
  await f.click("继续查找较早记录");
  expect(api.find.mock.calls.at(-1)?.[0]).toMatchObject({ before: 100 });
});
it("drops prior bot results when the conversation changes", async () => {
  api.find.mockResolvedValue({ items: [], nextBefore: null });
  const f = await setup();
  await f.click("聊天文件");
  await f.switchBot("bot-b");
  expect(f.host.textContent).toContain("输入关键词");
  expect(f.host.querySelector('[aria-label="搜索聊天记录"]')).toBeTruthy();
});
