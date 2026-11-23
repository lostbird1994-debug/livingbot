import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchStore } from "./store.ts";
import { EngineProjector } from "./projector.ts";
import type { Run, Task } from "./contracts.ts";

function fixture() {
  const store = new WorkbenchStore(":memory:");
  const bot = store.createBot({ name: "Atlas", agentId: "atlas" });
  const conversation = store.privateConversation(bot.id);
  const { task, submission } = store.beginSubmission({
    submissionId: "input-1", conversationId: conversation.id, botId: bot.id, message: "Delegate the synthetic task",
  });
  store.acceptSubmission(submission.id, "parent-run", 1);
  const projector = new EngineProjector(store);
  const childKey = "agent:atlas:acp:synthetic-child";
  const frame = (seq: number, data: Record<string, unknown>) => projector.frame(1, {
    event: "agent", payload: { runId: "parent-run", sessionKey: submission.sessionKey, stream: "tool", seq, data },
  });
  const start = () => frame(1, {
    name: "sessions_spawn", phase: "start", toolCallId: "spawn-1",
    args: { runtime: "acp", agentId: "codex", task: "Read synthetic evidence" },
  });
  const accept = (runId = "child-run", key = childKey) => frame(3, {
    name: "sessions_spawn", phase: "result", toolCallId: "spawn-1",
    result: { details: { status: "accepted", runId, childSessionKey: key } },
  });
  return { store, bot, conversation, task, submission, projector, childKey, start, accept, frame };
}

test("an exact ACP receipt adopts one owned child and replays its early final without completing its parent", () => {
  const f = fixture();
  f.start();
  f.projector.frame(1, { event: "chat", payload: {
    runId: "child-run", sessionKey: f.childKey, seq: 4, state: "final", message: { content: "Synthetic delegated result" },
  } });
  assert.equal(f.store.list("tasks").length, 1);
  f.accept();
  const child = f.store.list<Task>("tasks").find((task) => task.parentTaskId === f.task.id)!;
  assert.ok(child);
  assert.equal(child.delegation?.executor, "codex");
  assert.equal(child.delegation?.sessionKey, f.childKey);
  assert.equal(child.status, "completed");
  assert.equal(f.store.get<Task>("tasks", f.task.id)?.status, "running");
  assert.equal(f.store.messages(f.conversation.id).filter((message) => message.role === "user").length, 1);
  assert.equal(f.store.messages(f.conversation.id).find((message) => message.taskId === child.id)?.final, true);
  f.accept();
  assert.equal(f.store.list("tasks").length, 2);
  f.store.close();
});

test("unknown, failed and conflicting child receipts cannot claim another native run", () => {
  let f = fixture();
  f.accept();
  assert.equal(f.store.list("tasks").length, 1);
  f.store.close();
  f = fixture();
  f.start();
  f.frame(2, { name: "sessions_spawn", phase: "result", toolCallId: "spawn-1", isError: true,
    result: { details: { status: "accepted", runId: "child-run", childSessionKey: f.childKey } },
  });
  assert.equal(f.store.list("tasks").length, 1);
  f.accept("parent-run", f.submission.sessionKey);
  assert.equal(f.store.list("tasks").length, 1);
  const another = f.store.createBot({ name: "Other", agentId: "other" });
  const otherSubmission = f.store.beginSubmission({
    submissionId: "other-input", conversationId: f.store.privateConversation(another.id).id,
    botId: another.id, message: "Other work",
  });
  f.store.acceptSubmission(otherSubmission.submission.id, "other-run", 1);
  f.accept("other-run", f.childKey);
  assert.equal(f.store.list("tasks").length, 2);
  assert.equal(f.store.get<Run>("runs", "other-run")?.taskId, otherSubmission.task.id);
  assert.ok(f.store.eventsAfter(0).some((event) => event.type === "operation.failed"));
  f.store.close();
});

test("a late child receipt preserves a terminal parent and interrupted children retain restart ownership", () => {
  const f = fixture();
  f.start();
  f.projector.frame(1, { event: "chat", payload: {
    runId: "parent-run", sessionKey: f.submission.sessionKey, seq: 2, state: "final", message: { content: "Assigned" },
  } });
  f.accept();
  const child = f.store.list<Task>("tasks").find((task) => task.parentTaskId === f.task.id)!;
  assert.equal(f.store.get<Task>("tasks", f.task.id)?.status, "completed");
  f.projector.frame(1, { event: "agent", payload: {
    runId: "child-run", sessionKey: f.childKey, seq: 1, stream: "lifecycle", data: { phase: "start" },
  } });
  f.projector.observe({ type: "exit", code: 0, signal: null, generation: 1 });
  assert.equal(f.store.get<Task>("tasks", child.id)?.status, "interrupted");
  f.projector.frame(2, { event: "agent", payload: {
    runId: "resumed-child-run", sessionKey: f.childKey, seq: 1, stream: "lifecycle", data: { phase: "start" },
  } });
  assert.equal(f.store.get<Task>("tasks", child.id)?.status, "running");
  assert.equal(f.store.get<Run>("runs", "resumed-child-run")?.taskId, child.id);
  assert.equal(f.store.list("tasks").length, 2);
  f.store.close();
});

test("a native default harness is tracked without guessing the missing executor identity", () => {
  const f = fixture();
  f.frame(1, {
    name: "sessions_spawn", phase: "start", toolCallId: "spawn-1", args: { runtime: "acp", task: "Synthetic default task" },
  });
  f.accept();
  const child = f.store.list<Task>("tasks").find((task) => task.parentTaskId === f.task.id)!;
  assert.equal(child.delegation?.executor, "外部执行器");
  assert.equal(child.status, "queued");
  f.store.close();
});
