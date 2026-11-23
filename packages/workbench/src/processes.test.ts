import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayRequests, ProcessPage, ProcessSummary } from "../../kernel-runtime/src/contracts.ts";
import type { Run, Task } from "./contracts.ts";
import { Processes, recordNativeProcess } from "./processes.ts";
import { WorkbenchStore } from "./store.ts";
import { EngineProjector } from "./projector.ts";

function fixture() {
  const store = new WorkbenchStore(":memory:");
  const bot = store.createBot({ name: "Atlas", agentId: "atlas" });
  const conversation = store.privateConversation(bot.id);
  const { task, submission } = store.beginSubmission({
    submissionId: "input-1", conversationId: conversation.id, botId: bot.id, message: "Run synthetic work",
  });
  store.acceptSubmission(submission.id, "run-1", 1);
  const run = store.get<Run>("runs", "run-1")!;
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const native: ProcessSummary = {
    processId: "program-1", instanceId: "instance-1", name: "synthetic", startedAt: 123,
    status: "running", tail: "", canStop: true,
  };
  const page: ProcessPage = { sessionId: "native-session-1", processes: [native], truncated: false };
  let rejectStop = false;
  const gateway: GatewayRequests = {
    async request<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params: params as Record<string, unknown> });
      if (method === "sessions.processes.list") return structuredClone(page) as T;
      if (rejectStop) throw new Error("Synthetic stop unavailable");
      return { requested: true } as T;
    },
  };
  const processes = new Processes(store, gateway);
  const receipt = (selected = task, selectedRun = run) => recordNativeProcess(store, selected, selectedRun, {
    name: "exec", phase: "result", toolCallId: "exec-1",
    result: { details: { status: "running", sessionId: "program-1", startedAt: 123, pid: 999, cwd: "/private/path" } },
  });
  const stopIntent = () => store.put("tasks", { ...store.get<Task>("tasks", task.id)!, stopRequestedAt: 150 });
  const current = () => store.get<Task>("tasks", task.id)!.processes![0];
  return { store, bot, conversation, task, run, processes, calls, native, page, receipt, stopIntent, current,
    rejectStop: () => { rejectStop = true; } };
}

test("an exact exec receipt owns a process; unowned processes in the same conversation are never stopped", async () => {
  const f = fixture();
  f.receipt();
  f.page.processes.push({ ...f.native, processId: "unrelated", instanceId: "unrelated-instance" });
  await f.processes.refresh(f.run.sessionKey);
  assert.equal(f.current().instanceId, "instance-1");
  assert.ok(!JSON.stringify(f.current()).includes("/private/path"));
  f.stopIntent();
  await f.processes.stopTask(f.task.id);
  const stopped = f.calls.filter((call) => call.method === "sessions.processes.stop");
  assert.deepEqual(stopped.map((call) => call.params), [{
    key: f.run.sessionKey, sessionId: "native-session-1", processId: "program-1", instanceId: "instance-1",
  }]);
  assert.equal(f.current().status, "stopping", "A receipt is not an exit");
  f.native.status = "killed"; f.native.canStop = false;
  await f.processes.refresh(f.run.sessionKey);
  assert.equal(f.current().status, "killed");
  await f.processes.stopTask(f.task.id);
  assert.equal(f.calls.filter((call) => call.method === "sessions.processes.stop").length, 1);
  f.store.close();
});

test("reused process identifiers, changed sessions and truncated observations never authorize killing an unknown instance", async () => {
  for (const changed of ["startedAt", "instanceId", "sessionId", "truncated"] as const) {
    const f = fixture();
    f.receipt();
    await f.processes.refresh(f.run.sessionKey);
    if (changed === "startedAt") f.native.startedAt++;
    if (changed === "instanceId") f.native.instanceId = "replacement";
    if (changed === "sessionId") f.page.sessionId = "replacement-session";
    if (changed === "truncated") { f.page.processes = []; f.page.truncated = true; }
    f.stopIntent();
    await f.processes.stopTask(f.task.id);
    assert.equal(f.current().status, "unavailable");
    assert.equal(f.calls.filter((call) => call.method === "sessions.processes.stop").length, 0);
    f.store.close();
  }
});

test("one denied or failed stop still attempts other owned programs and retains a retryable outcome", async () => {
  for (const denied of [false, true]) {
    const f = fixture();
    f.receipt();
    recordNativeProcess(f.store, f.task, f.run, {
      name: "exec", phase: "update", toolCallId: "exec-2",
      partialResult: { details: { sessionId: "program-2", startedAt: 456 } },
    });
    f.page.processes.push({ ...f.native, processId: "program-2", instanceId: "instance-2", startedAt: 456 });
    if (denied) f.native.canStop = false;
    else f.rejectStop();
    f.stopIntent();
    await assert.rejects(f.processes.stopTask(f.task.id), /cleanup/);
    const stops = f.calls.filter((call) => call.method === "sessions.processes.stop");
    assert.ok(stops.some((call) => call.params.processId === "program-2"));
    if (denied) assert.ok(!stops.some((call) => call.params.processId === "program-1"));
    assert.equal(f.current().status, "unavailable");
    assert.ok(f.current().stopError);
    f.store.close();
  }
});

