import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Acceptance, HistoryPage, RuntimeObservation, Submission } from "../../kernel-runtime/src/contracts.ts";
import type { Run, Task } from "./contracts.ts";
import { WorkbenchService } from "./service.ts";
import { WorkbenchStore } from "./store.ts";

export class FakeKernel extends EventEmitter {
  generation = 1;
  phase = "ready";
  async request<T = unknown>(method: string): Promise<T> {
    return (method === "question.list" ? { questions: [] } : []) as T;
  }
  sent: Submission[] = [];
  aborted: { sessionKey: string; runId?: string }[] = [];
  historyCalls: { sessionKey: string; cursor?: string }[] = [];
  history: HistoryPage = { messages: [], deltaCursor: "cursor-one" };
  handler?: (submission: Submission) => Promise<Acceptance>;
  async send(submission: Submission): Promise<Acceptance> {
    this.sent.push(submission);
    return this.handler ? this.handler(submission) : { runId: submission.idempotencyKey, status: "started" };
  }
  async recoverHistory(sessionKey: string, cursor?: string, _inputRunIds?: string[]): Promise<HistoryPage> {
    this.historyCalls.push({ sessionKey, cursor });
    return this.history;
  }
  async abort(sessionKey: string, runId?: string): Promise<unknown> {
    this.aborted.push({ sessionKey, runId });
    return { aborted: true };
  }
  observe(observation: RuntimeObservation): void { this.emit("observation", observation); }
}

function fixture() {
  const store = new WorkbenchStore(":memory:");
  const kernel = new FakeKernel();
  const service = new WorkbenchService(store, kernel);
  const bot = store.createBot({ name: "Test Bot" });
  const conversation = store.privateConversation(bot.id);
  const input = { submissionId: "input-one", conversationId: conversation.id, botId: bot.id, message: "test" };
  return { store, kernel, service, bot, conversation, input };
}

test("exact durable model finals replace the delivery summary in either arrival order without deduplicating prose", async () => {
  for (const historyFirst of [true, false]) {
    const f = fixture();
    try {
      await f.service.submit(f.input);
      const runId = f.input.submissionId;
      const sessionKey = f.store.engineSessionKey(f.conversation.id, f.bot.id);
      const native = (id: string, seq: number, stopReason: string) => ({
        event: "session.message", payload: { sessionKey, runId, messageId: id, message: {
          role: "assistant", __openclaw: { id, runId, seq }, stopReason,
          content: [{ type: "text", text: "Same" }],
        } },
      });
      f.kernel.observe({ type: "frame", generation: 1, frame: native("native-1", 1, "toolUse") });
      const final = { type: "frame" as const, generation: 1, frame: {
        event: "chat", payload: { runId, sessionKey, seq: 9, state: "final", message: { content: "Same\n\nSame" } },
      } };
      if (!historyFirst) f.kernel.observe(final);
      f.kernel.observe({ type: "frame", generation: 1, frame: native("native-2", 2, "stop") });
      if (historyFirst) f.kernel.observe(final);
      const reply = f.store.messages(f.conversation.id).find((message) => message.role === "assistant")!;
      assert.deepEqual(reply.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []), ["Same", "Same"]);
      assert.equal(reply.nativeFinalMessageId, "native-2");
    } finally { f.service.detach(); f.store.close(); }
  }
});

test("kernel starting persists its generation before owned run events arrive", () => {
  const { store, kernel, service } = fixture();
  kernel.observe({ type: "phase", phase: "starting", generation: 9 });
  assert.equal(store.get<{ generation: number }>("settings", "kernel-generation")?.generation, 9);
  service.detach(); store.close();
});

