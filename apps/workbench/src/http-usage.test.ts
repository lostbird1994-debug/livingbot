import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { HistoryPage, Submission } from "../../../packages/kernel-runtime/src/contracts.ts";
import type { Run, Task } from "../../../packages/workbench/src/contracts.ts";
import { WorkbenchService } from "../../../packages/workbench/src/service.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import { createWorkbenchApi } from "./http.ts";

const usage = (output: number) => ({
  input: 10, output, cacheRead: 5, cacheWrite: 0, totalTokens: 15 + output,
});
type NativeMessage = {
  role: string; timestamp: number;
  usage?: ReturnType<typeof usage> & { usageReport?: { state: string } };
  durationMs?: number;
};

class UsageKernel extends EventEmitter {
  generation = 1;
  phase = "ready";
  histories = new Map<string, NativeMessage[][]>();
  sessions?: { key: string; usage: ReturnType<typeof usage> }[];
  reads: { method: string; sessionKey?: string; key?: string; cursor?: string }[] = [];
  async request<T = unknown>(method: string, params: { sessionKey?: string; key?: string; cursor?: string } = {}): Promise<T> {
    this.reads.push({ method, ...params });
    if (method === "sessions.usage") return { sessions: this.sessions ?? [{ key: params.key, usage: usage(50) }] } as T;
    if (method === "chat.history") {
      const pages = this.histories.get(params.sessionKey!) ?? [[]];
      const index = Number(params.cursor ?? 0);
      return { messages: pages[index] ?? [], olderCursor: index + 1 < pages.length ? String(index + 1) : undefined } as T;
    }
    return {} as T;
  }
  async send(input: Submission) { return { runId: input.idempotencyKey, status: "started" }; }
  async recoverHistory(): Promise<HistoryPage> { return { messages: [] }; }
  async abort() { return { aborted: true }; }
}

