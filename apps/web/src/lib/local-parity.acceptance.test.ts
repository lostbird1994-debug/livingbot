// @vitest-environment jsdom
// Reviewer checks against the original product contracts, using synthetic records only.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SearchQueryOutputSchema, TaskSessionSchema } from "@livingbot/contracts";
import { adoptConnection, forgetConnection, localRpc } from "./local-workbench";

const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
const conversations = [
  { id: "main", kind: "private", botIds: ["bot-1"], title: "主会话", createdAt: 1 },
  { id: "session-a", kind: "private", botIds: ["bot-1"], title: "会话 A", createdAt: 2 },
  { id: "session-old", kind: "private", botIds: ["bot-1"], title: "旧会话", createdAt: 3, archivedAt: 4 },
];
const message = {
  id: "message-1", conversationId: "session-a", botId: "bot-1", role: "assistant",
  blocks: [{ id: "text-1", kind: "text", text: "合成交付" }],
  createdAt: 2, updatedAt: 2, final: true,
};
beforeEach(() => {
  calls.length = 0;
  forgetConnection();
  adoptConnection({ origin: "http://127.0.0.1:1234", token: "synthetic" });
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ path: url.pathname, method: init?.method ?? "GET", body });
    if (url.pathname.endsWith("/private-conversation")) return Response.json({ id: "main" });
    if (url.pathname === "/api/snapshot") return Response.json({
      bots: [{ id: "bot-1", agentId: "synthetic", name: "合成 Bot", createdAt: 1 }],
      conversations, tasks: [], runs: [], interactions: [], artifacts: [],
    });
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: [message], cursor: 1 });
    if (url.pathname === "/api/search") return Response.json({ hits: [{
      messageId: message.id, conversationId: message.conversationId, role: message.role,
      text: "合成交付", createdAt: 2,
    }] });
    if (url.pathname === "/api/bots/bot-1/loaded-context") return Response.json({
      nativeContext: {
        engine: "openclaw", agentId: "synthetic", workspace: "/synthetic/workspaces/synthetic",
        budgets: { document: 12000, total: 60000 },
        documents: [{ path: "/synthetic/workspaces/synthetic/AGENTS.md", name: "AGENTS.md",
          scope: "bot", content: "full", excerpt: "loaded", totalChars: 4, shownChars: 6 }],
      },
      scratchpad: "",
    });
    if (url.pathname.endsWith("/read-state")) return Response.json({
      id: `read:${url.pathname.split("/")[3]}`, lastReadSeq: 0,
    });
    if (url.pathname.includes("/reactions")) return Response.json({
      id: "reaction-1", messageId: "message-1", emoji: body.emoji,
    });
    if (url.pathname === "/api/submissions") return Response.json({ id: "task-1" });
    if (url.pathname === "/api/tasks/task-1") return Response.json({ run: { id: "run-1" } });
    if (url.pathname.startsWith("/api/files/")) return new Response("合成交付", {
      headers: { "content-type": "text/markdown" },
    });
    return Response.json({});
  }));
});

it("routes loaded-context preview to the authenticated local OpenClaw endpoint", async () => {
  const result = await localRpc("memory.loadedContext", { botId: "bot-1" }) as {
    nativeContext: { engine: string; documents: { excerpt: string }[] };
  };
  expect(result.nativeContext.engine).toBe("openclaw");
  expect(result.nativeContext.documents[0]?.excerpt).toBe("loaded");
  expect(calls.some((call) => call.path === "/api/bots/bot-1/loaded-context")).toBe(true);
});

it("keeps voice settings and call lifecycle on the authenticated local service", async () => {
  await localRpc("voice.status", { scope: "account" });
  for (const operation of ["answerCall", "declineCall", "endCall"]) {
    await localRpc(`threads.${operation}`, { botId: "bot-1", callId: "synthetic",
      ...(operation === "declineCall" ? { outcome: "declined" } : {}) });
  }
  expect(calls.filter((call) => call.path.startsWith("/api/calls/")).map((call) => call.path))
    .toEqual(["/api/calls/answerCall", "/api/calls/declineCall", "/api/calls/endCall"]);
  expect(calls.find((call) => call.path === "/api/voice/rpc/status")?.body.scope).toBe("account");
});

it("a spoken follow-up steers the real private session with its original call identity", async () => {
  await expect(localRpc("threads.followUp", { botId: "bot-1", text: "Synthetic spoken follow-up",
    clientNonce: "call:synthetic:turn" })).resolves.toEqual({ ok: true });
  expect(calls.find((call) => call.path === "/api/submissions")?.body).toMatchObject({
    submissionId: "call:synthetic:turn", conversationId: "main", queueMode: "steer",
    message: "Synthetic spoken follow-up",
  });
});
afterEach(() => {
  forgetConnection();
  vi.unstubAllGlobals();
});

