// Daily-experience endpoints against the real store: read boundaries, emoji replies,
// idempotent session creation, search destinations and a recoverable clear.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import type { RoutineProvider } from "../../../packages/kernel-runtime/src/routines.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import { WorkbenchService } from "../../../packages/workbench/src/service.ts";
import { createWorkbenchApi } from "./http.ts";

class QuietKernel {
  generation = 1;
  phase = "ready";
  requests: { method: string; params: unknown }[] = [];
  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    return {} as T;
  }
  async send() { return { runId: "run", status: "started" }; }
  async recoverHistory() { return { messages: [] }; }
  async abort() { return { aborted: true }; }
  on() {}
  off() {}
}

async function api(routineProvider?: RoutineProvider) {
  const store = new WorkbenchStore(":memory:");
  const bot = store.createBot({ name: "Example Bot", agentId: "example" });
  const conversation = store.privateConversation(bot.id);
  const kernel = new QuietKernel();
  const service = new WorkbenchService(store, kernel as never, undefined, undefined, undefined, routineProvider);
  const token = randomBytes(32).toString("hex");
  const server = createWorkbenchApi({ service, token });
  const url = await server.listen();
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const call = (path: string, init?: RequestInit) => fetch(`${url}${path}`, { headers, ...init });
  const post = (path: string, body: unknown = {}) =>
    call(path, { method: "POST", body: JSON.stringify(body) });
  return { store, bot, conversation, kernel, service, server, url, headers, call, post };
}

function addMessages(store: WorkbenchStore, conversationId: string, count: number) {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `message-${index}`;
    ids.push(id);
    store.put("messages", {
      id, conversationId, role: index % 2 === 0 ? "user" : "assistant",
      blocks: [{ id: `${id}:text`, kind: "text", text: `第 ${index} 条消息` }],
      final: true, createdAt: 1000 + index, updatedAt: 1000 + index,
    });
  }
  return ids;
}

test("read-aloud preferences persist through Bot edits and reject invalid values before writing", async () => {
  const f = await api();
  const path = `${f.url}/api/bots/${f.bot.id}`;
  const patch = (input: unknown) => fetch(path, {
    method: "PATCH", headers: f.headers, body: JSON.stringify(input),
  });
  try {
    for (const autoSpeak of [true, false]) {
      assert.equal((await patch({ autoSpeak })).status, 200);
      assert.equal((await (await fetch(path, { headers: f.headers })).json()).autoSpeak, autoSpeak);
      assert.equal(f.store.get<typeof f.bot>("bots", f.bot.id)?.autoSpeak, autoSpeak);
    }
    await patch({ autoSpeak: true });
    await patch({ name: "Renamed Bot" });
    assert.equal(f.store.get<typeof f.bot>("bots", f.bot.id)?.autoSpeak, true);
    const cursor = f.store.cursor();
    assert.equal((await patch({ autoSpeak: "false", name: "Must not save" })).status, 400);
    assert.equal(f.store.cursor(), cursor);
    assert.equal(f.store.get<typeof f.bot>("bots", f.bot.id)?.name, "Renamed Bot");
    assert.equal(f.kernel.requests.length, 0);
  } finally { await f.server.close(); f.service.detach(); f.store.close(); }
});

test("a read lands on the message boundary that exists and says what was unread", async () => {
  const f = await api();
  try {
    const [first] = addMessages(f.store, f.conversation.id, 3);
    // Nothing read yet: the whole conversation is new, and the divider starts above it.
    const read = await (await f.post(`/api/conversations/${f.conversation.id}/read-state`)).json();
    assert.deepEqual(read, { ok: true, unreadAfterSeq: -1, id: `read:${f.conversation.id}`,
      conversationId: f.conversation.id, lastReadSeq: 2, unread: false, updatedAt: read.updatedAt });

    const again = await (await f.post(`/api/conversations/${f.conversation.id}/read-state`)).json();
    assert.equal(again.unreadAfterSeq, null);

    const marked = await (await f.post(`/api/conversations/${f.conversation.id}/read-state`, {
      unread: true, messageId: first,
    })).json();
    assert.equal(marked.lastReadSeq, -1);
    assert.equal(marked.unread, true);
    const snapshot = await (await f.call("/api/snapshot")).json();
    assert.equal(snapshot.lastMessageSeq[f.conversation.id], 2);
    assert.equal(snapshot.readState.find((row: { conversationId: string }) =>
      row.conversationId === f.conversation.id).unread, true);

    const unknown = await f.post(`/api/conversations/${f.conversation.id}/read-state`, {
      unread: true, messageId: "not-here",
    });
    assert.equal(unknown.status, 400);
  } finally { await f.server.close(); f.service.detach(); f.store.close(); }
});

