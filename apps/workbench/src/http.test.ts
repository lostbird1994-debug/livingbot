import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import type { HistoryPage, Submission } from "../../../packages/kernel-runtime/src/contracts.ts";
import { WorkbenchService } from "../../../packages/workbench/src/service.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import { createWorkbenchApi } from "./http.ts";
import type { CapabilityProvider } from "../../../packages/kernel-runtime/src/capabilities.ts";
import { OpenClawMemory } from "../../../packages/kernel-runtime/src/memory.ts";
import type { MemoryProvider } from "../../../packages/kernel-runtime/src/memory.ts";
import type { Bot, Conversation, Run, ScratchpadItem } from "../../../packages/workbench/src/contracts.ts";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Files } from "../../../packages/workbench/src/files.ts";
import { Workspaces } from "../../../packages/workbench/src/workspaces.ts";
import type { ServiceConnections } from "../../../packages/kernel-runtime/src/connections.ts";
import type { NativeRoutine, RoutineProvider } from "../../../packages/kernel-runtime/src/routines.ts";
import type { NativeContextPreview } from "../../../packages/kernel-runtime/src/context-preview.ts";
import { Marketplace } from "../../../packages/workbench/src/marketplace.ts";

class TestKernel extends EventEmitter {
  generation = 1;
  phase = "ready";
  async request<T = unknown>(method: string): Promise<T> {
    return (method === "question.list" ? { questions: [] } : []) as T;
  }
  async send(input: Submission) { return { runId: input.idempotencyKey, status: "started" }; }
  async recoverHistory(): Promise<HistoryPage> { return { messages: [] }; }
  async abort() { return { aborted: true }; }
}

test("first workspace assistant opens once, without a visible synthetic user prompt", async () => {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp("local/test-fixtures/chief-intro-");
  const store = new WorkbenchStore(":memory:");
  const kernel = new TestKernel();
  const sent: Submission[] = [];
  kernel.send = async (input) => { sent.push(input); return { runId: input.idempotencyKey, status: "started" }; };
  const service = new WorkbenchService(store, kernel);
  const api = createWorkbenchApi({
    service, token: "synthetic-test-token-with-at-least-32-characters",
    botWorkspaces: new Workspaces(resolve(root)),
    agentRegistration: { async ensure() {} },
    modelSettings: {
      async read() { return { configured: true, id: "example", baseUrl: "https://example.invalid", api: "openai-completions",
        model: "example", hasKey: true, input: ["text"] }; },
      async save() { throw new Error("Not used"); },
    },
  });
  const origin = await api.listen();
  const headers = { authorization: "Bearer synthetic-test-token-with-at-least-32-characters", "content-type": "application/json" };
  try {
    const input = { name: "Chief", spawnKey: "onboarding:first" };
    const post = () => fetch(`${origin}/api/bots`, { method: "POST", headers, body: JSON.stringify(input) });
    const first = await post();
    assert.equal(first.status, 201);
    const bot = await first.json() as Bot;
    const retry = await post();
    assert.equal(retry.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(store.messages(store.privateConversation(bot.id).id).filter((message) => message.role === "user").length, 0);
    assert.equal(store.list<{ hiddenInput?: boolean }>("submissions")[0].hiddenInput, true);
  } finally { await api.close(); service.detach(); store.close(); }
});

test("Bot creation registers the native workspace once and archive retains its private history", async () => {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp("local/test-fixtures/bot-lifecycle-");
  const store = new WorkbenchStore(":memory:");
  const kernel = new TestKernel();
  const nativeWrites: unknown[] = [];
  kernel.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "agents.files.set") nativeWrites.push(params);
    return {} as T;
  };
  const service = new WorkbenchService(store, kernel);
  const registered: { agentId: string; workspace: string }[] = [];
  const api = createWorkbenchApi({
    service, token: "synthetic-test-token-with-at-least-32-characters",
    botWorkspaces: new Workspaces(resolve(root, "workspaces")),
    agentRegistration: { async ensure(input) { registered.push(input); } },
  });
  const origin = await api.listen();
  const headers = { authorization: "Bearer synthetic-test-token-with-at-least-32-characters", "content-type": "application/json" };
  const post = (path: string, input: unknown = {}) =>
    fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(input) });
  try {
    const input = { name: "Synthetic Bot", identity: "Synthetic persona", spawnKey: "one-created-bot" };
    const created = await post("/api/bots", input);
    assert.equal(created.status, 201);
    const bot = await created.json() as Bot;
    assert.equal(registered.length, 1);
    assert.equal(nativeWrites.length, 1);
    assert.equal(bot.identity, input.identity);
    const retry = await (await post("/api/bots", input)).json() as Bot;
    assert.equal(retry.id, bot.id);
    assert.equal(registered.length, 1);
    const conversation = store.privateConversation(bot.id);
    const archived = await (await post(`/api/bots/${bot.id}/archive`)).json() as Bot;
    assert.ok(archived.archivedAt);
    assert.equal(store.privateConversation(bot.id).id, conversation.id);
    assert.throws(() => store.engineSessionKey(conversation.id, bot.id), /已归档/);
    const restored = await (await post(`/api/bots/${bot.id}/restore`)).json() as Bot;
    assert.equal(restored.archivedAt, undefined);
    assert.equal(store.engineSessionKey(conversation.id, bot.id).length > 0, true);
    assert.equal(store.privateConversation(bot.id).id, conversation.id);
    assert.equal(registered.length, 1);
  } finally { await api.close(); service.detach(); store.close(); }
});

async function fixture(capabilityProvider?: CapabilityProvider, nativeToolToken?: string, workspaceRoot?: string, memoryProvider?: MemoryProvider, connections?: ServiceConnections, routineProvider?: RoutineProvider, nativeContextPreview?: (agentId: string) => Promise<NativeContextPreview>) {
  const store = new WorkbenchStore(":memory:");
  const bot = store.createBot({ name: "Example Bot" });
  const conversation = store.privateConversation(bot.id);
  const kernel = new TestKernel();
  const service = new WorkbenchService(store, kernel, capabilityProvider,
    workspaceRoot ? new Files(store, new Workspaces(workspaceRoot)) : undefined, memoryProvider, routineProvider);
  const token = randomBytes(32).toString("hex");
  const api = createWorkbenchApi({
    service, token, nativeToolToken, connections, nativeContextPreview,
    ...(workspaceRoot ? { botWorkspaces: new Workspaces(workspaceRoot) } : {}),
  });
  const url = await api.listen();
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return { store, service, kernel, bot, conversation, api, url, headers };
}