test("native widgets arriving in history enrich the exact terminal reply without another result notification", async () => {
  const f = fixture();
  const task = await f.service.submit(f.input);
  const run = f.store.find<Run>("runs", "taskId", task.id)[0];
  f.kernel.observe({ type: "frame", generation: 1, frame: {
    event: "chat", payload: { runId: run.id, sessionKey: run.sessionKey, state: "final",
      message: { content: [{ type: "text", text: "Preview ready" }] } },
  } });
  const notifications = f.store.list("notifications").length;
  f.kernel.history = { messages: [{
    id: "native-widget-final", runId: run.id,
    role: "assistant", stopReason: "stop", content: [
      { type: "text", text: "Preview ready" },
      { type: "canvas", preview: { kind: "canvas", surface: "assistant_message", viewId: "cv_restored" } },
    ],
  }] };
  await f.service.reconcile();
  await f.service.reconcile();
  const messages = f.store.messages(f.conversation.id).filter((message) => message.role === "assistant");
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].blocks.filter((block) => block.kind === "widget"), [{
    id: "widget:cv_restored", kind: "widget", docId: "cv_restored", title: "交互预览", sessionKey: run.sessionKey,
  }]);
  assert.equal(f.store.list("notifications").length, notifications);
  assert.equal(f.store.get<Task>("tasks", task.id)?.status, "completed");
  f.service.detach(); f.store.close();
});

test("simultaneous retries share dispatch; another Bot never waits for a global slot", async () => {
  const { store, kernel, service, input } = fixture();
  let release!: (value: Acceptance) => void;
  kernel.handler = (submission) => submission.idempotencyKey === input.submissionId
    ? new Promise((resolve) => { release = resolve; })
    : Promise.resolve({ runId: submission.idempotencyKey, status: "started" });
  const first = service.submit(input);
  const duplicate = service.submit(input);
  const other = store.createBot({ name: "Other Bot" });
  const otherConversation = store.privateConversation(other.id);
  const second = await service.submit({ ...input, submissionId: "other-input", botId: other.id, conversationId: otherConversation.id });
  assert.equal(second.status, "queued");
  assert.equal(kernel.sent.length, 2);
  release({ runId: "first-run", status: "started" });
  assert.equal((await first).id, (await duplicate).id);
  assert.equal(store.list("messages").length, 2);
  service.detach(); store.close();
});

test("lost acceptance stays pending and retries the same stable identity", async () => {
  const { store, kernel, service, input } = fixture();
  kernel.handler = async () => { throw new Error("Reply lost"); };
  await assert.rejects(service.submit(input), /Reply lost/);
  assert.equal(store.get<{ state: string }>("submissions", input.submissionId)?.state, "pending");
  kernel.handler = undefined;
  await service.reconcile();
  assert.deepEqual(kernel.sent.map((submission) => submission.idempotencyKey), [input.submissionId, input.submissionId]);
  assert.equal(store.messages(input.conversationId).length, 1);
  assert.equal(store.get<{ state: string }>("submissions", input.submissionId)?.state, "accepted");
  service.detach(); store.close();
});

test("exact native cancellation after a crash retires queued custody without inventing completion", async () => {
  const { store, kernel, service, input } = fixture();
  const task = await service.submit(input);
  const otherBot = store.createBot({ name: "Moss" });
  const otherConversation = store.privateConversation(otherBot.id);
  const other = await service.submit({ ...input, submissionId: "other-queued", botId: otherBot.id, conversationId: otherConversation.id });
  kernel.observe({ type: "exit", code: null, signal: "SIGKILL", generation: 1 });
  const sessionKey = kernel.sent[0].sessionKey;
  kernel.recoverHistory = async (key) => ({
    messages: [], pendingInputs: { items: [
      { id: "retained-input", runId: input.submissionId, state: "cancelled" },
      { id: "wrong-session", runId: "other-queued", state: "cancelled" },
      { id: "unknown-input", runId: "unowned", state: "cancelled" },
    ] },
    sessionInfo: { key, hasActiveRun: false },
  });
  await service.reconcileSession(sessionKey);
  assert.equal(service.task(task.id).status, "interrupted");
  assert.equal(store.get<Run>("runs", input.submissionId)?.state, "cancelled");
  assert.equal(service.task(other.id).status, "queued");
  assert.equal(store.messages(input.conversationId).filter((message) => message.role === "assistant").length, 0);
  await service.reconcileSession(sessionKey);
  assert.equal(kernel.sent.length, 2);
  service.detach(); store.close();
});

