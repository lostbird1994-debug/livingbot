// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { adoptConnection, forgetConnection } from "./local-workbench";
import { rpc } from "./rpc";

const notify = vi.hoisted(() => vi.fn());
vi.mock("./auth", () => ({ authClient: { $store: { notify } } }));

afterEach(() => {
  forgetConnection();
  vi.unstubAllGlobals();
});

it("dispatches GET RPC queries to the connected local service", async () => {
  const item = {
    id: "todo-1",
    botId: "bot-1",
    title: "Local task",
    status: "open",
    notes: "",
    createdAt: "2026-11-21T00:00:00.000Z",
    updatedAt: "2026-11-21T00:00:00.000Z",
  };
  const requests: string[] = [];
  adoptConnection({ origin: "http://127.0.0.1:4312", token: "synthetic-token" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push(url.pathname);
      if (url.pathname === "/api/scratchpad") return Response.json([item]);
      return Response.json({ error: "unexpected remote request" }, { status: 500 });
    }),
  );

  await expect(rpc.scratchpad.list({ botId: "bot-1" })).resolves.toEqual([item]);
  expect(requests).toEqual(["/api/scratchpad"]);
});

it("connects the unchanged approval settings UI to native policy and grant endpoints", async () => {
  const settings = { mode: "ask", enabled: false, skipApprovals: false, checkerAvailable: true };
  const requests: { path: string; method: string; body?: unknown }[] = [];
  adoptConnection({ origin: "http://127.0.0.1:4312", token: "synthetic-token" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return Response.json(
        url.pathname === "/api/approval-rules"
          ? []
          : url.pathname.endsWith("/remove")
            ? { ok: true }
            : settings,
      );
    }),
  );
  await expect(rpc.autoReview.get({ scope: "account" })).resolves.toEqual(settings);
  await expect(rpc.approvalRules.list({ scope: "account" })).resolves.toEqual([]);
  await rpc.autoReview.set({ scope: "account", mode: "ask" });
  await rpc.approvalRules.remove({ scope: "account", id: "native-grant" });
  expect(requests.map((row) => row.path)).toEqual([
    "/api/approval-settings",
    "/api/approval-rules",
    "/api/approval-settings",
    "/api/approval-rules/remove",
  ]);
  expect(requests[2]).toMatchObject({ method: "POST", body: { scope: "account", mode: "ask" } });
});

it.each([false, true])("routes Bot removal with deleteMemories=%s to the authenticated local endpoint", async (deleteMemories) => {
  adoptConnection({ origin: "http://127.0.0.1:4312", token: "synthetic-token" });
  const receipt = { ok: true };
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(new URL(url).pathname).toBe("/api/bots/bot-1/remove");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ deleteMemories });
    return Response.json(receipt);
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(rpc.bots.remove({ botId: "bot-1", deleteMemories })).resolves.toEqual(receipt);
});

it("approval confirmation preserves the answer identity and uses a scheduled-task URL compatible with older local servers", async () => {
  const { localInteractionClient } = await import("./local-workbench");
  adoptConnection({ origin: "http://127.0.0.1:4312", token: "synthetic-token" });
  const answer = { resolutionId: "retry-original", decision: "allow-once" as const };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(new URL(url).pathname).toBe("/api/tasks/scheduled:synthetic/interactions/approval%3Asynthetic/resolve");
    expect(JSON.parse(String(init.body))).toEqual(answer);
    return Response.json({ id: "approval:synthetic", taskId: "scheduled:synthetic", status: "answered" });
  }));
  await expect(localInteractionClient.resolveInteraction("scheduled:synthetic", "approval:synthetic", answer)).resolves.toMatchObject({ status:"answered" });
});