test("interrupted reply history, search and reactions address the displayed continuation", async () => {
  const f = await fixture();
  try {
    const input = { botId: f.bot.id, conversationId: f.conversation.id };
    await f.service.submit({ ...input, submissionId: "first", message: "START" });
    const sessionKey = f.store.engineSessionKey(f.conversation.id, f.bot.id);
    const stream = (seq: number, text: string) => f.kernel.emit("observation", {
      type: "frame", generation: 1, frame: { event: "agent", payload: {
        runId: "first", sessionKey, seq, stream: "assistant", data: { itemId: "answer", text },
      } },
    });
    stream(1, "BEFORE");
    await f.service.submit({ ...input, submissionId: "second", message: "INTERRUPT" });
    stream(2, "BEFOREAFTER");
    const history = await (await fetch(`${f.url}/api/conversations/${f.conversation.id}/messages`, { headers: f.headers })).json();
    assert.deepEqual(history.messages.map((message: { blocks: { kind: string; text?: string }[] }) =>
      message.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("")), ["START", "BEFORE", "INTERRUPT", "AFTER"]);
    const partId = history.messages[3].id;
    const search = await (await fetch(`${f.url}/api/search?q=AFTER&conversationId=${f.conversation.id}`, { headers: f.headers })).json();
    assert.equal(search.hits[0].messageId, partId);
    assert.equal(search.hits[0].seq, 3);
    const reaction = await fetch(`${f.url}/api/messages/${encodeURIComponent(partId)}/reactions`, {
      method: "POST", headers: f.headers, body: JSON.stringify({ reaction: "👍", clientNonce: "reaction-1" }),
    });
    assert.equal(reaction.status, 200);
    assert.equal(f.store.messages(f.conversation.id).at(-1)?.replyToMessageId, partId);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("approval settings require user credentials and reject invalid modes and scopes before native writes", async () => {
  const f = await fixture();
  const writes: string[] = [];
  f.kernel.request = async <T>(method: string): Promise<T> => {
    if (method === "config.get") return { config: { tools: { exec: { mode: "full" } } } } as T;
    if (method === "exec.approvals.get") return {
      hash: "synthetic", file: { version: 1, defaults: { security: "full", ask: "off" } },
    } as T;
    writes.push(method);
    return {} as T;
  };
  try {
    const read = (path: string, headers = f.headers) => fetch(`${f.url}${path}`, { headers });
    const post = (path: string, input: unknown) => fetch(`${f.url}${path}`, {
      method: "POST", headers: f.headers, body: JSON.stringify(input),
    });
    assert.equal((await read("/api/approval-settings", {} as typeof f.headers)).status, 401);
    const settings = await read("/api/approval-settings");
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).mode, "never");
    assert.deepEqual(await (await read("/api/approval-rules")).json(), []);
    assert.equal((await post("/api/approval-settings", { mode: "invalid" })).status, 400);
    assert.equal((await post("/api/approval-settings", { scope: "space", mode: "ask" })).status, 400);
    assert.equal((await post("/api/approval-settings?scope=space", { mode: "ask" })).status, 400);
    assert.equal((await post("/api/approval-rules/remove", { id: "unknown" })).status, 400);
    assert.deepEqual(writes, []);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("approval policy changes cannot invalidate active work; reads and individual decisions remain available", async () => {
  const f = await fixture();
  const calls: string[] = [];
  f.kernel.request = async <T>(method: string): Promise<T> => {
    calls.push(method);
    if (method === "config.get") return { config: { tools: { exec: { mode: "auto" } } } } as T;
    if (method === "exec.approvals.get") return { file: { version: 1 } } as T;
    throw new Error(`Unexpected native call: ${method}`);
  };
  const resolutions: unknown[] = [];
  f.service.interactions.resolve = async (id, taskId, answer) => {
    resolutions.push({ id, taskId, answer });
    return { id, taskId, status: "answered" } as any;
  };
  const post = (path: string, input: unknown) => fetch(`${f.url}${path}`, {
    method: "POST", headers: f.headers, body: JSON.stringify(input),
  });
  try {
    for (const status of ["queued", "running", "waiting", "stopping"]) {
      f.store.put("tasks", { id: "busy-task", status });
      const response = await post("/api/approval-settings", { mode: "auto" });
      assert.equal(response.status, 409, status);
      assert.match((await response.json()).error, /等待当前工作结束/);
    }
    f.store.put("tasks", { id: "busy-task", status: "completed", processes: [{ status: "running" }] });
    assert.equal((await post("/api/approval-settings", { mode: "never" })).status, 409);
    assert.deepEqual(calls, []);
    assert.equal((await fetch(`${f.url}/api/approval-settings`, { headers: f.headers })).status, 200);
    for (const decision of ["allow-once", "deny"]) {
      const input = { decision, resolutionId: `synthetic-${decision}` };
      assert.equal((await post("/api/tasks/busy-task/interactions/approval%3Aexample/resolve", input)).status, 200);
      assert.deepEqual(resolutions.at(-1), { id: "approval:example", taskId: "busy-task", answer: input });
    }
    assert.ok((calls as string[]).every((method) => method.endsWith(".get")));
    // Once all work has ended, the request reaches native configuration again.
    // This fixture has no hashes, so the adapter rejects it before any write.
    f.store.put("tasks", { id: "busy-task", status: "completed", processes: [{ status: "completed" }] });
    const idle = await post("/api/approval-settings", { mode: "auto" });
    assert.equal(idle.status, 400);
    assert.match((await idle.json()).error, /原生审批配置版本不可用/);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("local spaces persist, isolate navigation and preserve owned Bot data when removed", async () => {
  const f = await fixture();
  try {
    const post = (path: string, input: unknown) => fetch(`${f.url}${path}`, {
      method: "POST", headers: f.headers, body: JSON.stringify(input),
    });
    const createdResponse = await post("/api/spaces", { name: "  Project  " });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { id: string; name: string };
    assert.equal(created.name, "Project");
    const second = f.store.createBot({ name: "Project Bot", agentId: "project-bot", spaceId: created.id });
    const group = f.store.createConversation("group", [second.id], "Project chat");
    const savedMessage = {
      id: "retained-space-message", conversationId: group.id, botId: second.id, role: "assistant" as const,
      blocks: [{ id: "retained-text", kind: "text" as const, text: "Retained history" }],
      final: true, createdAt: 1, updatedAt: 1,
    };
    f.store.put("messages", savedMessage);
    const spaces = await (await fetch(`${f.url}/api/spaces`, { headers: f.headers })).json() as {
      spaces: { id: string; bots: Bot[]; groups: Conversation[] }[];
    };
    assert.deepEqual(spaces.spaces.map((space) => space.id), ["local", created.id]);
    assert.deepEqual(spaces.spaces[0]!.bots.map((bot) => bot.id), [f.bot.id]);
    assert.deepEqual(spaces.spaces[1]!.bots.map((bot) => bot.id), [second.id]);
    assert.deepEqual(spaces.spaces[1]!.groups.map((chat) => chat.id), [group.id]);

    const renamed = await fetch(`${f.url}/api/spaces/${created.id}`, {
      method: "PATCH", headers: f.headers, body: JSON.stringify({ name: "Renamed" }),
    });
    assert.equal((await renamed.json()).name, "Renamed");
    const removed = await fetch(`${f.url}/api/spaces/${created.id}`, { method: "DELETE", headers: f.headers });
    assert.equal(removed.status, 200);
    assert.equal(f.store.spaceIdForBot(second.id), "local");
    assert.ok(f.store.get<Bot>("bots", second.id)?.archivedAt);
    assert.equal(f.store.get<Bot>("bots", f.bot.id)?.archivedAt, undefined);
    assert.equal(f.store.get<Conversation>("conversations", group.id)?.spaceId, "local");
    assert.deepEqual(f.store.messages(group.id), [savedMessage]);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("space removal pauses native schedules, cancels work and retains data; pause failure is retryable", async () => {
  const native = new Map<string, NativeRoutine>();
  let failPause = true;
  const provider: RoutineProvider = {
    async create(definition) {
      const job = { ...definition, id: definition.declarationKey, enabled: true, revision: "r1" };
      native.set(job.id, job);
      return job;
    },
    async get(id) { return native.get(id)!; },
    async setEnabled(id, revision, enabled) {
      if (failPause) throw new Error("Synthetic pause failure");
      const job = native.get(id)!;
      assert.equal(revision, job.revision);
      const updated = { ...job, enabled, revision: "r2" };
      native.set(id, updated);
      return updated;
    },
    async update() { throw new Error("Unused"); },
    async history() { return { entries: [], hasMore: false }; },
    async remove() { throw new Error("Schedules must be preserved"); },
    async runNow() { throw new Error("Schedules must not run"); },
  };
  const f = await fixture(undefined, undefined, undefined, undefined, undefined, provider);
  try {
    const space = f.store.createSpace("Disposable space");
    const bot = f.store.createBot({ name: "Retained Bot", spaceId: space.id });
    const chat = f.store.privateConversation(bot.id);
    const scheduled = await f.service.routines!.create({
      id: "retained-routine", botId: bot.id, conversationId: chat.id,
      name: "Retained routine", message: "Synthetic", schedule: { kind: "every", everyMs: 60_000 },
    });
    const other = await f.service.routines!.create({
      id: "other-routine", botId: f.bot.id, conversationId: f.conversation.id,
      name: "Unrelated routine", message: "Synthetic", schedule: { kind: "every", everyMs: 60_000 },
    });
    const task = await f.service.submit({
      submissionId: "space-removal-work", botId: bot.id, conversationId: chat.id, message: "Synthetic",
    });
    const remove = () => fetch(`${f.url}/api/spaces/${space.id}`, { method: "DELETE", headers: f.headers });
    assert.equal((await remove()).status, 400);
    assert.ok(f.store.get("spaces", space.id));
    assert.equal(f.store.spaceIdForBot(bot.id), space.id);
    assert.ok(f.store.get<Bot>("bots", bot.id)?.archivedAt);
    assert.equal(f.store.get<{ status: string }>("tasks", task.id)?.status, "stopping");
    failPause = false;
    assert.equal((await remove()).status, 200);
    assert.equal(f.store.spaceIdForBot(bot.id), "local");
    assert.equal(f.store.get<Conversation>("conversations", chat.id)?.spaceId, "local");
    assert.equal(native.get(scheduled.nativeId!)?.enabled, false);
    assert.equal(native.get(other.nativeId!)?.enabled, true);
    assert.ok(f.store.messages(chat.id).length);
    const restored = await fetch(`${f.url}/api/bots/${bot.id}/restore`, {
      method: "POST", headers: f.headers, body: "{}",
    });
    assert.equal(restored.status, 200);
    assert.equal(f.store.get<Bot>("bots", bot.id)?.archivedAt, undefined);
    assert.equal(native.get(scheduled.nativeId!)?.enabled, false);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("Bot edits reject model overrides without mutating the saved Bot", async () => {
  const f = await fixture();
  try {
    for (const field of ["modelProvider", "modelId", "thinkingLevel"]) {
      const response = await fetch(`${f.url}/api/bots/${f.bot.id}`, {
        method: "PATCH", headers: f.headers,
        body: JSON.stringify({ name: "Changed", [field]: field === "thinkingLevel" ? "high" : "example" }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "本机模型由全局设置统一管理");
      assert.equal(f.store.get<Bot>("bots", f.bot.id)?.name, f.bot.name);
    }
    const response = await fetch(`${f.url}/api/bots/${f.bot.id}`, {
      method: "PATCH", headers: f.headers,
      body: JSON.stringify({ name: "Renamed", modelProvider: null, modelId: null, thinkingLevel: null }),
    });
    assert.equal(response.status, 200);
    assert.equal(f.store.get<Bot>("bots", f.bot.id)?.name, "Renamed");
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("loaded context is authenticated, Bot-scoped and returned from the native preview", async () => {
  const nativeContext: NativeContextPreview = {
    engine: "openclaw",
    agentId: "native-example",
    workspace: "/synthetic/workspaces/native-example",
    budgets: { document: 12000, total: 60000 },
    documents: [{
      path: "/synthetic/workspaces/native-example/AGENTS.md",
      name: "AGENTS.md",
      scope: "bot",
      content: "full",
      excerpt: "loaded by OpenClaw",
      totalChars: 4,
      shownChars: 18,
    }],
  };
  let previewedAgentId: string | undefined;
  const preview = async (agentId: string) => {
    previewedAgentId = agentId;
    return nativeContext;
  };
  const f = await fixture(undefined, undefined, undefined, undefined, undefined, undefined, preview);
  try {
    const url = `${f.url}/api/bots/${f.bot.id}/loaded-context`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: f.headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { nativeContext, scratchpad: "" });
    assert.equal(previewedAgentId, f.bot.agentId);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("native product guidance injects private to-dos and the scratchpad tool stays Bot-private", async () => {
  const nativeToolToken = randomBytes(32).toString("hex");
  const f = await fixture(undefined, nativeToolToken);
  try {
    const sessionKey = f.store.engineSessionKey(f.conversation.id, f.bot.id);
    const postNative = (path: string, body: unknown) => fetch(`${f.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${nativeToolToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body as object, agentId: f.bot.agentId, sessionKey, runId: "run-test" }),
    });
    const added = await postNative("/api/kernel/scratchpad", { operation: "add", title: "Finish the report" });
    assert.equal(added.status, 200, await added.text());
    const guidance = await postNative("/api/kernel/product-guidance", {});
    const guidedContext = (await guidance.json()).context;
    assert.match(guidedContext, /Finish the report/);
    assert.match(guidedContext, /livingbot_deliver_file/);
    const items = await postNative("/api/kernel/scratchpad", { operation: "list" });
    assert.equal((await items.json()).items.length, 1);
    const preference = await fetch(`${f.url}/api/preferences`, {
      method: "POST",
      headers: { ...f.headers, "content-type": "application/json" },
      body: JSON.stringify({ "livingbot.conclusionFirst": "off" }),
    });
    assert.equal(preference.status, 200);
    const optedOut = await postNative("/api/kernel/product-guidance", {});
    const optedOutContext = (await optedOut.json()).context;
    assert.doesNotMatch(optedOutContext, /回复规范/);
    assert.match(optedOutContext, /livingbot_deliver_file/);
    const group = f.store.createConversation("group", [f.bot.id], "Synthetic group");
    const groupSessionKey = f.store.engineSessionKey(group.id, f.bot.id);
    const groupCall = await fetch(`${f.url}/api/kernel/product-guidance`, {
      method: "POST",
      headers: { authorization: `Bearer ${nativeToolToken}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: f.bot.agentId, sessionKey: groupSessionKey, runId: "run-group" }),
    });
    assert.doesNotMatch((await groupCall.json()).context, /Finish the report/);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("local API authenticates, rejects foreign origins and hostile Host headers", async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.url}/api/snapshot`)).status, 401);
    assert.equal((await fetch(`${f.url}/api/snapshot`, { headers: { ...f.headers, origin: "https://untrusted.example" } })).status, 403);
    const hostileHost = await new Promise<number | undefined>((resolve, reject) => {
      const call = request(`${f.url}/api/snapshot`, { headers: { ...f.headers, host: "untrusted.example" } }, (response) => {
        response.resume(); resolve(response.statusCode);
      });
      call.on("error", reject); call.end();
    });
    assert.equal(hostileHost, 403);
    const snapshot = await fetch(`${f.url}/api/snapshot`, { headers: f.headers });
    assert.equal(snapshot.status, 200);
    assert.equal((await snapshot.json()).bots[0].name, "Example Bot");
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("workspace file browsing reads only the selected Bot's local workspace", async () => {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp("local/test-fixtures/workspace-api-");
  const f = await fixture(undefined, undefined, resolve(root, "workspaces"));
  try {
    const path = await new Workspaces(resolve(root, "workspaces")).write(
      f.bot.agentId, "projects", "demo/result.txt", "Synthetic result",
    );
    const listing = await fetch(
      `${f.url}/api/bots/${f.bot.id}/workspace-files?path=projects/demo`,
      { headers: f.headers },
    );
    assert.equal(listing.status, 200);
    assert.deepEqual(await listing.json(), [
      { path: "projects/demo/result.txt", kind: "file", size: 16 },
    ]);
    const other = f.store.createBot({ name: "Other Bot", agentId: "other" });
    assert.deepEqual(await (await fetch(`${f.url}/api/bots/${other.id}/workspace-files?path=projects/demo`, {
      headers: f.headers,
    })).json(), []);
    assert.ok(path.endsWith("/projects/demo/result.txt"));
    assert.equal((await fetch(`${f.url}/api/bots/${f.bot.id}/workspace-files?path=../outside`, {
      headers: f.headers,
    })).status, 400);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("local to-dos persist per Bot, update status and hide removals without deleting records", async () => {
  const f = await fixture();
  try {
    const other = f.store.createBot({ name: "Other Bot" });
    const post = (path: string, input: unknown) => fetch(`${f.url}${path}`, {
      method: "POST", headers: f.headers, body: JSON.stringify(input),
    });
    const createdResponse = await post("/api/scratchpad", { botId: f.bot.id, title: "  Review the plan  " });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as ScratchpadItem;
    assert.equal(created.title, "Review the plan");
    assert.deepEqual(await (await fetch(`${f.url}/api/scratchpad?botId=${f.bot.id}`, { headers: f.headers })).json(), [created]);
    assert.deepEqual(await (await fetch(`${f.url}/api/scratchpad?botId=${other.id}`, { headers: f.headers })).json(), []);
    const updated = await (await fetch(`${f.url}/api/scratchpad/${created.id}/update`, {
      method: "PATCH", headers: f.headers, body: JSON.stringify({ status: "done" }),
    })).json() as ScratchpadItem;
    assert.equal(updated.status, "done");
    assert.deepEqual(await (await fetch(`${f.url}/api/scratchpad?botId=${f.bot.id}`, { headers: f.headers })).json(), []);
    assert.deepEqual(await (await fetch(`${f.url}/api/scratchpad?botId=${f.bot.id}&includeDone=1`, { headers: f.headers })).json(), [updated]);
    assert.equal((await fetch(`${f.url}/api/scratchpad/${created.id}/remove`, {
      method: "DELETE", headers: f.headers,
    })).status, 200);
    assert.equal(f.store.get<ScratchpadItem>("scratchpad", created.id)?.removedAt !== undefined, true);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("group editing preserves membership rules, cancels removed recipients and archives without losing history", async () => {
  const f = await fixture();
  try {
    const second = f.store.createBot({ name: "Second" });
    const third = f.store.createBot({ name: "Third" });
    const group = f.store.createConversation("group", [f.bot.id, second.id], "Project");
    const task = await f.service.submit({
      submissionId: "group-member-running", conversationId: group.id, botId: second.id, message: "Working",
    });
    const edit = (body: unknown) => fetch(`${f.url}/api/conversations/${group.id}`, {
      method: "PATCH", headers: f.headers, body: JSON.stringify(body),
    });
    assert.equal((await edit({ botIds: [f.bot.id, "unknown-bot"] })).status, 400);
    assert.equal((await edit({ botIds: [f.bot.id, third.id], expectedBotIds: [f.bot.id] })).status, 409);
    assert.equal((await edit({ botIds: [f.bot.id] })).status, 400);
    const section = f.store.createBotSection("Project");
    const response = await edit({
      title: "Renamed", botIds: [f.bot.id, third.id], expectedBotIds: group.botIds,
      pinned: true, sectionId: section.id,
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).botIds, [f.bot.id, third.id]);
    assert.equal(f.store.get<{ status: string }>("tasks", task.id)?.status, "stopping");
    const archived = await fetch(`${f.url}/api/conversations/${group.id}`, { method: "DELETE", headers: f.headers });
    assert.equal(archived.status, 200);
    assert.equal(f.store.messages(group.id).length, 1);
    assert.throws(() => f.store.beginGroup({
      submissionId: "archived-input", conversationId: group.id, botIds: [f.bot.id], message: "No",
    }));
    assert.equal((await edit({ archived: false })).status, 200);
    assert.equal(f.store.get<{ archivedAt?: number }>("conversations", group.id)?.archivedAt, undefined);
    assert.equal((await fetch(`${f.url}/api/conversations/${f.conversation.id}`, {
      method: "DELETE", headers: f.headers,
    })).status, 404);
    assert.equal(f.store.messages(group.id).length, 1);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("only the user can share selected messages with a group and revoke future recall", async () => {
  const nativeToken = randomBytes(32).toString("hex");
  const f = await fixture(undefined, nativeToken);
  try {
    const other = f.store.createBot({ name: "Other" });
    const group = f.store.createConversation("group", [other.id], "Shared project");
    const input = {
      id: "stable-http-sharing-identity", sourceConversationId: f.conversation.id,
      destinationConversationId: group.id, messageIds: ["selected-private-message"],
    };
    f.store.put("messages", {
      id: input.messageIds[0], conversationId: f.conversation.id, role: "user",
      blocks: [{ id: "text", kind: "text", text: "Selected excerpt" }],
      final: true, createdAt: 1, updatedAt: 1,
    });
    const path = "/api/context-shares";
    const post = (value: unknown, headers = f.headers) => fetch(f.url + path, {
      method: "POST", headers, body: JSON.stringify(value),
    });
    assert.equal((await post(input, { ...f.headers, authorization: `Bearer ${nativeToken}` })).status, 401);
    assert.equal((await post({ ...input, destinationConversationId: f.conversation.id })).status, 400);
    assert.equal((await post({ ...input, messageIds: ["unowned-message"] })).status, 400);
    assert.equal((await post(input)).status, 201);
    assert.equal((await post(input)).status, 201);
    assert.equal(f.store.list("contextShares").length, 1);
    const recalled = () => f.service.context.candidates({ botId: other.id, destinationConversationId: group.id });
    assert.deepEqual(recalled().map((passage) => passage.text), ["Selected excerpt"]);
    const list = () => fetch(f.url + path + `?sourceConversationId=${f.conversation.id}`, { headers: f.headers });
    assert.equal((await (await list()).json()).shares.length, 1);
    const revokePath = `${f.url}${path}/${input.id}/revoke`;
    assert.equal((await fetch(revokePath, { method: "POST", headers: { ...f.headers, authorization: `Bearer ${nativeToken}` }, body: "{}" })).status, 401);
    assert.equal((await fetch(revokePath, { method: "POST", headers: f.headers, body: "{}" })).status, 200);
    assert.equal((await post(input)).status, 201);
    assert.deepEqual(recalled(), []);
    assert.equal((await (await list()).json()).shares.length, 0);
    assert.equal(f.store.messages(f.conversation.id).length, 1);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("file batch endpoints require user authentication and validate bounded input", async () => {
  const nativeToken = randomBytes(32).toString("hex");
  const f = await fixture(undefined, nativeToken);
  const url = `${f.url}/api/file-batches`;
  const body = JSON.stringify({
    id: "file-batch-http-identity", botId: f.bot.id, conversationId: f.conversation.id,
    instruction: "Process files separately", attachmentIds: [],
  });
  try {
    assert.equal((await fetch(url, { method: "POST", body })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: {
      ...f.headers, authorization: `Bearer ${nativeToken}`,
    }, body })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: f.headers, body })).status, 400);
    assert.equal((await fetch(`${url}/unknown-batch/retry`, {
      method: "POST", headers: f.headers, body: JSON.stringify({ retryId: "file-batch-retry-http-identity" }),
    })).status, 400);
    assert.equal(f.store.snapshot().fileBatches.length, 0);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("widget reads require an authenticated saved message reference and retain its native session", async () => {
  const f = await fixture();
  const calls: unknown[] = [];
  f.kernel.request = async <T>(method: string, input?: unknown): Promise<T> => {
    calls.push({ method, input });
    return { html: "<html>synthetic preview</html>", sandboxPort: 1234 } as T;
  };
  f.store.put("messages", {
    id: "engine:preview", conversationId: f.conversation.id, botId: f.bot.id, role: "assistant",
    blocks: [{ id: "widget:cv_example", kind: "widget", title: "Example", docId: "cv_example", sessionKey: "owned-session" }],
    final: true, createdAt: 1, updatedAt: 1,
  });
  const path = "/api/messages/engine%3Apreview/widgets/widget%3Acv_example";
  try {
    assert.equal((await fetch(f.url + path)).status, 401);
    assert.equal((await fetch(f.url + path.replace("cv_example", "cv_foreign"), { headers: f.headers })).status, 404);
    assert.equal(calls.length, 0);
    const response = await fetch(f.url + path + "?docId=cv_foreign", { headers: f.headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { html: "<html>synthetic preview</html>" });
    assert.deepEqual(calls, [{
      method: "canvas.document.view", input: { docId: "cv_example", sessionKey: "owned-session" },
    }]);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("package preview, export and install endpoints require user credentials; reads do not publish Bots", async () => {
  const f = await fixture();
  const nativeToolToken = randomBytes(32).toString("hex");
  let reads = 0;
  const bundle = {
    format: "livingbot-package-v1", id: "example-bot", kind: "bot", name: "Example Bot",
    description: "Synthetic public package", author: "Example author", version: "1.0.0", license: "MIT",
    permissions: [], files: [{ path: "SOUL.md", text: "Synthetic public identity" }],
  };
  const marketplace = new Marketplace(f.store, { read: async () => {
    reads++;
    return { source: { repository: "example/bots", path: "livingbot.json", commit: "a".repeat(40), blob: "b".repeat(40) },
      bytes: Buffer.from(JSON.stringify(bundle)) };
  } });
  const api = createWorkbenchApi({ service: f.service, token: f.headers.authorization.slice(7), nativeToolToken, marketplace });
  const url = await api.listen();
  try {
    for (const path of ["/api/marketplace/preview", "/api/marketplace/export", "/api/marketplace/install", "/api/marketplace/access", "/api/marketplace/update",
      "/api/marketplace/share/files", "/api/marketplace/share/preview", "/api/marketplace/share/export", "/api/marketplace/share/upload",
      "/api/marketplace/catalog/preview", "/api/marketplace/catalog/entry", "/api/marketplace/catalog/submission"]) {
      assert.equal((await fetch(`${url}${path}`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${nativeToolToken}` }, body: "{}",
      })).status, 401);
    }
    assert.equal(reads, 0);
    const response = await fetch(`${url}/api/marketplace/preview`, {
      method: "POST", headers: f.headers, body: JSON.stringify({ repository: "example/bots" }),
    });
    assert.equal(response.status, 201);
    const preview = await response.json();
    assert.equal((await fetch(`${url}/api/marketplace/previews/${preview.id}`, { headers: f.headers })).status, 200);
    const exported = await fetch(`${url}/api/marketplace/export`, { method: "POST", headers: f.headers, body: JSON.stringify(bundle) });
    assert.equal(exported.status, 200);
    assert.equal((await exported.json()).filename, "example-bot-1.0.0.livingbot.json");
    assert.deepEqual(await (await fetch(`${url}/api/marketplace/installations`, { headers: f.headers })).json(), []);
    assert.equal((await fetch(`${url}/api/marketplace/access`, {
      method: "POST", headers: f.headers, body: JSON.stringify({ id: "invalid", enabled: "false" }),
    })).status, 400);
    assert.equal((await fetch(`${url}/api/marketplace/update`, {
      method: "POST", headers: f.headers, body: JSON.stringify({ replaceIdentity: "false" }),
    })).status, 400);
    assert.equal(f.store.list("bots").length, 1);
  } finally { await api.close(); await f.api.close(); f.service.detach(); f.store.close(); }
});

test("result reads require user credentials and preserve one durable read receipt", async () => {
  const nativeToken = randomBytes(32).toString("hex");
  const f = await fixture(undefined, nativeToken);
  try {
    const task = await f.service.submit({
      submissionId: "notification-input", botId: f.bot.id, conversationId: f.conversation.id, message: "Synthetic result",
    });
    f.kernel.emit("observation", { type: "frame", generation: 1, frame: {
      event: "chat", payload: {
        runId: "notification-input", sessionKey: f.store.engineSessionKey(f.conversation.id, f.bot.id),
        state: "final", message: { content: "Synthetic final" },
      },
    } });
    const notification = f.store.snapshot().notifications[0];
    assert.equal(notification.taskId, task.id);
    const endpoint = `${f.url}/api/notifications/${encodeURIComponent(notification.id)}/read`;
    assert.equal((await fetch(endpoint, { method: "POST" })).status, 401);
    assert.equal((await fetch(endpoint, {
      method: "POST", headers: { authorization: `Bearer ${nativeToken}` },
    })).status, 401);
    assert.equal(f.store.snapshot().notifications[0].readAt, undefined);
    const read = await (await fetch(endpoint, { method: "POST", headers: f.headers })).json();
    assert.equal(typeof read.readAt, "number");
    assert.deepEqual(await (await fetch(endpoint, { method: "POST", headers: f.headers })).json(), read);
    assert.equal((await fetch(`${f.url}/api/notifications/unknown/read`, { method: "POST", headers: f.headers })).status, 400);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("only user credentials may authorize continuation of an interrupted task", async () => {
  const nativeToken = randomBytes(32).toString("hex");
  const f = await fixture(undefined, nativeToken);
  try {
    const task = await f.service.submit({
      submissionId: "interrupted-input", conversationId: f.conversation.id, botId: f.bot.id, message: "Synthetic work",
    });
    f.store.updateTask(task.id, "interrupted");
    const sessionKey = f.store.engineSessionKey(f.conversation.id, f.bot.id);
    f.service.kernel.recoverHistory = async () => ({ messages: [], sessionInfo: {
      key: sessionKey, sessionId: "synthetic-session", hasActiveRun: false, activeLeafEntryId: null,
    } });
    const endpoint = `${f.url}/api/tasks/${task.id}/continue`;
    const input = JSON.stringify({ submissionId: "authorized-continuation" });
    assert.equal((await fetch(endpoint, { method: "POST", body: input })).status, 401);
    assert.equal((await fetch(endpoint, {
      method: "POST", headers: { ...f.headers, authorization: `Bearer ${nativeToken}` }, body: input,
    })).status, 401);
    assert.equal(f.store.list("submissions").length, 1);
    assert.equal((await fetch(endpoint, { method: "POST", headers: f.headers, body: "{}" })).status, 400);
    const continued = await fetch(endpoint, { method: "POST", headers: f.headers, body: input });
    assert.equal(continued.status, 202);
    assert.equal((await continued.json()).id, task.id);
    assert.equal((await fetch(endpoint, { method: "POST", headers: f.headers, body: input })).status, 202);
    assert.equal(f.store.list("tasks").length, 1);
    assert.equal(f.store.list("submissions").length, 2);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("scheduled work requires user authentication, explicit enabled state and an observed revision", async () => {
  const nativeToken = randomBytes(32).toString("hex");
  let native: NativeRoutine;
  let creates = 0;
  let changes = 0;
  const provider: RoutineProvider = {
    async create(definition) {
      creates++;
      return native = { ...definition, id: "synthetic-native-job", revision: "revision-one", enabled: true };
    },
    async get() { return native; },
    async setEnabled(_id, revision, enabled) {
      assert.equal(revision, native.revision);
      changes++;
      return native = { ...native, enabled, revision: "revision-two" };
    },
    async update(_id, revision, edit) {
      assert.equal(revision, native.revision);
      return native = { ...native, ...edit, revision: "edited-revision" };
    },
    async history() { return { entries: [], hasMore: false }; },
    async remove() {},
    async runNow() { return { runId: null }; },
  };
  const f = await fixture(undefined, nativeToken, undefined, undefined, undefined, provider);
  try {
    const endpoint = `${f.url}/api/routines`;
    const input = {
      id: "synthetic-routine", botId: f.bot.id, conversationId: f.conversation.id,
      name: "Synthetic work", message: "Synthetic scheduled task", schedule: { kind: "every", everyMs: 60_000 },
    };
    const unauthorized: Record<string, string>[] = [{}, { authorization: `Bearer ${nativeToken}`, "content-type": "application/json" }];
    for (const headers of unauthorized) {
      assert.equal((await fetch(endpoint, { headers })).status, 401);
      assert.equal((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(input) })).status, 401);
    }
    assert.equal(creates, 0);
    const created = await fetch(endpoint, { method: "POST", headers: f.headers, body: JSON.stringify(input) });
    assert.equal(created.status, 201);
    const schedule = await created.json() as { revision: string };
    const access = `${endpoint}/${input.id}/access`;
    for (const enabled of ["false", null, 0, {}]) assert.equal((await fetch(access, {
      method: "POST", headers: f.headers, body: JSON.stringify({ enabled, revision: schedule.revision }),
    })).status, 400);
    assert.equal((await fetch(access, {
      method: "POST", headers: f.headers, body: JSON.stringify({ enabled: false }),
    })).status, 400);
    assert.equal((await fetch(access, {
      method: "POST", headers: { ...f.headers, authorization: `Bearer ${nativeToken}` },
      body: JSON.stringify({ enabled: false, revision: schedule.revision }),
    })).status, 401);
    assert.equal(changes, 0);
    assert.equal((await fetch(access, {
      method: "POST", headers: f.headers, body: JSON.stringify({ enabled: false, revision: schedule.revision }),
    })).status, 200);
    assert.equal(changes, 1);
    const update = `${endpoint}/${input.id}/update`;
    const edit = { name: "Revised scheduled work", message: "Updated task", schedule: input.schedule, revision: "revision-two" };
    assert.equal((await fetch(update, {
      method: "POST", headers: { ...f.headers, authorization: `Bearer ${nativeToken}` }, body: JSON.stringify(edit),
    })).status, 401);
    assert.equal((await fetch(update, {
      method: "POST", headers: f.headers, body: JSON.stringify({ ...edit, revision: "" }),
    })).status, 400);
    const edited = await fetch(update, { method: "POST", headers: f.headers, body: JSON.stringify(edit) });
    assert.equal(edited.status, 200);
    const saved = await edited.json();
    assert.equal(saved.name, edit.name);
    assert.equal(saved.nativeId, "synthetic-native-job");
    assert.equal(saved.enabled, false);
    assert.equal((await fetch(`${endpoint}/${input.id}/history`, { headers: f.headers })).status, 200);
    assert.equal((await fetch(`${endpoint}/${input.id}/refresh`, { method: "POST", headers: f.headers, body: "{}" })).status, 200);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("input mode is validated before dispatch and steering cannot be changed by retry", async () => {
  const f = await fixture();
  try {
    const input = { submissionId: "steering", conversationId: f.conversation.id, botId: f.bot.id, message: "Synthetic additional requirement" };
    for (const queueMode of ["interrupt", "collect", true, {}, null]) {
      const response = await fetch(`${f.url}/api/submissions`, {
        method: "POST", headers: f.headers, body: JSON.stringify({ ...input, queueMode }),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(f.store.list("submissions").length, 0);
    const response = await fetch(`${f.url}/api/submissions`, {
      method: "POST", headers: f.headers, body: JSON.stringify({ ...input, queueMode: "steer" }),
    });
    assert.equal(response.status, 202);
    assert.equal(f.store.get<{ queueMode: string }>("submissions", input.submissionId)?.queueMode, "steer");
    const changed = await fetch(`${f.url}/api/submissions`, {
      method: "POST", headers: f.headers, body: JSON.stringify({ ...input, queueMode: "followup" }),
    });
    assert.ok(changed.status >= 400);
    assert.equal(f.store.messages(f.conversation.id).length, 1);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("connection management requires user authentication and explicit boolean global changes", async () => {
  const nativeToken = randomBytes(32).toString("hex");
  const changes: unknown[] = [];
  const connections: ServiceConnections = {
    async list() { return [{ name: "example", transport: "stdio", enabled: true, auth: "none" }]; },
    async add(input) { changes.push(input); },
    async setEnabled(name, enabled) { changes.push({ name, enabled }); },
    async update(name, input) { changes.push({ name, input }); },
    async remove(name) { changes.push({ removed: name }); },
  };
  const f = await fixture(undefined, nativeToken, undefined, undefined, connections);
  try {
    const url = `${f.url}/api/connections`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${nativeToken}` } })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: {
      ...f.headers, authorization: `Bearer ${nativeToken}`,
    }, body: JSON.stringify({ name: "bad", transport: "stdio", command: "node" }) })).status, 401);
    const listed = await fetch(url, { headers: f.headers });
    assert.deepEqual(await listed.json(), [{ name: "example", transport: "stdio", enabled: true, auth: "none" }]);
    const added = await fetch(url, { method: "POST", headers: f.headers,
      body: JSON.stringify({ name: "new", transport: "stdio", command: "node" }) });
    assert.equal(added.status, 201);
    const toggle = (enabled: unknown) => fetch(`${url}/example/access`, {
      method: "POST", headers: f.headers, body: JSON.stringify({ enabled }),
    });
    assert.equal((await toggle("false")).status, 400);
    assert.equal((await toggle(false)).status, 200);
    assert.equal((await fetch(`${url}/example/update`, {
      method: "POST", headers: { ...f.headers, authorization: `Bearer ${nativeToken}` }, body: '{"args":[]}',
    })).status, 401);
    assert.equal((await fetch(`${url}/example/update`, {
      method: "POST", headers: f.headers, body: '{"args":[]}',
    })).status, 200);
    for (const confirmed of [undefined, false, "true"]) assert.equal((await fetch(`${url}/example/remove`, {
      method: "POST", headers: f.headers, body: JSON.stringify({ confirmed }),
    })).status, 400);
    assert.equal((await fetch(`${url}/example/remove`, {
      method: "POST", headers: f.headers, body: '{"confirmed":true}',
    })).status, 200);
    assert.deepEqual(changes, [
      { name: "new", transport: "stdio", command: "node" }, { name: "example", enabled: false },
      { name: "example", input: { args: [] } }, { removed: "example" },
    ]);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("memory management uses the selected Bot agent and denies native tool credentials", async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const reference = { providerId: "memory-core", id: "MEMORY.md" };
  const provider = new OpenClawMemory({
    async request<T>(method: string, params: unknown): Promise<T> {
      const input = params as Record<string, unknown>;
      calls.push({ method, params: input });
      const envelope = { version: 2, agentId: input.agentId, providerId: "memory-core" };
      return (method === "memory.status" ? { ...envelope, status: "ready" } :
        method === "memory.search" ? { ...envelope, hits: [{ reference, excerpt: "Synthetic memory" }] } :
        { ...envelope, status: "ok", reference, text: "Synthetic source" }) as T;
    },
  });
  const nativeToken = randomBytes(32).toString("hex");
  const f = await fixture(undefined, nativeToken, undefined, provider);
  try {
    const other = f.store.createBot({ name: "Second Bot", agentId: "second-agent" });
    const endpoint = `${f.url}/api/bots/${other.id}/memory`;
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { headers: { authorization: `Bearer ${nativeToken}` } })).status, 401);
    assert.equal(calls.length, 0);
    assert.equal((await fetch(endpoint, { headers: f.headers })).status, 200);
    assert.equal(calls[0].params.agentId, other.agentId);
    const search = (input: unknown) => fetch(`${endpoint}/search`, {
      method: "POST", headers: f.headers, body: JSON.stringify(input),
    });
    const found = await search({ query: "项目" });
    assert.equal(found.status, 200);
    assert.equal((await found.json()).hits[0].reference.id, reference.id);
    const source = await fetch(`${endpoint}/source`, {
      method: "POST", headers: f.headers, body: JSON.stringify({ reference, from: 3 }),
    });
    assert.equal(source.status, 200);
    assert.equal((await source.json()).text, "Synthetic source");
    assert.deepEqual(calls[2].params, { agentId: other.agentId, reference, from: 3, lines: 100 });
    const accepted = calls.length;
    for (const input of [{ query: "" }, { query: "项目", limit: 51 }, { query: "项目", sources: ["invalid"] }]) {
      assert.equal((await search(input)).status, 400);
    }
    assert.equal((await fetch(`${endpoint}/source`, {
      method: "POST", headers: f.headers, body: JSON.stringify({ reference: { id: "MEMORY.md" } }),
    })).status, 400);
    assert.equal((await fetch(`${f.url}/api/bots/missing/memory`, { headers: f.headers })).status, 400);
    assert.equal(calls.length, accepted);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("forgetting preview requires user authentication and refuses conversations belonging to another Bot", async () => {
  const calls: { agentId: string; sessions: string[] }[] = [];
  const provider: MemoryProvider = {
    async health() { throw new Error("Unexpected health"); },
    async search() { throw new Error("Unexpected search"); },
    async get() { throw new Error("Unexpected get"); },
    async previewForget(agentId, sessions) {
      calls.push({ agentId, sessions });
      return {
        agentId, dryRun: true, sessionIds: [], sessionResolutions: [], entryKeys: [],
        mixedLineageEntryKeys: [], untargetableEntryKeys: [], curatedWrites: [], artifacts: {}, refusals: [],
      };
    },
  };
  const nativeToken = randomBytes(32).toString("hex");
  const f = await fixture(undefined, nativeToken, undefined, provider);
  try {
    const endpoint = `${f.url}/api/bots/${f.bot.id}/memory/forget-preview`;
    const unauthenticated: Record<string, string> = { "content-type": "application/json" };
    const asNativeCallback: Record<string, string> = { ...unauthenticated, authorization: `Bearer ${nativeToken}` };
    for (const headers of [unauthenticated, asNativeCallback]) {
      assert.equal((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ conversationIds: [f.conversation.id] }) })).status, 401);
    }
    assert.equal(calls.length, 0);
    const other = f.store.createBot({ name: "Moss" });
    const foreign = f.store.privateConversation(other.id);
    assert.equal((await fetch(endpoint, {
      method: "POST", headers: f.headers, body: JSON.stringify({ conversationIds: [f.conversation.id] }),
    })).status, 400);
    for (const conversationIds of [[foreign.id], [], undefined, "invalid"]) {
      assert.equal((await fetch(endpoint, {
        method: "POST", headers: f.headers, body: JSON.stringify({ conversationIds, allowKernelPause: true }),
      })).status, 400);
    }
    assert.equal(calls.length, 0);
    const response = await fetch(endpoint, {
      method: "POST", headers: f.headers, body: JSON.stringify({ conversationIds: [f.conversation.id], allowKernelPause: true }),
    });
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.report.dryRun, true);
    assert.equal(preview.botId, f.bot.id);
    assert.deepEqual(calls, [{ agentId: f.bot.agentId, sessions: [f.store.engineSessionKey(f.conversation.id, f.bot.id)] }]);
    assert.deepEqual(f.store.get("settings", preview.id), preview);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("memory recovery copies require user credentials, explicit pause and the reviewed digest", async () => {
  let preparations = 0;
  const provider: MemoryProvider = {
    async health() { throw new Error("Not called"); }, async search() { throw new Error("Not called"); }, async get() { throw new Error("Not called"); },
    async previewForget(agentId) {
      return { agentId, dryRun: true, sessionIds: [], sessionResolutions: [], entryKeys: [], mixedLineageEntryKeys: [],
        untargetableEntryKeys: [], curatedWrites: [], artifacts: {}, refusals: [] };
    },
    async prepareForget(_agentId, _sessions, digest) {
      preparations++;
      return { id: "memory-recovery-synthetic", createdAt: 1, digest: "a".repeat(64), previewDigest: digest,
        files: 1, bytes: 4, scope: "kernel-and-selected-workspace" };
    },
  };
  const nativeToken = randomBytes(32).toString("hex");
  const f = await fixture(undefined, nativeToken, undefined, provider);
  try {
    const preview = await f.service.memories!.previewForget(f.bot.id, [f.conversation.id]);
    const endpoint = `${f.url}/api/bots/${f.bot.id}/memory/forget-backup`;
    const input = { previewId: preview.id, digest: preview.digest, allowKernelPause: true };
    assert.equal((await fetch(endpoint, { method: "POST", headers: {
      "content-type": "application/json", authorization: `Bearer ${nativeToken}`,
    }, body: JSON.stringify(input) })).status, 401);
    for (const body of [{ ...input, allowKernelPause: false }, { ...input, digest: "b".repeat(64) }, { ...input, previewId: "unknown" }]) {
      assert.equal((await fetch(endpoint, { method: "POST", headers: f.headers, body: JSON.stringify(body) })).status, 400);
    }
    assert.equal(preparations, 0);
    const response = await fetch(endpoint, { method: "POST", headers: f.headers, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.recovery.previewDigest, preview.digest);
    assert.equal(preparations, 1);
    const inventory = `${f.url}/api/bots/${f.bot.id}/memory/recoveries`;
    assert.equal((await fetch(inventory, { headers: { authorization: `Bearer ${nativeToken}` } })).status, 401);
    const listed = await (await fetch(inventory, { headers: f.headers })).json();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].recovery.digest, result.recovery.digest);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("a reviewed recovery copy is copied for its own Bot only after explicit confirmation", async () => {
  let restores = 0;
  const provider: MemoryProvider = {
    async health() { throw new Error("Not called"); }, async search() { throw new Error("Not called"); }, async get() { throw new Error("Not called"); },
    async previewForget(agentId) {
      return { agentId, dryRun: true, sessionIds: [], sessionResolutions: [], entryKeys: [], mixedLineageEntryKeys: [],
        untargetableEntryKeys: [], curatedWrites: [], artifacts: {}, refusals: [] };
    },
    async prepareForget(_agentId, _sessions, digest) {
      return { id: "memory-recovery-synthetic", createdAt: 1, digest: "a".repeat(64), previewDigest: digest,
        files: 1, bytes: 4, scope: "kernel-and-selected-workspace" };
    },
    async restoreForget(recoveryId) {
      restores++;
      return { id: "memory-recovery-synthetic", createdAt: 2, target: `/synthetic/restores/${recoveryId}`,
        files: 1, bytes: 4, source: recoveryId };
    },
  };
  const nativeToken = randomBytes(32).toString("hex");
  const f = await fixture(undefined, nativeToken, undefined, provider);
  try {
    const preview = await f.service.memories!.previewForget(f.bot.id, [f.conversation.id]);
    await f.service.memories!.prepareForget(f.bot.id, preview.id, preview.digest);
    const endpoint = `${f.url}/api/bots/${f.bot.id}/memory/forget-restore`;
    const input = { previewId: preview.id, confirmRestore: true };
    assert.equal((await fetch(endpoint, { method: "POST", headers: {
      "content-type": "application/json", authorization: `Bearer ${nativeToken}`,
    }, body: JSON.stringify(input) })).status, 401);
    assert.equal((await fetch(endpoint, { method: "POST", headers: f.headers,
      body: JSON.stringify({ ...input, confirmRestore: false }) })).status, 400);
    assert.equal(restores, 0);
    for (let index = 0; index < 2; index++) {
      const response = await fetch(endpoint, { method: "POST", headers: f.headers, body: JSON.stringify(input) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).restores.length, 1);
    }
    assert.equal(restores, 1);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("forgetting apply requires explicit user confirmation and returns one reviewed outcome on retry", async () => {
  let applies = 0;
  const provider: MemoryProvider = {
    async health() { throw new Error("Not called"); }, async search() { throw new Error("Not called"); }, async get() { throw new Error("Not called"); },
    async previewForget(agentId) {
      return { agentId, dryRun: true, sessionIds: ["native"], sessionResolutions: [{ sessionId: "native", source: "live" }],
        entryKeys: [], mixedLineageEntryKeys: [], untargetableEntryKeys: [], curatedWrites: [], artifacts: {}, refusals: [] };
    },
    async applyForget(agentId, _sessions, digest) {
      applies++;
      return { id: "memory-forget-synthetic", agentId, createdAt: 1, status: "completed", files: [],
        recovery: { id: "memory-recovery-synthetic", createdAt: 1, digest: "a".repeat(64), previewDigest: digest,
          files: 1, bytes: 4, scope: "kernel-and-selected-workspace" } };
    },
  };
  const nativeToken = randomBytes(32).toString("hex");
  const f = await fixture(undefined, nativeToken, undefined, provider);
  try {
    const preview = await f.service.memories!.previewForget(f.bot.id, [f.conversation.id]);
    const endpoint = `${f.url}/api/bots/${f.bot.id}/memory/forget-apply`;
    const input = { previewId: preview.id, digest: preview.digest, allowKernelPause: true, confirmForget: true };
    assert.equal((await fetch(endpoint, { method: "POST", headers: {
      "content-type": "application/json", authorization: `Bearer ${nativeToken}`,
    }, body: JSON.stringify(input) })).status, 401);
    for (const body of [{ ...input, confirmForget: false }, { ...input, allowKernelPause: false }, { ...input, digest: "b".repeat(64) }]) {
      assert.equal((await fetch(endpoint, { method: "POST", headers: f.headers, body: JSON.stringify(body) })).status, 400);
    }
    assert.equal(applies, 0);
    for (let index = 0; index < 2; index++) {
      const response = await fetch(endpoint, { method: "POST", headers: f.headers, body: JSON.stringify(input) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).outcome.status, "completed");
    }
    assert.equal(applies, 1);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("native context endpoint requires its separate credential and a live exact Bot run", async () => {
  const nativeToken = randomBytes(32).toString("hex");
  const f = await fixture(undefined, nativeToken);
  const endpoint = `${f.url}/api/kernel/conversation-context`;
  try {
    const task = await f.service.submit({
      submissionId: "native-context-http", botId: f.bot.id,
      conversationId: f.conversation.id, message: "Recall this conversation",
    });
    const run = f.store.get<Run>("runs", "native-context-http")!;
    f.store.put("runs", { ...run, state: "running" });
    const input = {
      agentId: f.bot.agentId, sessionKey: run.sessionKey, runId: run.id, operation: "list",
    };
    assert.equal((await fetch(endpoint, {
      method: "POST", headers: f.headers, body: JSON.stringify(input),
    })).status, 401);
    const headers = { ...f.headers, authorization: `Bearer ${nativeToken}` };
    const accepted = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(input) });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).conversations[0].id, task.conversationId);
    f.store.put("runs", { ...run, state: "completed" });
    assert.equal((await fetch(endpoint, {
      method: "POST", headers, body: JSON.stringify(input),
    })).status, 400);
    assert.equal((await fetch(`${f.url}/api/snapshot`, { headers })).status, 401);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("scheduled execution binding requires host credentials and exact active native ownership", async () => {
  const nativeToken = randomBytes(32).toString("hex");
  let native: NativeRoutine;
  const provider: RoutineProvider = {
    async create(definition) { return native = { ...definition, id: "native-job", enabled: true, revision: "r1", runningAt: 1 }; },
    async get() { return native; },
    async setEnabled(_id, _revision, enabled) { return native = { ...native, enabled }; },
    async update(_id, _revision, edit) { return native = { ...native, ...edit }; },
    async history() { return { entries: [], hasMore: false }; },
    async remove() {},
    async runNow() { return { runId: null }; },
  };
  const f = await fixture(undefined, nativeToken, undefined, undefined, undefined, provider);
  try {
    await f.service.routines!.create({
      id: "product-routine", botId: f.bot.id, conversationId: f.conversation.id,
      name: "Scheduled work", message: "Synthetic task", schedule: { kind: "every", everyMs: 60_000 },
    });
    const input = {
      trigger: "cron", jobId: "native-job", runId: "native-model-run", sessionId: "native-session",
      agentId: f.bot.agentId, sessionKey: f.store.engineSessionKey(f.conversation.id, f.bot.id),
    };
    const endpoint = `${f.url}/api/kernel/scheduled-run`;
    const post = (value: unknown, headers = { ...f.headers, authorization: `Bearer ${nativeToken}` }) =>
      fetch(endpoint, { method: "POST", headers, body: JSON.stringify(value) });
    assert.equal((await post(input, f.headers)).status, 401);
    for (const invalid of [
      { ...input, trigger: "user" }, { ...input, runId: "" },
      { ...input, agentId: "other-bot" }, { ...input, sessionKey: "other-session" },
    ]) assert.equal((await post(invalid)).status, 400);
    assert.equal(f.store.list("tasks").length, 0);
    const accepted = await post(input);
    assert.equal(accepted.status, 200);
    const result = await accepted.json();
    assert.equal(result.adopted, true);
    assert.equal((await (await post(input)).json()).taskId, result.taskId);
    assert.equal(f.store.list("tasks").length, 1);
    const context = await fetch(`${f.url}/api/kernel/conversation-context`, {
      method: "POST", headers: { ...f.headers, authorization: `Bearer ${nativeToken}` },
      body: JSON.stringify({ ...input, operation: "list" }),
    });
    assert.equal(context.status, 200);
    assert.equal((await context.json()).conversations[0].id, f.conversation.id);
    f.store.updateTask(result.taskId, "completed");
    assert.equal((await post(input)).status, 400);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("group HTTP dispatch deduplicates input and native reporting cannot use ordinary client credentials", async () => {
  const nativeToken = randomBytes(32).toString("hex");
  const f = await fixture(undefined, nativeToken);
  try {
    const other = f.store.createBot({ name: "Other" });
    const groupResponse = await fetch(`${f.url}/api/conversations`, {
      method: "POST", headers: f.headers,
      body: JSON.stringify({ kind: "group", title: "Project", botIds: [f.bot.id, other.id] }),
    });
    assert.equal(groupResponse.status, 201);
    const group = await groupResponse.json();
    const input = { submissionId: "http-group-assignment", conversationId: group.id, botIds: group.botIds, message: "Report privately" };
    const dispatch = () => fetch(`${f.url}/api/group-submissions`, {
      method: "POST", headers: f.headers, body: JSON.stringify(input),
    });
    const initial = await dispatch();
    assert.equal(initial.status, 202);
    const receipt = await initial.json();
    assert.ok(receipt.outcomes.every((outcome: { accepted: boolean }) => outcome.accepted));
    const run = f.store.list<Run>("runs").find((item) => item.taskId === receipt.outcomes[0].task.id)!;
    const bot = f.store.snapshot().bots.find((item) => item.id === receipt.outcomes[0].botId)!;
    f.store.put("runs", { ...run, state: "running" });
    const authority = { agentId: bot.agentId, sessionKey: run.sessionKey, runId: run.id };
    const report = (headers: Record<string, string>) => fetch(`${f.url}/api/kernel/private-report`, {
      method: "POST", headers, body: JSON.stringify(authority),
    });
    assert.equal((await report(f.headers)).status, 401);
    const selected = await report({ ...f.headers, authorization: `Bearer ${nativeToken}` });
    assert.equal(selected.status, 200);
    assert.equal((await selected.json()).conversationId, f.store.privateConversation(bot.id).id);
    assert.equal((await dispatch()).status, 202);
    assert.equal(f.store.messages(group.id).filter((message) => message.role === "user").length, 1);
    assert.equal(f.store.list("tasks").length, 2);
    const assign = (headers: Record<string, string>) => fetch(`${f.url}/api/kernel/group-assignments`, {
      method: "POST", headers, body: JSON.stringify({
        ...authority, toolCallId: "native-http-delegation",
        assignments: [{ botId: group.botIds.find((id: string) => id !== bot.id), message: "Prepare the source notes", report: "private" }],
      }),
    });
    assert.equal((await assign(f.headers)).status, 401);
    const assigned = await assign({ ...f.headers, authorization: `Bearer ${nativeToken}` });
    assert.equal(assigned.status, 202);
    const childReceipt = await assigned.json();
    assert.equal(childReceipt.outcomes.length, 1);
    assert.equal(childReceipt.outcomes[0].accepted, true);
    assert.equal(childReceipt.outcomes[0].task, undefined);
    assert.equal(childReceipt.outcomes[0].reportConversationId, undefined);
    assert.equal(f.service.task(childReceipt.outcomes[0].taskId).parentTaskId, run.taskId);
    assert.equal(f.store.list("tasks").length, 3);
    f.store.updateTask(run.taskId, "stopping");
    assert.equal((await report({ ...f.headers, authorization: `Bearer ${nativeToken}` })).status, 400);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("shared ability HTTP routes return flat arrays, validate access and preserve the last inventory on refresh failure", async () => {
  let enabled = true;
  let refreshes = 0;
  let changes = 0;
  let failRefresh = false;
  const f = await fixture({
    read: async () => { throw new Error("No per-Bot discovery for the shared API"); },
    setEnabled: async () => { throw new Error("No per-Bot writes for the shared API"); },
    async readGlobal() { return [{
      id: "skill:original-key", name: "Original", description: "Native description",
      nativeName: "original-name", skillKey: "original-key", nativeKind: "skill",
      nativeSource: "openclaw-extra", source: "openclaw-extra", kind: "method",
      enabled, ready: false, manageable: true, global: true,
    }]; },
    async refreshGlobal() {
      ++refreshes;
      if (failRefresh) throw new Error("同名技能内容不同，保留原安装并先选择版本");
    },
    async setGlobalEnabled(capability, value) {
      assert.equal(capability.nativeName, "original-name");
      assert.equal(capability.skillKey, "original-key");
      enabled = value; ++changes;
    },
  });
  const endpoint = `${f.url}/api/abilities`;
  try {
    const unauthorized = await fetch(endpoint);
    assert.equal(unauthorized.status, 401);
    const list = await fetch(endpoint, { headers: f.headers });
    assert.equal(list.status, 200);
    const initial = await list.json();
    assert.ok(Array.isArray(initial));
    assert.deepEqual(initial[0].configuration.sharedAccess, { enabled: true, ready: false, manageable: true });
    for (const path of [endpoint, `${endpoint}/refresh`]) {
      const response = await fetch(path, { method: "POST", headers: f.headers, body: "{}" });
      assert.equal(response.status, 200);
      assert.ok(Array.isArray(await response.json()));
    }
    assert.equal(refreshes, 2);
    const path = `${endpoint}/${encodeURIComponent(initial[0].id)}/access`;
    const invalid = await fetch(path, { method: "POST", headers: f.headers, body: '{"enabled":"false"}' });
    assert.equal(invalid.status, 400);
    assert.equal(changes, 0);
    const edited = await fetch(path, { method: "POST", headers: f.headers, body: '{"enabled":false}' });
    assert.equal(edited.status, 200);
    const result = await edited.json();
    assert.ok(Array.isArray(result));
    assert.equal(result[0].configuration.sharedAccess.enabled, false);
    assert.equal(changes, 1);
    failRefresh = true;
    const failed = await fetch(`${endpoint}/refresh`, { method: "POST", headers: f.headers, body: "{}" });
    assert.equal(failed.status, 400);
    assert.match(JSON.stringify(await failed.json()), /同名技能内容不同/);
    const retained = await (await fetch(endpoint, { headers: f.headers })).json();
    assert.equal(retained[0].id, initial[0].id);
    assert.equal(retained[0].configuration.sharedAccess.enabled, false);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("ability HTTP controls decode native identities and reject invalid state before changing configuration", async () => {
  let enabled = true;
  let changes = 0;
  const f = await fixture({
    async read() { return [{
      id: "core:read", name: "Read", description: "Read files", source: "core", kind: "tool",
      enabled, ready: enabled, manageable: true, nativeKind: "tool", nativeName: "read",
    }]; },
    async setEnabled(agentId, capability, value) {
      assert.equal(agentId, f.bot.agentId);
      assert.equal(capability.nativeName, "read");
      enabled = value; changes++;
    },
  });
  const endpoint = `${f.url}/api/bots/${f.bot.id}/abilities`;
  try {
    const refresh = await fetch(`${endpoint}/refresh`, { method: "POST", headers: f.headers, body: "{}" });
    assert.equal(refresh.status, 200);
    const [ability] = await refresh.json();
    const path = `${endpoint}/${encodeURIComponent(ability.id)}/access`;
    const invalid = await fetch(path, { method: "POST", headers: f.headers, body: JSON.stringify({ enabled: "false" }) });
    assert.equal(invalid.status, 400);
    assert.equal(changes, 0);
    const accepted = await fetch(path, { method: "POST", headers: f.headers, body: JSON.stringify({ enabled: false }) });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json())[0].access[f.bot.id].enabled, false);
    assert.equal(changes, 1);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("HTTP retries persist one input and event replay streams subsequent facts", async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    const before = f.store.cursor();
    const events = await fetch(`${f.url}/api/events?after=${before}`, { headers: f.headers, signal: controller.signal });
    const reader = events.body!.getReader();
    await reader.read(); // Initial connected comment.
    const input = { submissionId: "http-input", conversationId: f.conversation.id, botId: f.bot.id, message: "Hello" };
    const send = () => fetch(`${f.url}/api/submissions`, { method: "POST", headers: f.headers, body: JSON.stringify(input) });
    const first = await send();
    assert.equal(first.status, 202);
    const task = await first.json();
    assert.equal((await (await send()).json()).id, task.id);
    assert.equal(f.store.messages(f.conversation.id).length, 1);
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, /event: change/);
    assert.match(chunk, /tasks.changed/);
    controller.abort();
    const replay = await fetch(`${f.url}/api/events?after=${before}`, { headers: f.headers, signal: AbortSignal.timeout(1000) });
    const replayReader = replay.body!.getReader();
    let text = "";
    while (!text.includes("http-input")) {
      const chunk = await replayReader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    assert.match(text, /http-input/);
    await replayReader.cancel();
  } finally { controller.abort(); await f.api.close(); f.service.detach(); f.store.close(); }
});

test("event backpressure detaches before the next event in the same transaction", async () => {
  const f = await fixture();
  try {
    const events = await fetch(`${f.url}/api/events?after=${f.store.cursor()}`, {
      headers: f.headers, signal: AbortSignal.timeout(5000),
    });
    const reader = events.body!.getReader();
    await reader.read();
    const listeners = f.store.listenerCount("event");
    f.store.transaction(() => {
      for (let index = 0; index < 3; index++) {
        f.store.recordEvent("large.acceptance", `fixture-${index}`, { text: "x".repeat(256_000) });
      }
    });
    assert.equal(f.store.listenerCount("event"), listeners - 1);
    while (!(await reader.read()).done) { /* Drain the bounded stream to its end. */ }
    assert.equal((await fetch(`${f.url}/api/snapshot`, { headers: f.headers })).status, 200);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("native document revision requires the host credential and returns the new version", async () => {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp("local/test-fixtures/http-revision-");
  const nativeToken = randomBytes(32).toString("hex");
  const f = await fixture(undefined, nativeToken, resolve(root));
  const endpoint = `${f.url}/api/kernel/revise`;
  const native = { ...f.headers, authorization: `Bearer ${nativeToken}` };
  const source = "# 合成报告\n\n## 结论\n本期保留原结论。\n\n## 附录\n原始数据见附件。\n";
  try {
    const workspaces = new Workspaces(resolve(root));
    await workspaces.write(f.bot.agentId, "projects", "example/report.md", source);
    const task = await f.service.submit({
      submissionId: "revision-http-run", botId: f.bot.id, conversationId: f.conversation.id, message: "修订报告结论",
    });
    const run = f.store.get<Run>("runs", "revision-http-run")!;
    f.store.put("runs", { ...run, state: "running" });
    const input = {
      agentId: f.bot.agentId, sessionKey: run.sessionKey, runId: run.id, toolCallId: "revision-http-call",
      relativePath: "projects/example/report.md", anchor: "本期保留原结论。", replacement: "本期结论已按批注更新。",
    };
    assert.equal((await fetch(endpoint, { method: "POST", headers: f.headers, body: JSON.stringify(input) })).status, 401);
    assert.equal((await fetch(endpoint, { method: "POST", headers: native, body: "{}" })).status, 400);
    const response = await fetch(endpoint, { method: "POST", headers: native, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.name, "report.md");
    assert.equal(result.passage.removed, "本期保留原结论。");
    assert.equal(result.source.relativePath, "projects/example/report.md");
    assert.equal(result.source.bytes, Buffer.byteLength(source));
    assert.notEqual(result.digest, result.source.digest);
    assert.equal((await workspaces.read(f.bot.agentId, "projects/example/report.md", 1_000_000)).toString(), source);
    assert.equal((await (await fetch(`${f.url}/api/files/${result.id}`, { headers: f.headers })).text()), source.replace(input.anchor, input.replacement));
    const delivered = f.store.messages(f.conversation.id).filter((message) =>
      message.blocks.some((block) => block.kind === "file" && block.artifactId === result.id));
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].taskId, task.id);
    const history = await (await fetch(`${f.url}/api/conversations/${f.conversation.id}/messages`, { headers: f.headers })).json();
    assert.equal(history.artifacts.find((file: { id: string }) => file.id === result.id)?.bytes,
      Buffer.byteLength(source.replace(input.anchor, input.replacement)));
    assert.equal((await fetch(endpoint, { method: "POST", headers: native, body: JSON.stringify({ ...input, anchor: "重复不存在" }) })).status, 400);
    f.store.updateTask(task.id, "completed");
    assert.equal((await fetch(endpoint, { method: "POST", headers: native, body: JSON.stringify(input) })).status, 400);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("file HTTP uploads keep stable identity and authenticated downloads preserve exact bytes", async () => {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp("local/test-fixtures/http-files-");
  const f = await fixture(undefined, undefined, resolve(root));
  try {
    const query = new URLSearchParams({ botId: f.bot.id, name: "资料.txt", mediaType: "text/plain" });
    const endpoint = `${f.url}/api/conversations/${f.conversation.id}/attachments/http-file-example-1?${query}`;
    const upload = () => fetch(endpoint, {
      method: "POST", headers: { ...f.headers, "content-type": "application/octet-stream" },
      body: "Synthetic bytes",
    });
    const created = await upload();
    assert.equal(created.status, 201);
    const file = await created.json();
    assert.equal(file.path, undefined);
    assert.deepEqual(await (await fetch(`${f.url}/api/files/${file.id}?metadata=1`, { headers: f.headers })).json(), file);
    assert.equal((await fetch(`${f.url}/api/bots/${f.bot.id}/files`)).status, 401);
    const inventory = await fetch(`${f.url}/api/bots/${f.bot.id}/files`, { headers: f.headers });
    assert.equal(inventory.status, 200);
    assert.deepEqual((await inventory.json()).files, [file]);
    const other = f.store.createBot({ name: "Other inventory" });
    assert.deepEqual((await (await fetch(`${f.url}/api/bots/${other.id}/files`, { headers: f.headers })).json()).files, []);
    assert.equal((await fetch(`${f.url}/api/bots/${other.id}/files?before=${file.id}`, { headers: f.headers })).status, 400);
    assert.equal((await upload()).status, 201);
    assert.equal(f.store.list("artifacts").length, 1);
    assert.equal((await fetch(`${f.url}/api/files/${file.id}`)).status, 401);
    const downloaded = await fetch(`${f.url}/api/files/${file.id}`, { headers: f.headers });
    assert.match(downloaded.headers.get("content-disposition")!, /attachment;/);
    assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await downloaded.text(), "Synthetic bytes");
    const submitted = await fetch(`${f.url}/api/submissions`, {
      method: "POST", headers: f.headers,
      body: JSON.stringify({
        submissionId: "http-files-submission", botId: f.bot.id, conversationId: f.conversation.id,
        message: "", attachmentIds: [file.id],
      }),
    });
    assert.equal(submitted.status, 202);
    assert.equal(f.store.messages(f.conversation.id)[0].blocks[0].kind, "file");
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("cancelling a sign-in attempt uses its own path and never the wait route", async () => {
  const f = await fixture();
  const calls: string[] = [];
  const attempt = {
    id: "attempt-synthetic", name: "example", state: "pending", createdAt: 1,
    authorizeUrl: "https://example.invalid/authorize",
  };
  const authorizations = {
    async read() { return []; },
    async start() { calls.push("start"); return attempt; },
    async complete() { calls.push("complete"); throw new Error("Not called"); },
    async revoke() { calls.push("revoke"); throw new Error("Not called"); },
    async cancel(id: string) { calls.push(`cancel:${id}`); },
    attempt() { return { ...attempt, state: "cancelled" as const }; },
    async wait() { calls.push("wait"); return attempt; },
    async dispose() { calls.push("dispose"); },
  };
  const api = createWorkbenchApi({
    service: f.service, token: f.headers.authorization.slice(7), authorizations: authorizations as never,
  });
  const url = await api.listen();
  try {
    const cancel = await fetch(`${url}/api/authorizations/attempts/attempt-synthetic/cancel`, {
      method: "POST", headers: { ...f.headers, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).state, "cancelled");
    assert.deepEqual(calls, ["cancel:attempt-synthetic"]);
    // A GET cannot cancel, and the suffix is not a wait.
    assert.equal((await fetch(`${url}/api/authorizations/attempts/attempt-synthetic/cancel`, {
      headers: f.headers,
    })).status, 404);
    const waited = await fetch(`${url}/api/authorizations/attempts/attempt-synthetic?timeoutMs=0`, {
      headers: f.headers,
    });
    assert.equal(waited.status, 200);
    assert.deepEqual(calls, ["cancel:attempt-synthetic", "wait"]);
    assert.equal((await fetch(`${url}/api/authorizations/attempts/attempt-synthetic`, {
      method: "POST", headers: { ...f.headers, "content-type": "application/json" }, body: "{}",
    })).status, 200);
    assert.deepEqual(calls, ["cancel:attempt-synthetic", "wait", "cancel:attempt-synthetic"]);
  } finally { await api.close(); await f.api.close(); f.service.detach(); f.store.close(); }
});

test("model capability refresh is authenticated and cannot change configuration during unfinished work", async () => {
  const store = new WorkbenchStore(":memory:");
  const bot = store.createBot({ name: "Synthetic" });
  const kernel = new TestKernel();
  const service = new WorkbenchService(store, kernel);
  let refreshes = 0;
  const summary = { configured: true, id: "synthetic", baseUrl: "https://example.invalid/v1",
    api: "openai-completions" as const, model: "synthetic", hasKey: true, input: ["text"] as ("text" | "image")[] };
  const token = "synthetic-test-token-with-at-least-32-characters";
  const api = createWorkbenchApi({ service, token, modelSettings: {
    async read() { return summary; }, async save() { return summary; },
    async discover() { refreshes++; return { ...summary, thinkingLevels: ["low", "high"] }; },
  } });
  try {
    const url = await api.listen();
    const refresh = (auth = true) => fetch(`${url}/api/model-settings/discover`, {
      method: "POST", headers: auth ? { authorization: `Bearer ${token}` } : {},
    });
    assert.equal((await refresh(false)).status, 401);
    assert.equal(refreshes, 0);
    const result = await refresh();
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).thinkingLevels, ["low", "high"]);
    store.put("tasks", { id: "synthetic-busy-task", status: "running" });
    assert.equal((await refresh()).status, 409);
    assert.equal(refreshes, 1);
  } finally { await api.close(); service.detach(); store.close(); }
});

test("scheduled approval URLs decode task identity without weakening ownership or replay checks", async () => {
  const f = await fixture();
  const taskId = "scheduled:synthetic-run";
  const interactionId = "approval:synthetic-request";
  f.store.put("tasks", { id: taskId, botId: f.bot.id, conversationId: f.conversation.id,
    reportConversationId: f.conversation.id, title: "Synthetic scheduled work", status: "waiting", createdAt: 1, updatedAt: 1 });
  f.store.put("interactions", { id: interactionId, engineId: "synthetic-request", kind: "approval", taskId,
    conversationId: f.conversation.id, sessionKey: "synthetic", runId: "synthetic-run", generation: 1,
    title: "printf synthetic", questions: [], decisions: ["allow-once", "deny"], status: "pending", createdAt: 1, expiresAt: Date.now() + 60_000 });
  const calls: unknown[] = [];
  f.kernel.request = async <T>(method: string, params?: unknown): Promise<T> => {
    assert.equal(method, "exec.approval.resolve"); calls.push(params); return { ok: true } as T;
  };
  const post = (id: string, answer: unknown) => fetch(`${f.url}/api/tasks/${encodeURIComponent(id)}/interactions/${encodeURIComponent(interactionId)}/resolve`, {
    method: "POST", headers: f.headers, body: JSON.stringify(answer),
  });
  try {
    const answer = { resolutionId: "synthetic-resolution", decision: "allow-once" };
    const wrong = await post("scheduled:another-task", answer);
    assert.equal(wrong.status, 400); assert.match((await wrong.json()).error, /does not belong/); assert.equal(calls.length, 0);
    const response = await post(taskId, answer);
    assert.equal(response.status, 200); assert.equal((await response.json()).status, "answered");
    assert.deepEqual(calls, [{id:"synthetic-request", decision:"allow-once"}]);
    assert.equal((await post(taskId, answer)).status, 200); assert.equal(calls.length, 1);
    assert.equal((await post(taskId, { ...answer, decision: "deny" })).status, 400); assert.equal(calls.length, 1);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("scheduled task control URLs decode identity before stopping or continuing work", async () => {
  const f = await fixture();
  const taskId = "scheduled:control-example";
  const calls: unknown[] = [];
  f.service.cancel = async (id) => { calls.push({operation:"cancel", id}); return { id } as any; };
  f.service.continueTask = async (id, submissionId) => { calls.push({operation:"continue", id, submissionId}); return { id } as any; };
  try {
    for (const operation of ["cancel", "continue"]) {
      const response = await fetch(`${f.url}/api/tasks/${encodeURIComponent(taskId)}/${operation}`, {method:"POST",headers:f.headers,body:JSON.stringify({submissionId:"synthetic-continuation"})});
      assert.equal(response.status,202);
    }
    assert.deepEqual(calls,[{operation:"cancel",id:taskId},{operation:"continue",id:taskId,submissionId:"synthetic-continuation"}]);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});

test("native health inspection credentials cannot read user reports or approve modifications", async () => {
  const nativeToken = randomBytes(32).toString("hex");
  const f = await fixture(undefined, nativeToken, resolve("local/test-fixtures/health-authority-unused"));
  const report = { id: "bot-health:test", botId: f.bot.id, version: "bot-health-v2", revision: "v1",
    state: "reported", summary: "未发现问题", complete: true, issues: [], gaps: [] };
  f.store.put("settings", report);
  const endpoint = `${f.url}/api/bots/${f.bot.id}/health-reports/${encodeURIComponent(report.id)}`;
  const nativeHeaders = { authorization: `Bearer ${nativeToken}`, "content-type": "application/json" };
  try {
    assert.equal((await fetch(endpoint, { headers: f.headers })).status, 200);
    assert.equal((await fetch(endpoint, { headers: nativeHeaders })).status, 401);
    assert.equal((await fetch(endpoint + "/apply", { method: "POST", headers: nativeHeaders,
      body: JSON.stringify({ revision: "v1", actionIds: ["pretend-plan"] }) })).status, 401);
    assert.equal((await fetch(endpoint + "/decisions", { method: "POST", headers: nativeHeaders,
      body: JSON.stringify({ revision: "v1", submissionId: "pretend-batch", decisions: [] }) })).status, 401);
    assert.equal((await fetch(`${f.url}/api/kernel/bot-health`, { method: "POST", headers: f.headers,
      body: JSON.stringify({ operation: "begin" }) })).status, 401);
    assert.deepEqual(f.store.get("settings", report.id), report);
  } finally { await f.api.close(); f.service.detach(); f.store.close(); }
});