test("temporary graceful restart cancellation never retires retained queued inputs", async () => {
  const { store, kernel, service, input } = fixture();
  const task = await service.submit(input);
  kernel.observe({ type: "exit", code: 0, signal: null, generation: 1 });
  kernel.history = { messages: [], pendingInputs: { items: [{ id: "temporary-owner", runId: input.submissionId, state: "cancelled" }] } };
  await service.reconcile();
  assert.equal(service.task(task.id).status, "queued");
  assert.equal(store.get<Run>("runs", input.submissionId)?.state, "queued");
  service.detach(); store.close();
});

test("exact crash-left input receipts recover ownership even when display history omits pending rows", async () => {
  const { store, kernel, service, input } = fixture();
  const task = await service.submit(input);
  kernel.observe({ type: "exit", code: null, signal: "SIGKILL", generation: 1 });
  kernel.recoverHistory = async (sessionKey, _cursor, inputRunIds) => {
    assert.deepEqual(inputRunIds, [input.submissionId]);
    return {
      messages: [], sessionInfo: { key: sessionKey, hasActiveRun: false },
      pendingInputs: { items: [], total: 0, queuedCount: 0 },
      inputReceipts: [{ runId: input.submissionId, state: "pending" }],
    };
  };
  await service.reconcile();
  assert.equal(service.task(task.id).status, "interrupted");
  assert.equal(store.get<Run>("runs", input.submissionId)?.state, "interrupted");
  assert.equal(kernel.sent.length, 1);
  service.detach(); store.close();
});

test("an exact input that remains in native queue custody is never retired as crash-left", async () => {
  const { store, kernel, service, input } = fixture();
  const task = await service.submit(input);
  kernel.observe({ type: "exit", code: null, signal: "SIGKILL", generation: 1 });
  kernel.history = {
    messages: [], sessionInfo: { key: kernel.sent[0].sessionKey, hasActiveRun: false },
    inputReceipts: [{ runId: input.submissionId, state: "pending", queued: true }],
  };
  await service.reconcile();
  assert.equal(service.task(task.id).status, "queued");
  assert.equal(store.get<Run>("runs", input.submissionId)?.state, "queued");
  service.detach(); store.close();
});

test("crash recovery batches exact receipts beyond the native limit and rejects a replaced physical session", async () => {
  const { store, kernel, service, input } = fixture();
  const tasks: Task[] = [];
  for (let index = 0; index < 53; index++) {
    tasks.push(await service.submit({ ...input, submissionId: `batch-input-${index}` }));
  }
  kernel.observe({ type: "exit", code: null, signal: "SIGKILL", generation: 1 });
  const batches: string[][] = [];
  let replaced = true;
  kernel.recoverHistory = async (sessionKey, _cursor, ids) => {
    const runIds = ids ?? [];
    batches.push(runIds);
    return {
      messages: [], sessionInfo: { key: sessionKey, sessionId: replaced && batches.length === 2 ? "replaced" : "original", hasActiveRun: false },
      inputReceipts: runIds.map((runId) => ({ runId, state: "pending", cancelled: true })),
    };
  };
  await assert.rejects(service.reconcile(), /session changed/);
  assert.ok(tasks.every((task) => service.task(task.id).status === "queued"));
  assert.deepEqual(batches.map((batch) => batch.length), [50, 3]);
  batches.length = 0; replaced = false;
  await service.reconcile();
  assert.deepEqual(batches.map((batch) => batch.length), [50, 3]);
  assert.ok(tasks.every((task) => service.task(task.id).status === "interrupted"));
  assert.equal(new Set(batches.flat()).size, 53);
  service.detach(); store.close();
});

function interrupt(kernel: FakeKernel, id: string) {
  kernel.observe({ type: "frame", generation: 1, frame: { event: "agent", payload: {
    runId: id, sessionKey: kernel.sent[0].sessionKey, seq: 1, stream: "lifecycle", data: { phase: "start" },
  } } });
  kernel.observe({ type: "exit", code: null, signal: "SIGKILL", generation: 1 });
  kernel.history = { messages: [], sessionInfo: {
    key: kernel.sent[0].sessionKey, sessionId: "native-session", hasActiveRun: false, activeLeafEntryId: "native-leaf",
  } };
}