it("lists restorable sessions in the original complete schema and keeps the main thread separate", async () => {
  const sessions = await localRpc("taskSessions.list", { botId: "bot-1" }) as unknown[];
  expect(sessions.every((session) => TaskSessionSchema.safeParse(session).success)).toBe(true);
  expect(sessions.map((session) => (session as { id: string }).id)).toEqual(["session-a", "session-old"]);
});

it("opens the selected private session instead of silently showing the Bot main thread", async () => {
  const snapshot = await localRpc("threads.get", { botId: "bot-1", taskSessionId: "session-a" }) as { threadId: string };
  expect(snapshot.threadId).toBe("session-a");
});

it("continues the selected session instead of sending the followup to the main conversation", async () => {
  await localRpc("threads.send", {
    botId: "bot-1", taskSessionId: "session-a", text: "继续合成任务", clientNonce: "followup-1",
  });
  expect(calls.find((call) => call.path === "/api/submissions")?.body.conversationId).toBe("session-a");
});

it("returns the global-search contract including a usable message destination", async () => {
  const result = SearchQueryOutputSchema.parse(await localRpc("search.query", { q: "合成" }));
  expect(result.hits[0]).toMatchObject({ kind: "message", messageId: "message-1", botId: "bot-1" });
});

it("acknowledges a read using the original boundary contract rather than returning a storage row", async () => {
  const result = await localRpc("threads.markRead", { botId: "bot-1", taskSessionId: "session-a" });
  expect(result).toMatchObject({ ok: true });
  expect(result).toHaveProperty("unreadAfterSeq");
  expect(calls.find((call) => call.path.endsWith("/read-state"))?.path)
    .toBe("/api/conversations/session-a/read-state");
  const written = calls.find((call) => call.path.endsWith("/read-state") && call.method === "POST");
  // Reading now cannot pre-read messages that have not arrived.
  expect(written?.body.lastReadSeq).not.toBe(Number.MAX_SAFE_INTEGER);
});

it("preserves the reaction the user selected through the original reaction input contract", async () => {
  const result = await localRpc("threads.react", {
    botId: "bot-1", taskSessionId: "session-a", messageId: "message-1",
    reaction: "❤️", clientNonce: "reaction-nonce",
  });
  expect(calls.find((call) => call.path.endsWith("/reactions"))?.body.emoji).toBe("❤️");
  expect(result).toMatchObject({ ok: true });
});

it("actually opens a message file through the existing action endpoint", async () => {
  const result = await localRpc("threads.fileAction", {
    botId: "bot-1", taskSessionId: "session-a", messageId: "message-1", path: "file-1", action: "open",
  });
  expect(calls.some((call) =>
    call.method === "POST" && call.path === "/api/files/file-1/action" && call.body.action === "open",
  )).toBe(true);
  expect(result).toMatchObject({ ok: true });
});

it("filters before paging and preserves real message destinations for file hits", async () => {
  const history = Array.from({ length: 80 }, (_, seq) => ({
    ...message, id: `message-${seq}`, role: seq % 2 ? "user" : "assistant",
    blocks: seq === 0
      ? [{ kind: "file", artifactId: "artifact-1", name: "report.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }]
      : [{ kind: "text", text: "匹配" }],
  }));
  const original = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) =>
    new URL(input).pathname.endsWith("/messages")
      ? Response.json({ messages: history, cursor: 80 })
      : original(input, init)));
  const target = { botId: "bot-1", taskSessionId: "session-a" };
  const first = await localRpc("threads.find", {
    ...target, mode: "messages", query: "匹配", sender: "bot",
  }) as { items: { seq: number; messageId: string }[]; nextBefore: number };
  expect(first.items).toHaveLength(25);
  expect(first.items.every((item) => item.seq % 2 === 0)).toBe(true);
  expect(first.nextBefore).toBe(30);
  const second = await localRpc("threads.find", {
    ...target, mode: "messages", query: "匹配", sender: "bot", before: first.nextBefore,
  }) as { items: { seq: number }[]; nextBefore: number | null };
  expect(second.items).toHaveLength(14);
  expect(second.nextBefore).toBeNull();
  const files = await localRpc("threads.find", { ...target, mode: "files" }) as {
    items: { seq: number; messageId: string; artifactId: string }[];
  };
  expect(files.items[0]).toMatchObject({ seq: 0, messageId: "message-0", artifactId: "artifact-1" });
});