test("a reaction keeps the emoji the user chose and a retry adds no second reply", async () => {
  const f = await api();
  try {
    const [target] = addMessages(f.store, f.conversation.id, 1);
    const input = { emoji: "❤️", clientNonce: "reaction-nonce" };
    const first = await f.post(`/api/messages/${target}/reactions`, input);
    assert.equal(first.status, 200);
    const retry = await f.post(`/api/messages/${target}/reactions`, input);
    assert.equal(retry.status, 200);

    const replies = f.store.messages(f.conversation.id)
      .filter((message) => message.replyToMessageId === target);
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.role, "user");
    assert.deepEqual(replies[0]!.blocks, [{ id: replies[0]!.blocks[0]!.id, kind: "text", text: "❤️" }]);

    // A different emoji is its own reply, not a rewrite of the first.
    await f.post(`/api/messages/${target}/reactions`, { emoji: "👍", clientNonce: "another-nonce" });
    assert.equal(f.store.messages(f.conversation.id)
      .filter((message) => message.replyToMessageId === target).length, 2);
  } finally { await f.server.close(); f.service.detach(); f.store.close(); }
});

test("a client nonce pins the new session so a retried acceptance opens one conversation", async () => {
  const f = await api();
  try {
    const body = { kind: "private", botIds: [f.bot.id], title: "新会话", clientNonce: "draft-1" };
    const first = await (await f.post("/api/conversations", body)).json();
    const retry = await (await f.post("/api/conversations", body)).json();
    assert.equal(first.id, retry.id);
    const rows = f.store.list<{ botIds: string[] }>("conversations")
      .filter((row) => row.botIds[0] === f.bot.id);
    assert.equal(rows.length, 2);
  } finally { await f.server.close(); f.service.detach(); f.store.close(); }
});

test("search names the conversation a hit belongs to and pages by message order", async () => {
  const f = await api();
  try {
    addMessages(f.store, f.conversation.id, 3);
    const group = f.store.createConversation("group", [f.bot.id], "项目群");
    f.store.put("messages", {
      id: "group-message", conversationId: group.id, botId: f.bot.id, role: "assistant",
      blocks: [{ id: "g:text", kind: "text", text: "群里的第 1 条消息" }],
      final: true, createdAt: 2000, updatedAt: 2000,
    });
    const result = await (await f.call("/api/search?q=%E6%B6%88%E6%81%AF")).json();
    const privateHit = result.hits.find((hit: { conversationId: string }) =>
      hit.conversationId === f.conversation.id);
    const groupHit = result.hits.find((hit: { conversationId: string }) => hit.conversationId === group.id);
    assert.equal(privateHit.botId, f.bot.id);
    assert.equal(groupHit.groupId, group.id);
    assert.equal(privateHit.seq, 2);
    assert.ok(result.hits.length <= 25);
    // The page can be narrowed to one conversation, which is what the in-chat find uses.
    const scoped = await (await f.call(
      `/api/search?q=%E6%B6%88%E6%81%AF&conversationId=${f.conversation.id}`)).json();
    assert.ok(scoped.hits.every((hit: { conversationId: string }) =>
      hit.conversationId === f.conversation.id));
  } finally { await f.server.close(); f.service.detach(); f.store.close(); }
});