test("explicit continuation retains its original task and fences the native session and displayed branch", async () => {
  const { store, kernel, service, input } = fixture();
  const original = await service.submit(input);
  interrupt(kernel, input.submissionId);
  const continued = await service.continueTask(original.id, "user-continuation");
  assert.equal(continued.id, original.id);
  assert.equal(store.list("tasks").length, 1);
  assert.equal(kernel.sent[1].sessionId, "native-session");
  assert.equal(kernel.sent[1].expectedLeafEntryId, "native-leaf");
  assert.equal(kernel.sent[1].queueMode, "followup");
  assert.ok(kernel.sent[1].message.endsWith(input.message));
  assert.equal(store.get<{ continuationOf?: string }>("submissions", "user-continuation")?.continuationOf, input.submissionId);
  assert.equal(store.messages(input.conversationId).filter((message) => message.role === "user").length, 2);
  const duplicate = await service.continueTask(original.id, "user-continuation");
  assert.equal(duplicate.id, original.id);
  assert.equal(kernel.sent.length, 2);
  kernel.observe({ type: "frame", generation: 2, frame: { event: "chat", payload: {
    runId: "user-continuation", sessionKey: kernel.sent[0].sessionKey, seq: 1, state: "final", message: { content: "Synthetic continued result" },
  } } });
  assert.equal(service.task(original.id).status, "completed");
  await service.continueTask(original.id, "user-continuation");
  assert.equal(kernel.sent.length, 2);
  service.detach(); store.close();
});

test("a failed native task continues under its original identity and keeps the earlier failure inspectable", async () => {
  const { store, kernel, service, input } = fixture();
  try {
    const task = await service.submit(input);
    const sessionKey = kernel.sent[0].sessionKey;
    kernel.observe({ type: "frame", generation: 1, frame: { event: "chat", payload: {
      runId: input.submissionId, sessionKey, seq: 1, state: "error", errorMessage: "Synthetic provider unavailable",
    } } });
    assert.equal(service.task(task.id).status, "failed");
    assert.equal(service.task(task.id).error, "Synthetic provider unavailable");
    kernel.history = { sessionInfo: {
      key: sessionKey, sessionId: "native-session", hasActiveRun: false, activeLeafEntryId: "failed-leaf",
    } };
    const continued = await service.continueTask(task.id, "after-provider-failure");
    assert.equal(continued.id, task.id);
    assert.equal(continued.status, "queued");
    assert.equal(continued.error, undefined);
    assert.equal(kernel.sent[1].sessionId, "native-session");
    assert.equal(kernel.sent[1].expectedLeafEntryId, "failed-leaf");
    await service.continueTask(task.id, "after-provider-failure");
    assert.equal(kernel.sent.length, 2);
    kernel.observe({ type: "frame", generation: 1, frame: { event: "chat", payload: {
      runId: "after-provider-failure", sessionKey, seq: 1, state: "final", message: { content: "Synthetic remaining work completed" },
    } } });
    assert.equal(service.task(task.id).status, "completed");
    assert.equal(store.list("tasks").length, 1);
    assert.equal(store.find<Run>("runs", "taskId", task.id).length, 2);
    assert.ok(store.messages(input.conversationId).some((message) =>
      message.blocks.some((block) => block.kind === "text" && block.text.includes("Synthetic provider unavailable"))));
  } finally { service.detach(); store.close(); }
});

test("a lost continuation acknowledgment retries the same fenced authority without creating another task", async () => {
  const { store, kernel, service, input } = fixture();
  const task = await service.submit(input);
  interrupt(kernel, input.submissionId);
  kernel.handler = async () => { throw new Error("Synthetic continuation receipt lost"); };
  await assert.rejects(service.continueTask(task.id, "continue-once"), /receipt lost/);
  assert.equal(service.task(task.id).continuationSubmissionId, "continue-once");
  assert.equal(service.task(task.id).status, "queued");
  kernel.handler = undefined;
  await service.reconcile();
  assert.equal(service.task(task.id).continuationSubmissionId, undefined);
  assert.equal(store.list("tasks").length, 1);
  assert.deepEqual(kernel.sent.slice(1).map((submission) => [submission.idempotencyKey, submission.sessionId, submission.expectedLeafEntryId]), [
    ["continue-once", "native-session", "native-leaf"], ["continue-once", "native-session", "native-leaf"],
  ]);
  assert.equal(store.messages(input.conversationId).filter((message) => message.role === "user").length, 2);
  service.detach(); store.close();
});