async function fixture() {
  const store = new WorkbenchStore(":memory:");
  const bot = store.createBot({ name: "Synthetic Bot" });
  const conversation = store.privateConversation(bot.id);
  const kernel = new UsageKernel();
  const service = new WorkbenchService(store, kernel);
  const token = "synthetic-usage-test-token-at-least-32-characters";
  const nativeToken = "synthetic-native-usage-token-at-least-32-characters";
  const api = createWorkbenchApi({ service, token, nativeToolToken: nativeToken });
  const origin = await api.listen();
  const addRun = (id: string, startedAt: number, endedAt?: number, conversationId = conversation.id) => {
    const task: Task = {
      id: `task-${id}`, botId: bot.id, conversationId, reportConversationId: conversationId,
      title: "Synthetic task", status: endedAt === undefined ? "running" : "completed",
      createdAt: startedAt, updatedAt: endedAt ?? startedAt,
    };
    store.put("tasks", task);
    const run: Run = {
      id, taskId: task.id, sessionKey: store.engineSessionKey(conversationId, bot.id),
      generation: 1, state: task.status, lastSequence: 0, createdAt: startedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
    };
    store.put("runs", run);
    return run;
  };
  const read = async (conversationId = conversation.id) => {
    const response = await fetch(`${origin}/api/usage?botId=${bot.id}&conversationId=${conversationId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    return await response.json() as {
      latestRun: { id: string; status: string } | null;
      latestCalls: (ReturnType<typeof usage> & { generationDurationMs?: number })[];
      latestModelRequestDurationMs: number | null;
    };
  };
  const record = (input: unknown, credential = nativeToken) => fetch(`${origin}/api/kernel/model-usage`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const close = async () => { await api.close(); service.detach(); store.close(); };
  return { store, bot, conversation, kernel, addRun, read, close, record, origin, token, nativeToken };
}

test("workspace usage scopes exact native session keys and counts runs, including archived Bot history", async () => {
  const f = await fixture();
  try {
    const space = f.store.createSpace("Project");
    const empty = f.store.createSpace("Empty");
    const first = f.store.createBot({ name: "First", spaceId: space.id });
    const second = f.store.createBot({ name: "Second", spaceId: space.id });
    const privateChat = f.store.privateConversation(first.id);
    const group = f.store.createConversation("group", [first.id, second.id], "Group");
    const keys = [
      f.store.engineSessionKey(privateChat.id, first.id),
      f.store.engineSessionKey(group.id, first.id),
      f.store.engineSessionKey(group.id, second.id),
    ];
    const unrelated = f.addRun("other-space", 1, 2);
    for (const [index, chat] of [privateChat, privateChat, group].entries()) {
      const taskId = chat === privateChat ? "private-task" : "group-task";
      f.store.put<Task>("tasks", {
        id: taskId, botId: first.id, conversationId: chat.id, reportConversationId: chat.id,
        title: "Task", status: "completed", createdAt: 1, updatedAt: 2,
      });
      f.store.put<Run>("runs", {
        id: `project-run-${index}`, taskId,
        sessionKey: f.store.engineSessionKey(chat.id, first.id),
        generation: 1, state: "completed", lastSequence: 0, createdAt: 1, endedAt: 2,
      });
    }
    f.kernel.sessions = [...keys, unrelated.sessionKey, `${keys[0]}-unrelated`]
      .map((key) => ({ key, usage: usage(50) }));
    const get = (query: string) => fetch(`${f.origin}/api/usage?${query}`, {
      headers: { authorization: `Bearer ${f.token}` },
    });
    const expected = { sessions: f.kernel.sessions.slice(0, 3), runs: 3 };
    const response = await get(`spaceId=${space.id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
    assert.deepEqual(f.kernel.reads.map((read) => read.method), ["sessions.usage"]);
    f.store.put("bots", { ...first, archivedAt: 3 });
    assert.deepEqual(await (await get(`spaceId=${space.id}`)).json(), expected);
    const reads = f.kernel.reads.length;
    assert.deepEqual(await (await get(`spaceId=${empty.id}`)).json(), { sessions: [], runs: 0 });
    assert.equal((await get("spaceId=missing")).status, 404);
    assert.equal((await get(`spaceId=${space.id}&conversationId=${privateChat.id}`)).status, 400);
    assert.equal(f.kernel.reads.length, reads);
  } finally { await f.close(); }
});

test("usage retains the preceding run during generation and approval waits, then updates on completion", async () => {
  const f = await fixture();
  try {
    const previous = f.addRun("previous", 1000, 2000);
    f.kernel.histories.set(previous.sessionKey, [[
      { role: "user", timestamp: 1000 },
      { role: "assistant", timestamp: 1500, usage: usage(20), durationMs: 400 },
      { role: "assistant", timestamp: 1900, usage: usage(30) },
    ]]);
    const before = await f.read();
    assert.equal(before.latestRun?.id, previous.id);
    const current = f.addRun("current", 3000);
    for (const state of ["running", "waiting"] as const) {
      f.store.put("runs", { ...current, state });
      assert.deepEqual(await f.read(), before);
    }
    f.store.put("runs", { ...current, state: "completed", endedAt: 5000 });
    f.kernel.histories.get(current.sessionKey)![0]!.push(
      { role: "assistant", timestamp: 4500, usage: usage(80) },
      { role: "assistant", timestamp: 6000, usage: usage(999) },
    );
    const after = await f.read();
    assert.equal(after.latestRun?.id, current.id);
    assert.equal(after.latestRun?.status, "completed");
    assert.deepEqual(after.latestCalls, [usage(80)]);
    assert.equal(after.latestCalls[0]?.generationDurationMs, undefined);
  } finally { await f.close(); }
});

test("first running turn has no previous reading and never borrows another conversation on the same Bot", async () => {
  const f = await fixture();
  try {
    const other = f.store.createConversation("private", [f.bot.id], "Other conversation");
    const previous = f.addRun("other", 1000, 2000, other.id);
    f.kernel.histories.set(previous.sessionKey, [[{ role: "assistant", timestamp: 1500, usage: usage(999) }]]);
    const current = f.addRun("first", 3000);
    const first = await f.read();
    assert.equal(first.latestRun?.id, current.id);
    assert.deepEqual(first.latestCalls, []);
    assert.equal(f.kernel.reads.some((read) => read.sessionKey === previous.sessionKey), false);
    assert.deepEqual((await f.read(other.id)).latestCalls, [usage(999)]);
    assert.deepEqual((await f.read()).latestCalls, []);
  } finally { await f.close(); }
});

test("usage finds the previous reading across native history pages and skips empty intervening runs", async () => {
  const f = await fixture();
  try {
    const previous = f.addRun("previous", 1000, 2000);
    f.addRun("empty", 3000, 3500);
    f.addRun("running", 4000);
    f.kernel.histories.set(previous.sessionKey, [
      [{ role: "user", timestamp: 4000 }],
      [{ role: "user", timestamp: 3000 }],
      [{ role: "user", timestamp: 1000 }, { role: "assistant", timestamp: 1500, usage: usage(20) }],
    ]);
    const response = await f.read();
    assert.equal(response.latestRun?.id, previous.id);
    assert.deepEqual(response.latestCalls, [usage(20)]);
    assert.ok(f.kernel.reads.some((read) => read.cursor === "2"));
    // Reusing a page within this read avoids rereading it for each empty run.
    assert.equal(f.kernel.reads.filter((read) => read.method === "chat.history").length, 3);
  } finally { await f.close(); }
});

test("zero native placeholders keep the previous reading, but explicitly available zero reports replace it", async () => {
  const f = await fixture();
  try {
    const previous = f.addRun("previous", 1000, 2000);
    f.kernel.histories.set(previous.sessionKey, [[
      { role: "assistant", timestamp: 1500, usage: usage(30) },
    ]]);
    const before = await f.read();
    f.addRun("current", 3000);
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    const messages = f.kernel.histories.get(previous.sessionKey)![0]!;
    messages.push({ role: "assistant", timestamp: 3100, usage: zero });
    assert.deepEqual(await f.read(), before);
    messages.push({ role: "assistant", timestamp: 3200, usage: { ...zero, usageReport: { state: "available" } } });
    const explicit = await f.read();
    assert.equal(explicit.latestRun?.id, "current");
    assert.deepEqual(explicit.latestCalls, [{ ...zero, usageReport: { state: "available" } }]);
    messages.push({ role: "assistant", timestamp: 3300, usage: { ...usage(80), usageReport: { state: "available" } } });
    assert.equal((await f.read()).latestCalls.length, 2);
  } finally { await f.close(); }
});

test("native model_call_ended forwards measured fields through authenticated HTTP into durable usage records", async () => {
  const f = await fixture();
  try {
    const previous = f.addRun("previous", 1000, 2000);
    f.kernel.histories.set(previous.sessionKey, [[{ role: "assistant", timestamp: 1500, usage: usage(30) }]]);
    type Event = { runId: string; callId: string; durationMs: number; outcome: string;
      sessionKey?: string; timeToFirstByteMs?: number };
    type Context = { agentId: string; sessionKey: string };
    let hook: (event: Event, context: Context) => Promise<void> = async () => { throw new Error("Hook not registered"); };
    const { registerModelUsage } = await import(new URL(
      "../../../packages/kernel-runtime/native-plugin/model-usage.mjs", import.meta.url).href);
    registerModelUsage({
      on(name: string, handler: typeof hook) { assert.equal(name, "model_call_ended"); hook = handler; },
    }, new URL("/api/kernel/conversation-context", f.origin), f.nativeToken);
    const context = { agentId: f.bot.agentId, sessionKey: previous.sessionKey };
    const event = { runId: previous.id, callId: "native-call-1", durationMs: 1234,
      outcome: "completed", timeToFirstByteMs: 456 };
    // Ended hooks are asynchronous and can arrive after product run completion.
    await hook(event, context);
    await hook(event, context);
    await hook({ ...event, callId: "native-call-2", durationMs: 500, timeToFirstByteMs: 200, outcome: "error" }, context);
    assert.equal((await f.read()).latestModelRequestDurationMs, 1734);
    const records = f.store.find<{ id: string; durationMs: number; timeToFirstByteMs: number }>(
      "settings", "taskId", previous.taskId);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((record) => [record.durationMs, record.timeToFirstByteMs]).sort(),
      [[1234, 456], [500, 200]]);
    const current = f.addRun("current", 3000);
    // The preceding reading includes its own measured request time.
    assert.equal((await f.read()).latestModelRequestDurationMs, 1734);
    await hook({ ...event, runId: current.id, callId: "current-call", durationMs: 800 }, context);
    f.kernel.histories.get(current.sessionKey)![0]!.push({ role: "assistant", timestamp: 3500, usage: usage(80) });
    assert.equal((await f.read()).latestModelRequestDurationMs, 800);
    const other = f.store.createConversation("private", [f.bot.id], "Other");
    assert.equal((await f.read(other.id)).latestModelRequestDurationMs, null);
  } finally { await f.close(); }
});

test("native model usage rejects wrong credentials, owner mismatch, malformed timing and conflicting replays", async () => {
  const f = await fixture();
  try {
    const run = f.addRun("current", 1000);
    const input = {
      agentId: f.bot.agentId, sessionKey: run.sessionKey, runId: run.id,
      callId: "native-call", durationMs: 1234, outcome: "completed",
    };
    assert.equal((await f.record(input, f.token)).status, 401);
    for (const changed of [
      { agentId: "other-agent" }, { sessionKey: "other-session" }, { runId: "unknown-run" },
      { durationMs: -1 }, { durationMs: null }, { durationMs: "1234" },
      { outcome: "unknown" }, { timeToFirstByteMs: -1 }, { timeToFirstByteMs: 2000 },
    ]) {
      assert.equal((await f.record({ ...input, ...changed })).status, 400);
    }
    assert.equal((await f.record(input)).status, 200);
    assert.equal((await f.record(input)).status, 200);
    assert.equal((await f.record({ ...input, durationMs: 500 })).status, 400);
    assert.equal(f.store.find("settings", "taskId", run.taskId).length, 1);
  } finally { await f.close(); }
});