test("clearing a conversation hides its transcript without dropping the rows", async () => {
  const f = await api();
  try {
    addMessages(f.store, f.conversation.id, 2);
    const cleared = await f.post(`/api/conversations/${f.conversation.id}/clear`);
    assert.equal(cleared.status, 200);
    assert.deepEqual(f.kernel.requests, [{
      method: "sessions.reset",
      params: { key: f.store.engineSessionKey(f.conversation.id, f.bot.id), reason: "reset" },
    }]);
    const visible = await (await f.call(`/api/conversations/${f.conversation.id}/messages`)).json();
    assert.equal(visible.messages.length, 0);
    assert.equal(f.store.messages(f.conversation.id).length, 2);
    // A new message after the clear is visible and starts the transcript again.
    f.store.put("messages", {
      id: "after-clear", conversationId: f.conversation.id, role: "user",
      blocks: [{ id: "a:text", kind: "text", text: "重新开始" }],
      final: true, createdAt: Date.now(), updatedAt: Date.now(),
    });
    const resumed = await (await f.call(`/api/conversations/${f.conversation.id}/messages`)).json();
    assert.deepEqual(resumed.messages.map((message: { id: string }) => message.id), ["after-clear"]);
  } finally { await f.server.close(); f.service.detach(); f.store.close(); }
});

test("a task session can be renamed and archived but the Bot home thread cannot", async () => {
  const f = await api();
  try {
    const session = f.store.createConversation("private", [f.bot.id], "任务会话",
      randomUUID());
    const renamed = await f.call(`/api/conversations/${session.id}`, {
      method: "PATCH", body: JSON.stringify({ title: "改名后" }),
    });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).title, "改名后");
    assert.equal((await f.call(`/api/conversations/${session.id}`, { method: "DELETE" })).status, 200);
    assert.ok(f.store.get<{ archivedAt?: number }>("conversations", session.id)?.archivedAt);
    assert.equal((await f.call(`/api/conversations/${f.conversation.id}`, { method: "DELETE" })).status, 404);
  } finally { await f.server.close(); f.service.detach(); f.store.close(); }
});

test("routine history resolves the agent reply using its bound occurrence, not the cron request id", async () => {
  const unused = async (): Promise<never> => { throw new Error("Unexpected native mutation"); };
  const f = await api({
    create: unused, get: unused, setEnabled: unused, update: unused, history: unused,
    remove: unused, runNow: unused,
  });
  try {
    f.store.put("routines", {
      id: "routine-1", botId: f.bot.id, conversationId: f.conversation.id,
      nativeId: "job-1", state: "ready", createdAt: 1, updatedAt: 1,
    });
    f.store.put("routineReceipts", {
      id: "receipt-1", routineId: "routine-1", botId: f.bot.id, conversationId: f.conversation.id,
      jobId: "job-1", runId: "cron-request-1", startedAt: 1000,
      sessionId: "native-session", status: "ok", completion: "succeeded", timestamp: 2000,
    });
    f.store.put("tasks", {
      id: "task-1", botId: f.bot.id, reportConversationId: f.conversation.id,
      conversationId: f.conversation.id, status: "completed", createdAt: 1000, updatedAt: 2000,
      routine: { id: "routine-1", jobId: "job-1", runId: "agent-run-1",
        sessionId: "native-session", occurrenceId: "cron:job-1:1000" },
    });
    f.store.put("messages", {
      id: "answer-1", conversationId: f.conversation.id, botId: f.bot.id,
      taskId: "task-1", runId: "agent-run-1", role: "assistant", final: true,
      blocks: [{ id: "text", kind: "text", text: "Result" }], createdAt: 2000, updatedAt: 2000,
    });
    const result = await (await f.call("/api/routines/routine-1/history")).json();
    assert.equal(result.entries[0].messageId, "answer-1");
    const task = f.store.get<Record<string, unknown>>("tasks", "task-1");
    f.store.put("tasks", { ...task, id: "ambiguous-owner" });
    const ambiguous = await (await f.call("/api/routines/routine-1/history")).json();
    assert.equal(ambiguous.entries[0].messageId, null);
  } finally { await f.server.close(); f.service.detach(); f.store.close(); }
});