test("continuation refuses active or unverified native owners, explicit stop and reused input identities", async () => {
  const { store, kernel, service, input } = fixture();
  const task = await service.submit(input);
  await assert.rejects(service.continueTask(task.id, "too-early"), /cannot be continued/);
  interrupt(kernel, input.submissionId);
  for (const sessionInfo of [
    { key: kernel.sent[0].sessionKey, sessionId: "native-session", activeLeafEntryId: "leaf", hasActiveRun: true },
    { key: kernel.sent[0].sessionKey, hasActiveRun: false },
  ]) {
    kernel.history = { sessionInfo };
    await assert.rejects(service.continueTask(task.id, "uncertain"), /not ready/);
  }
  await assert.rejects(service.continueTask(task.id, input.submissionId), /conflicts/);
  await service.cancel(task.id);
  await assert.rejects(service.continueTask(task.id, "stopped"), /cannot be continued/);
  assert.equal(kernel.sent.length, 1);
  assert.equal(store.list("submissions").length, 1);
  service.detach(); store.close();
});

test("steering retains its exact submission mode through a lost acknowledgment and recovery", async () => {
  const { store, kernel, service, input } = fixture();
  const original = await service.submit(input);
  kernel.observe({ type: "frame", generation: 1, frame: { event: "agent", payload: {
    runId: input.submissionId, sessionKey: kernel.sent[0].sessionKey, seq: 1,
    stream: "lifecycle", data: { phase: "start" },
  } } });
  const steering = { ...input, submissionId: "steering-input", message: "Additional requirement", queueMode: "steer" as const };
  kernel.handler = async () => { throw new Error("Lost steering acknowledgment"); };
  await assert.rejects(service.submit(steering), /Lost steering/);
  await assert.rejects(service.submit({ ...steering, queueMode: "followup" }), /input mode/);
  assert.equal(store.messages(input.conversationId).length, 2);
  kernel.handler = undefined;
  await service.reconcile();
  assert.deepEqual(kernel.sent.map((entry) => [entry.idempotencyKey, entry.queueMode]), [
    [input.submissionId, "steer"], ["steering-input", "steer"], ["steering-input", "steer"],
  ]);
  assert.equal(store.messages(input.conversationId).length, 2);
  assert.equal(service.task(original.id).status, "running");
  service.detach(); store.close();
});

test("a conflicting native receipt never transfers another run's task ownership", async () => {
  const { store, kernel, service, input } = fixture();
  const original = await service.submit(input);
  kernel.handler = async () => ({ runId: input.submissionId, status: "started" });
  await assert.rejects(service.submit({ ...input, submissionId: "conflicting-input", queueMode: "steer" }), /existing run owner/);
  assert.equal(store.get<{ taskId: string }>("runs", input.submissionId)?.taskId, original.id);
  assert.equal(store.get<{ state: string }>("submissions", "conflicting-input")?.state, "pending");
  service.detach(); store.close();
});

test("an empty steering terminal confirms only input delivery, while idle steering retains its real reply", async () => {
  const { store, kernel, service, input } = fixture();
  const original = await service.submit(input);
  const steering = await service.submit({ ...input, submissionId: "addition", queueMode: "steer" });
  const sessionKey = kernel.sent[0].sessionKey;
  kernel.observe({ type: "frame", generation: 1, frame: {
    event: "chat", payload: { runId: "addition", sessionKey, seq: 1, state: "final" },
  } });
  assert.equal(service.task(steering.id).inputDisposition, "steered");
  assert.equal(service.task(original.id).status, "queued");
  const idle = await service.submit({ ...input, submissionId: "idle", queueMode: "steer" });
  kernel.observe({ type: "frame", generation: 1, frame: {
    event: "chat", payload: { runId: "idle", sessionKey, seq: 1, state: "final", message: { content: "Synthetic result" } },
  } });
  assert.equal(service.task(idle.id).inputDisposition, undefined);
  const failed = await service.submit({ ...input, submissionId: "denied-addition", queueMode: "steer" });
  kernel.observe({ type: "frame", generation: 1, frame: {
    event: "chat", payload: { runId: "denied-addition", sessionKey, seq: 1, state: "error", errorMessage: "Synthetic refusal" },
  } });
  assert.equal(service.task(failed.id).inputDisposition, undefined);
  assert.equal(service.task(failed.id).status, "failed");
  service.detach(); store.close();
});