test("a restored exact process observation clears read uncertainty without erasing a failed-stop outcome", async () => {
  const f = fixture();
  f.receipt();
  f.page.processes = [];
  await f.processes.refresh(f.run.sessionKey);
  assert.equal(f.current().status, "unavailable");
  assert.equal(f.current().errorKind, "observation");
  f.page.processes = [f.native];
  await f.processes.refresh(f.run.sessionKey);
  assert.equal(f.current().status, "running");
  assert.equal(f.current().stopError, undefined);
  f.rejectStop(); f.stopIntent();
  await assert.rejects(f.processes.stopTask(f.task.id));
  await f.processes.refresh(f.run.sessionKey);
  assert.equal(f.current().status, "unavailable");
  assert.equal(f.current().errorKind, "stop");
  f.store.close();
});

test("late exec receipts on a terminal run preserve task ownership and durable stop intent", async () => {
  const f = fixture();
  const projector = new EngineProjector(f.store);
  projector.frame(1, { event: "chat", payload: {
    runId: f.run.id, sessionKey: f.run.sessionKey, seq: 1, state: "final", message: { content: "Started service" },
  } });
  f.stopIntent();
  projector.frame(1, { event: "agent", payload: {
    runId: f.run.id, sessionKey: f.run.sessionKey, seq: 2, stream: "tool", data: {
      name: "exec", phase: "result", toolCallId: "exec-1",
      result: { details: { status: "running", sessionId: "program-1", startedAt: 123 } },
    },
  } });
  assert.equal(f.store.get<Task>("tasks", f.task.id)?.status, "completed");
  await f.processes.recover();
  assert.ok(f.calls.some((call) => call.method === "sessions.processes.stop"));
  assert.equal(f.current().status, "stopping");
  f.store.close();
});

test("an exec receipt cannot transfer another task's process ownership or infer it from text", () => {
  const f = fixture();
  f.receipt();
  const other = f.store.beginSubmission({
    submissionId: "input-2", conversationId: f.conversation.id, botId: f.bot.id, message: "Another task",
  });
  f.store.acceptSubmission(other.submission.id, "run-2", 1);
  f.receipt(other.task, f.store.get<Run>("runs", "run-2")!);
  assert.equal(f.store.get<Task>("tasks", other.task.id)?.processes, undefined);
  assert.ok(f.store.eventsAfter(0).some((event) => event.type === "operation.failed"));
  recordNativeProcess(f.store, other.task, f.run, {
    name: "exec", phase: "result", toolCallId: "untrusted",
    result: { content: [{ type: "text", text: "Command running session program-2" }] },
  });
  assert.equal(f.store.get<Task>("tasks", other.task.id)?.processes, undefined);
  f.store.close();
});

test("foreground cleanup requires both exact native acknowledgment and the cancelled terminal, in either order", () => {
  for (const acknowledgmentFirst of [true, false]) {
    const f = fixture();
    recordNativeProcess(f.store, f.task, f.run, {
      name: "exec", phase: "update", toolCallId: "foreground",
      partialResult: { details: { status: "running", sessionId: "program-1", startedAt: 123 } },
    });
    const projector = new EngineProjector(f.store);
    const cancelled = () => {
      const frame = { event: "chat", payload: { runId: f.run.id, sessionKey: f.run.sessionKey, state: "aborted" } };
      projector.frame(1, frame);
      f.processes.observe({ type: "frame", generation: 1, frame });
    };
    const acknowledge = () => f.processes.confirmAbort(f.run.id, { aborted: true, runIds: [f.run.id] });
    f.processes.confirmAbort(f.run.id, { aborted: true, runIds: ["unrelated"] });
    assert.equal(f.current().status, "running");
    if (acknowledgmentFirst) acknowledge(); else cancelled();
    assert.equal(f.current().status, "running", "One fact alone does not establish cleanup");
    if (acknowledgmentFirst) cancelled(); else acknowledge();
    assert.equal(f.current().status, "killed");
    f.store.close();
  }
});

test("cleanup still owns a recent program after the task inventory exceeds its display limit", async () => {
  const f = fixture();
  for (let index = 0; index < 1001; index++) f.store.put("tasks", { ...f.task, id: `historical-${index}` });
  const latest = f.store.beginSubmission({
    submissionId: "latest", conversationId: f.conversation.id, botId: f.bot.id, message: "Recent program",
  });
  f.store.acceptSubmission(latest.submission.id, "latest-run", 1);
  const run = f.store.get<Run>("runs", "latest-run")!;
  f.receipt(latest.task, run);
  f.store.put("tasks", { ...f.store.get<Task>("tasks", latest.task.id)!, stopRequestedAt: 200 });
  await f.processes.stopTask(latest.task.id);
  assert.equal(f.calls.filter((call) => call.method === "sessions.processes.stop").length, 1);
  assert.equal(f.store.get<Task>("tasks", latest.task.id)?.processes?.[0].status, "stopping");
  f.store.close();
});
