import assert from "node:assert/strict";
import test from "node:test";
import type { ServiceConnections, ServiceConnectionUpdate } from "../../kernel-runtime/src/connections.ts";
import { ConnectionCredentials } from "./connection-credentials.ts";
import type { Interaction, Run, Task } from "./contracts.ts";
import { WorkbenchStore } from "./store.ts";
import { SUPER_ADMIN_AGENT_ID } from "./system-policy.ts";

function fixture(agentId = SUPER_ADMIN_AGENT_ID) {
  const store = new WorkbenchStore(":memory:");
  const bot = store.createBot({ name: "Example", agentId });
  const conversation = store.privateConversation(bot.id);
  const { task, submission } = store.beginSubmission({
    submissionId: "credentials-test", botId: bot.id, conversationId: conversation.id, message: "Configure",
  });
  store.acceptSubmission(submission.id, "credentials-run", 1);
  store.put("runs", { ...store.get<Run>("runs", "credentials-run")!, state: "running" });
  store.put("tasks", { ...store.get<Task>("tasks", task.id)!, status: "running" });
  const authority = { agentId, runId: "credentials-run", sessionKey: submission.sessionKey };
  const writes: { name: string; input: ServiceConnectionUpdate }[] = [];
  let write: (name: string, input: ServiceConnectionUpdate) => Promise<void> = async (name, input) => { writes.push({ name, input }); };
  const connections: ServiceConnections = {
    list: async () => [{ name: "notes", transport: "stdio", enabled: true, auth: "none" }],
    add: async () => {}, remove: async () => {}, setEnabled: async () => {},
    update: (name, input) => write(name, input),
  };
  const credentials = new ConnectionCredentials(store, connections, () => 1);
  const request = { connection: "notes", target: "env", toolCallId: "tool-one",
    fields: [{ key: "EXAMPLE_CLIENT_ID", label: "Client ID" }, { key: "EXAMPLE_API_KEY", label: "API Key" }] };
  return { store, task, authority, request, writes, credentials, connections, setWrite: (next: typeof write) => { write = next; } };
}

test("generic card binds fields directly to one connection and never journals values", async () => {
  const f = fixture();
  try {
    const events: unknown[] = [];
    f.store.on("event", (event) => events.push(event));
    const prompt = await f.credentials.request(f.authority, f.request);
    assert.equal(f.store.get<Task>("tasks", f.task.id)?.status, "waiting");
    assert.deepEqual(await f.credentials.request(f.authority, f.request), prompt);
    const values = { EXAMPLE_CLIENT_ID: "fake-client", EXAMPLE_API_KEY: "fake-sensitive-value" };
    await assert.rejects(f.credentials.resolve(prompt.id, "wrong-task", { values }), /不属于/);
    await assert.rejects(f.credentials.resolve(prompt.id, f.task.id, { values: { ...values, EXTRA: "extra" } }), /全部/);
    const saved = await f.credentials.resolve(prompt.id, f.task.id, { values });
    assert.equal(saved.status, "answered");
    assert.deepEqual(f.writes, [{ name: "notes", input: { env: values } }]);
    assert.equal(f.store.get<Task>("tasks", f.task.id)?.status, "running");
    assert.deepEqual(f.credentials.status(f.authority, prompt.id), { id: prompt.id, status: "answered" });
    await f.credentials.resolve(prompt.id, f.task.id, { values: { EXAMPLE_API_KEY: "replacement" } });
    assert.equal(f.writes.length, 1);
    const persisted = JSON.stringify([f.store.snapshot(), events, f.store.list("settings"), f.store.list("interactions")]);
    assert.ok(!persisted.includes("fake-sensitive-value"));
    assert.ok(!persisted.includes("fake-client"));
  } finally { f.store.close(); }
});

test("ordinary bots, stale runs, audit routines, invalid targets and duplicate labels cannot create cards", async () => {
  const ordinary = fixture("ordinary");
  await assert.rejects(ordinary.credentials.request(ordinary.authority, ordinary.request), /超级管理员/);
  ordinary.store.close();
  const f = fixture();
  try {
    await assert.rejects(f.credentials.request({ ...f.authority, runId: "wrong" }, f.request), /authority/);
    for (const change of [
      { connection: "missing" }, { target: "headers" }, { fields: [{ key: "__proto__", label: "Key" }] },
      { fields: [{ key: "ONE", label: "Key" }, { key: "TWO", label: "key" }] },
      { fields: [{ key: "ONE", label: "Key", value: "forbidden" }] },
    ]) await assert.rejects(f.credentials.request(f.authority, { ...f.request, ...change }));
    f.store.put("tasks", { ...f.store.get<Task>("tasks", f.task.id)!, routine: { id: "audit" } });
    await assert.rejects(f.credentials.request(f.authority, f.request), /超级管理员/);
    assert.equal(f.store.list("interactions").length, 0);
    assert.equal(f.writes.length, 0);
  } finally { f.store.close(); }
});

test("failure is redacted and retryable, concurrent submit and cancellation cannot race a write", async () => {
  const f = fixture();
  try {
    const { id } = await f.credentials.request(f.authority, f.request);
    const values = { EXAMPLE_CLIENT_ID: "fake-client", EXAMPLE_API_KEY: "fake-sensitive-value" };
    f.setWrite(async () => { throw new Error(values.EXAMPLE_API_KEY); });
    await assert.rejects(f.credentials.resolve(id, f.task.id, { values }), (error: Error) =>
      !error.message.includes(values.EXAMPLE_API_KEY) && error.message.includes("未确认"));
    assert.equal(f.store.get<Interaction>("interactions", id)?.status, "pending");
    let finish!: () => void;
    f.setWrite(() => new Promise<void>((resolve) => { finish = resolve; }));
    const saving = f.credentials.resolve(id, f.task.id, { values });
    await assert.rejects(f.credentials.resolve(id, f.task.id, { cancel: true }), /正在保存/);
    await assert.rejects(f.credentials.resolve(id, f.task.id, { values }), /正在保存/);
    finish();
    assert.equal((await saving).status, "answered");
  } finally { f.store.close(); }
});

test("cancel and expiry resume the waiting tool without saving; stopped tasks cannot submit", async () => {
  const f = fixture();
  try {
    const first = await f.credentials.request(f.authority, f.request);
    assert.equal((await f.credentials.resolve(first.id, f.task.id, { cancel: true })).status, "cancelled");
    const second = await f.credentials.request(f.authority, { ...f.request, toolCallId: "two" });
    f.store.put("interactions", { ...f.store.get<Interaction>("interactions", second.id)!, expiresAt: 1 });
    assert.equal(f.credentials.status(f.authority, second.id).status, "expired");
    assert.equal(f.store.get<Task>("tasks", f.task.id)?.status, "running");
    const third = await f.credentials.request(f.authority, { ...f.request, toolCallId: "three" });
    f.store.put("tasks", { ...f.store.get<Task>("tasks", f.task.id)!, status: "stopping" });
    await assert.rejects(f.credentials.resolve(third.id, f.task.id, { values: {} }), /失效/);
    assert.equal(f.writes.length, 0);
  } finally { f.store.close(); }
});