test("an abort failure still stops the exact owned program and leaves its uncertain outcome visible", async () => {
  const { store, kernel, service, input } = fixture();
  const task = await service.submit(input);
  const sessionKey = kernel.sent[0].sessionKey;
  const stopped: unknown[] = [];
  kernel.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "sessions.processes.list") return {
      sessionId: "native-session", truncated: false, processes: [{
        processId: "program", instanceId: "instance", startedAt: 123, status: "running", canStop: true,
      }],
    } as T;
    if (method === "sessions.processes.stop") { stopped.push(params); return { requested: true } as T; }
    return [] as T;
  };
  kernel.abort = async () => { throw new Error("Synthetic abort failure"); };
  kernel.observe({ type: "frame", generation: 1, frame: {
    event: "agent", payload: { runId: input.submissionId, sessionKey, stream: "tool", seq: 1, data: {
      name: "exec", phase: "result", toolCallId: "exec",
      result: { details: { status: "running", sessionId: "program", startedAt: 123 } },
    } },
  } });
  await assert.rejects(service.cancel(task.id), /Stop was not confirmed/);
  assert.deepEqual(stopped, [{ key: sessionKey, sessionId: "native-session", processId: "program", instanceId: "instance" }]);
  assert.equal(service.task(task.id).status, "stopping");
  assert.equal(service.task(task.id).processes?.[0].status, "stopping");
  service.detach(); store.close();
});

test("stopping a completed parent also stops an ACP child accepted after the stop request", async () => {
  const { store, kernel, service, input } = fixture();
  const parent = await service.submit(input);
  const sessionKey = kernel.sent[0].sessionKey;
  const frame = (seq: number, data: Record<string, unknown>) => kernel.observe({
    type: "frame", generation: 1, frame: {
      event: "agent", payload: { runId: input.submissionId, sessionKey, stream: "tool", seq, data },
    },
  });
  frame(1, {
    name: "sessions_spawn", phase: "start", toolCallId: "delegate-1",
    args: { runtime: "acp", agentId: "workbuddy", task: "Read synthetic evidence" },
  });
  kernel.observe({ type: "frame", generation: 1, frame: {
    event: "chat", payload: { runId: input.submissionId, sessionKey, seq: 2, state: "final", message: { content: "Assigned" } },
  } });
  await service.cancel(parent.id);
  const childKey = "agent:synthetic:acp:child";
  frame(3, { name: "sessions_spawn", phase: "result", toolCallId: "delegate-1",
    result: { details: { status: "accepted", runId: "child-run", childSessionKey: childKey } },
  });
  const child = store.list<Task>("tasks").find((task) => task.parentTaskId === parent.id)!;
  assert.equal(child.status, "stopping");
  assert.deepEqual(kernel.aborted, [{ sessionKey: childKey, runId: "child-run" }]);
  assert.equal(service.task(parent.id).status, "completed");
  service.detach(); store.close();
});

