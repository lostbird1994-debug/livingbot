import assert from "node:assert/strict";
import test from "node:test";
import { deliveredMessages } from "./delivery-messages.ts";
import { EngineProjector } from "./projector.ts";
import { WorkbenchStore } from "./store.ts";
import type { Message, Run, Task } from "./contracts.ts";

function fixture() {
  const store = new WorkbenchStore(":memory:");
  const bot = store.createBot({ name: "Atlas", agentId: "atlas" });
  const chat = store.privateConversation(bot.id);
  const { task, submission } = store.beginSubmission({ submissionId: "input", botId: bot.id,
    conversationId: chat.id, message: "Check only when scheduled" });
  store.acceptSubmission(submission.id, "run", 1);
  store.put<Task>("tasks", { ...task, status: "running", routine: {
    id: "routine", jobId: "job", runId: "run", occurrenceId: "occurrence", sessionId: "session",
  } });
  store.put<Run>("runs", { ...store.get<Run>("runs", "run")!, state: "running" });
  store.markRead(chat.id);
  const projector = new EngineProjector(store);
  const tool = () => projector.frame(1, { event: "agent", payload: { runId: "run", sessionKey: submission.sessionKey,
    stream: "tool", seq: 1, data: { toolCallId: "tool", name: "clock", phase: "result" } } });
  const finish = (text: string) => projector.frame(1, { event: "chat", payload: {
    runId: "run", sessionKey: submission.sessionKey, seq: 2, state: "final", message: { content: text },
  } });
  return { store, chat, tool, finish, task };
}

test("quiet routine retains task and tool receipts without a reply, unread dot or notification", () => {
  const f = fixture();
  try {
    f.tool();
    assert.equal(f.store.messages(f.chat.id).filter(m => m.role === "assistant").length, 0);
    assert.equal(f.store.readState(f.chat.id).unread, false);
    f.finish("  \n");
    assert.equal(f.store.get<Task>("tasks", f.task.id)!.status, "completed");
    assert.ok(f.store.get<Message>("messages", "engine:run")!.blocks.some(b => b.kind === "tool"));
    assert.equal(f.store.messages(f.chat.id).filter(m => m.role === "assistant").length, 0);
    assert.equal(f.store.readState(f.chat.id).unread, false);
    assert.equal(f.store.list("notifications").length, 0);
  } finally { f.store.close(); }
});

test("native NO_REPLY is silent even after narration; visible files and questions survive", () => {
  const f = fixture();
  try {
    f.tool();
    const working = f.store.get<Message>("messages", "engine:run")!;
    f.store.put("messages", { ...working, blocks: [...working.blocks, { id: "progress", kind: "text", text: "Checking the schedule" }] });
    assert.equal(f.store.readState(f.chat.id).unread, false);
    f.finish("NO_REPLY");
    const raw = f.store.get<Message>("messages", "engine:run")!;
    assert.equal(raw.silent, true);
    assert.equal(f.store.messages(f.chat.id).filter(m => m.role === "assistant").length, 0);
    const file: Message = { ...raw, blocks: [...raw.blocks, { id: "file", kind: "file", artifactId: "a", name: "report.xlsx", mediaType: "application/octet-stream" }] };
    assert.equal(deliveredMessages([file], []).length, 1);
    const question: Message = { ...raw, silent: false, blocks: [{ id: "ask", kind: "question", requestId: "q", title: "Choose a source", payload: {} }] };
    assert.equal(deliveredMessages([question], []).length, 1);
    assert.equal(deliveredMessages([{ ...raw, silent: false, blocks: [{ id: "t", kind: "text", text: "The protocol token is NO_REPLY." }] }], []).length, 1);
  } finally { f.store.close(); }
});

test("historical finalized reasoning/tool-only replies are hidden without changing stored evidence", () => {
  const f = fixture();
  try {
    const raw: Message = { id: "history", conversationId: f.chat.id, botId: f.task.botId, role: "assistant", final: true,
      createdAt: 1, updatedAt: 1, blocks: [{ id: "r", kind: "reasoning", text: "Internal reasoning" }] };
    f.store.put("messages", raw);
    assert.ok(!f.store.messages(f.chat.id).some(m => m.id === raw.id));
    assert.deepEqual(f.store.get("messages", raw.id), raw);
  } finally { f.store.close(); }
});
