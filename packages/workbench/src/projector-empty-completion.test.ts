import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchStore } from "./store.ts";
import { EngineProjector } from "./projector.ts";
import type { Message, Task } from "./contracts.ts";

function fixture(queueMode?: "steer" | "followup") {
  const store = new WorkbenchStore(":memory:");
  const bot = store.createBot({ name: "Atlas", agentId: "atlas" });
  const conversation = store.privateConversation(bot.id);
  const { task, submission } = store.beginSubmission({
    submissionId: "input-1", conversationId: conversation.id, botId: bot.id, message: "把这条命令交给后台执行",
  });
  store.acceptSubmission(submission.id, "run-1", 1);
  if (queueMode) {
    // A steering input on the same task and run, as the product records it.
    store.put("submissions", {
      ...submission, id: "input-2", message: "补充一句", queueMode, state: "accepted", engineRunId: "run-1",
    });
  }
  const projector = new EngineProjector(store);
  const complete = () => projector.frame(1, { event: "chat", payload: {
    runId: "run-1", sessionKey: submission.sessionKey, seq: 9, state: "final", message: { content: "" },
  } });
  const assistant = () => store.find<Message>("messages", "taskId", task.id)
    .find((message) => message.role === "assistant");
  return { store, task, complete, assistant };
}

test("an accepted ordinary input with no turn is reported as an unconfirmed result, not a successful empty answer", () => {
  const f = fixture();
  f.complete();
  const task = f.store.get<Task>("tasks", f.task.id)!;
  assert.equal(task.status, "failed");
  const message = f.assistant()!;
  assert.equal(message.final, true);
  const text = message.blocks.map((block) => (block.kind === "text" ? block.text : "")).join(" ");
  assert.match(text, /无法确认是否已经执行/);
  assert.doesNotMatch(text, /没有开始执行/);
  assert.doesNotMatch(text, /已重试|已重新发送/);
});

test("a steering input folded into the active turn keeps its own meaning", () => {
  const f = fixture("steer");
  f.complete();
  const task = f.store.get<Task>("tasks", f.task.id)!;
  assert.equal(task.status, "completed");
  assert.equal(task.inputDisposition, "steered");
  const text = (f.assistant()?.blocks ?? []).map((block) => (block.kind === "text" ? block.text : "")).join(" ");
  assert.doesNotMatch(text, /无法确认/);
});

test("a real failure still reports the actual error", () => {
  const f = fixture();
  f.store.updateTask(f.task.id, "failed", "boom");
  const message = f.assistant();
  // No frame was sent: the projector has not produced a status block yet.
  assert.equal(message, undefined);
});