test("reconnect restores the delegated final from its own native history without inventing a user input", async () => {
  const { store, kernel, service, input } = fixture();
  const parent = await service.submit(input);
  const sessionKey = kernel.sent[0].sessionKey;
  const childKey = "agent:synthetic:acp:child";
  for (const [seq, data] of [
    [1, { name: "sessions_spawn", phase: "start", toolCallId: "delegate-1",
      args: { runtime: "acp", agentId: "codex", task: "Read synthetic evidence" } }],
    [2, { name: "sessions_spawn", phase: "result", toolCallId: "delegate-1",
      result: { details: { status: "accepted", runId: "child-run", childSessionKey: childKey } } }],
  ] as const) kernel.observe({ type: "frame", generation: 1, frame: {
    event: "agent", payload: { runId: input.submissionId, sessionKey, seq, stream: "tool", data },
  } });
  kernel.recoverHistory = async (key) => key === childKey ? { messages: [
    { role: "user", content: "Bot-authored delegation brief", __openclaw: { id: "child-input" } },
    { role: "assistant", stopReason: "stop", content: "Recovered delegated result", __openclaw: { id: "child-final", runId: "child-run" } },
  ] } : { messages: [] };
  await service.reconcile();
  const child = store.list<Task>("tasks").find((task) => task.parentTaskId === parent.id)!;
  assert.equal(child.status, "completed");
  assert.equal(store.messages(input.conversationId).filter((message) => message.role === "user").length, 1);
  const reply = store.messages(input.conversationId).find((message) => message.taskId === child.id)!;
  assert.equal(reply.final, true);
  assert.equal(reply.blocks[0].kind === "text" && reply.blocks[0].text, "Recovered delegated result");
  service.detach(); store.close();
});

test("history reset fetches tail once and reconciles a durable final without duplicate user text", async () => {
  const { store, kernel, service, input } = fixture();
  const task = await service.submit(input);
  const sessionKey = kernel.sent[0].sessionKey;
  store.put("settings", { id: `history:${sessionKey}`, cursor: "stale-cursor" });
  kernel.recoverHistory = async (key, cursor) => {
    kernel.historyCalls.push({ sessionKey: key, cursor });
    return cursor ? { kind: "reset" } : {
      deltaCursor: "fresh-cursor", messages: [{
        role: "user", content: "test", idempotencyKey: `${input.submissionId}:user`,
        __openclaw: { id: "user-row" },
      }, {
        role: "user", content: "Synthetic internal resume instruction",
        provenance: { kind: "internal_system", sourceTool: "restart" },
        __openclaw: { id: "recovery-input" },
      }, {
        role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }],
        __openclaw: { id: "final-row", runId: input.submissionId },
      }],
    };
  };
  await service.reconcileSession(sessionKey);
  assert.deepEqual(kernel.historyCalls.map((call) => call.cursor), ["stale-cursor", undefined]);
  assert.equal(store.messages(input.conversationId).length, 2);
  assert.equal(service.task(task.id).status, "completed");
  assert.equal(store.messages(input.conversationId)[1].final, true);
  assert.ok(store.get("settings", `system-input:${sessionKey}:recovery-input`));
  service.detach(); store.close();
});

test("empty history never claims completion; cancellation waits for the terminal event", async () => {
  const { store, kernel, service, input } = fixture();
  const task = await service.submit(input);
  await service.reconcile();
  assert.equal(service.task(task.id).status, "queued");
  assert.equal((await service.cancel(task.id)).status, "stopping");
  assert.equal(kernel.aborted[0].runId, input.submissionId);
  kernel.observe({ type: "frame", generation: 1, frame: {
    event: "chat", payload: { runId: input.submissionId, sessionKey: kernel.sent[0].sessionKey, state: "aborted" },
  } });
  assert.equal(service.task(task.id).status, "cancelled");
  service.detach(); store.close();
});

test("a stop whose run already ended becomes cancelled instead of stopping forever", async () => {
  const { store, kernel, service, bot, conversation } = fixture();
  const now = Date.now();
  const task: Task = {
    id: "task-orphaned-stop", botId: bot.id, conversationId: conversation.id, reportConversationId: conversation.id,
    title: "Scheduled check", status: "stopping", stopRequestedAt: now - 60_000,
    createdAt: now - 120_000, updatedAt: now - 60_000,
  };
  store.put("tasks", task);
  store.put("runs", {
    id: "run-ended", taskId: task.id, sessionKey: store.engineSessionKey(conversation.id, bot.id),
    generation: 1, state: "completed", lastSequence: 3, createdAt: now - 120_000, endedAt: now - 70_000,
  });
  await service.reconcile();
  assert.equal(service.task(task.id).status, "cancelled");
  assert.deepEqual(kernel.aborted, []);
  service.detach(); store.close();
});

