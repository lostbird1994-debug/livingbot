// @vitest-environment jsdom
import type { ConversationUsage } from "@livingbot/contracts";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SpaceQueries } from "../../lib/query";
import type { RpcClient } from "../../lib/rpc";
import { useConversationUsage } from "./use-conversation-usage";

const usage = (id: string): ConversationUsage => ({
  threadId: id,
  total: {
    calls: 1,
    reportedCalls: 1,
    tokens: 100,
    knownTokens: 100,
    inputTokens: 80,
    outputTokens: 20,
    cacheReadTokens: null,
    cacheHitRate: null,
    tokensPerSecond: null,
    modelDurationMs: null,
  },
  latest: null,
  context: null,
});
const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.useRealTimers();
});

it("shows only the selected session's cached usage, including after a remount", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const read = vi.fn(() => new Promise<ConversationUsage>(() => {}));
  const queries = createTanstackQueryUtils({ usage: { thread: read } } as unknown as RpcClient, {
    path: ["user:fixture", "space:fixture"],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  for (const id of ["first", "second"]) {
    client.setQueryData(
      queries.usage.thread.queryKey({ input: { botId: "bot", taskSessionId: id } }),
      usage(id),
    );
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe({ id }: { id: string }) {
    const result = useConversationUsage({
      queries,
      target: { botId: "bot", taskSessionId: id },
      enabled: true,
      running: false,
    });
    return <span>{result.data?.threadId ?? "unknown"}</span>;
  }
  function render(id: string) {
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe key={id} id={id} />
        </QueryClientProvider>,
      ),
    );
  }
  try {
    render("first");
    expect(container.textContent).toBe("first");
    render("second");
    expect(container.textContent).toBe("second");
    render("unvisited");
    expect(container.textContent).toBe("unknown");
    render("first");
    expect(container.textContent).toBe("first");
  } finally {
    act(() => root.unmount());
  }
});

it("refreshes a running session and retains its cached data when the refresh fails", async () => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const read = vi.fn().mockRejectedValue(new Error("offline"));
  const queries: SpaceQueries = createTanstackQueryUtils(
    { usage: { thread: read } } as unknown as RpcClient,
    { path: ["user:fixture", "space:fixture"] },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(queries.usage.thread.queryKey({ input: { botId: "bot" } }), usage("cached"));
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe({ running }: { running: boolean }) {
    const result = useConversationUsage({
      queries,
      target: { botId: "bot" },
      enabled: true,
      running,
    });
    return <span>{result.data?.threadId}</span>;
  }
  async function render(running: boolean) {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe running={running} />
        </QueryClientProvider>,
      ),
    );
  }
  try {
    await render(false);
    expect(read).not.toHaveBeenCalled();
    await render(true);
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(read).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("cached");
    await render(false);
    expect(read).toHaveBeenCalledTimes(3);
    expect(container.textContent).toBe("cached");
  } finally {
    act(() => root.unmount());
  }
});