test("recovery keeps waiting when the stopped task still owns a live run", async () => {
  const { store, kernel, service, input } = fixture();
  const task = await service.submit(input);
  await service.cancel(task.id);
  await service.reconcile();
  assert.equal(service.task(task.id).status, "stopping");
  assert.ok(kernel.aborted.some((entry) => entry.runId === input.submissionId));
  kernel.observe({ type: "frame", generation: 1, frame: {
    event: "chat", payload: { runId: input.submissionId, sessionKey: kernel.sent[0].sessionKey, state: "aborted" },
  } });
  assert.equal(service.task(task.id).status, "cancelled");
  service.detach(); store.close();
});

test("events arriving before acknowledgment retain their exact task even with two pending inputs", async () => {
  const { store, kernel, service, input } = fixture();
  const releases = new Map<string, (value: Acceptance) => void>();
  kernel.handler = (submission) => new Promise((resolve) => { releases.set(submission.idempotencyKey, resolve); });
  const first = service.submit(input);
  const second = service.submit({ ...input, submissionId: "input-two", message: "Second" });
  const sessionKey = kernel.sent[0].sessionKey;
  kernel.observe({ type: "frame", generation: 1, frame: {
    event: "chat", payload: { runId: "opaque-first-run", sessionKey, state: "final", message: { content: "First result" } },
  } });
  assert.equal(store.list("runs").length, 0);
  assert.equal(store.pendingFrames("opaque-first-run").length, 1);
  releases.get("input-two")!({ runId: "opaque-second-run", status: "started" });
  const secondTask = await second;
  assert.equal(secondTask.status, "queued");
  releases.get(input.submissionId)!({ runId: "opaque-first-run", status: "started" });
  assert.equal((await first).status, "completed");
  assert.equal(service.task(secondTask.id).status, "queued");
  assert.equal(store.pendingFrames("opaque-first-run").length, 0);
  service.detach(); store.close();
});

test("durable process records enrich a live reply without ending its run and replay recovers each boundary once", async () => {
  const f = fixture();
  try {
    const task = await f.service.submit(f.input);
    const run = f.store.find<Run>("runs", "taskId", task.id)[0];
    f.kernel.observe({ type: "frame", generation: 1, frame: { event: "agent", payload: { runId: run.id, sessionKey: run.sessionKey, seq: 1, stream: "lifecycle", data: { phase: "start" } } } });
    const records = [
      { role: "assistant", stopReason: "toolUse", __openclaw: { id: "process-one", runId: run.id, seq: 2 }, content: [{ type: "thinking", thinking: "Inspect source" }, { type: "toolCall", id: "read-one", name: "read", arguments: {} }] },
      { role: "toolResult", toolCallId: "read-one", __openclaw: { id: "process-result", runId: run.id, seq: 3 }, content: [{ type: "text", text: "Private raw tool bytes" }] },
      { role: "assistant", stopReason: "stop", __openclaw: { id: "process-answer", runId: run.id, seq: 4 }, content: [{ type: "text", text: "Answer while working" }] },
    ];
    for (const message of records) f.kernel.observe({ type: "frame", generation: 1, frame: { event: "session.message", payload: { sessionKey: run.sessionKey, message } } });
    assert.equal(f.store.get<Task>("tasks", task.id)?.status, "running");
    const live = f.store.messages(f.conversation.id).find((message) => message.role === "assistant")!;
    assert.equal(live.final, false);
    assert.deepEqual(live.blocks.map((block) => block.kind), ["reasoning", "tool", "text"]);
    assert.equal(live.blocks[1].kind === "tool" && live.blocks[1].phase, "result");
    f.kernel.history = { messages: records };
    await f.service.reconcile();
    await f.service.reconcile();
    const recovered = f.store.messages(f.conversation.id).find((message) => message.role === "assistant")!;
    assert.deepEqual(recovered.blocks.map((block) => block.kind), ["reasoning", "tool", "text"]);
    assert.ok(!JSON.stringify(recovered.blocks).includes("Private raw tool bytes"));
  } finally { f.service.detach(); f.store.close(); }
});
