import assert from "node:assert/strict";
import test from "node:test";
import { EngineProjector } from "./projector.ts";
import { WorkbenchStore } from "./store.ts";
import { mergeNativeMessage, nativeMessageBlocks } from "./native-message-blocks.ts";
import type { Message } from "./contracts.ts";

function fixture() {
  const store = new WorkbenchStore(":memory:");
  const bot = store.createBot({ name: "Test Bot" });
  const conversation = store.privateConversation(bot.id);
  const input = { botId: bot.id, conversationId: conversation.id };
  const first = store.beginSubmission({ ...input, submissionId: "first", message: "Start" });
  store.acceptSubmission(first.submission.id, "run", 1);
  const projector = new EngineProjector(store);
  let seq = 0;
  const frame = (stream: string, data: object) => projector.frame(1, { event: "agent", payload: {
    runId: "run", sessionKey: first.submission.sessionKey, seq: seq++, stream, data,
  } });
  frame("lifecycle", { phase: "start" });
  const interrupt = (id: string, options: object = {}) => store.beginSubmission({
    ...input, submissionId: id, message: id, queueMode: "steer", ...options,
  });
  const messages = () => store.messages(conversation.id);
  const text = (message: Message) => message.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("");
  return { store, frame, interrupt, messages, text, conversation, first, projector, input };
}

test("a cumulative stream splits around consecutive interruptions without losing repeated wording", () => {
  const f = fixture();
  try {
    f.frame("assistant", { itemId: "answer", text: "One." });
    f.interrupt("second");
    f.frame("assistant", { itemId: "answer", text: "One.One." });
    f.interrupt("third");
    f.frame("assistant", { itemId: "answer", text: "One.One.Three." });
    assert.deepEqual(f.messages().map(f.text), ["Start", "One.", "second", "One.", "third", "Three."]);
    const parts = f.messages().filter((message) => message.role === "assistant");
    assert.deepEqual(parts.map((message) => message.final), [true, true, false]);
    assert.ok(parts.every((message) => message.runId === "run" && message.taskId === f.first.task.id));
    for (const part of parts.slice(1)) assert.deepEqual(f.store.get("messages", part.id), part);
    const before = f.messages();
    f.interrupt("third"); // An idempotent retry must not create another cut.
    assert.deepEqual(f.messages(), before);
  } finally { f.store.close(); }
});

test("native identity replacement and terminal replay preserve frozen prefixes and tool ownership", () => {
  const f = fixture();
  try {
    f.frame("assistant", { text: "Before." });
    f.frame("tool", { toolCallId: "tool", name: "read", phase: "start" });
    f.interrupt("second");
    f.frame("tool", { toolCallId: "tool", name: "read", phase: "result" });
    f.frame("assistant", { text: "After." });
    const message = f.store.get<Message>("messages", "engine:run")!;
    const beforeBlocks = nativeMessageBlocks({ content: [
        { type: "text", text: "Before." },
        { type: "toolCall", id: "tool", name: "read", arguments: {} },
      ], __openclaw: { seq: 1 } }, "native-before");
    const afterBlocks = nativeMessageBlocks({ content: [{ type: "text", text: "After." }], __openclaw: { seq: 2 } }, "native-after");
    const blocks = mergeNativeMessage(mergeNativeMessage(message.blocks, beforeBlocks), afterBlocks);
    f.store.put("messages", { ...message, blocks, final: true });
    assert.deepEqual(f.messages().map(f.text), ["Start", "Before.", "second", "After."]);
    const tool = f.messages()[1].blocks.find((block) => block.kind === "tool");
    assert.equal(tool?.kind === "tool" && tool.phase, "result");
    // A replay with the same identities must neither move nor duplicate parts.
    const final = f.store.get<Message>("messages", "engine:run")!;
    const before = f.messages();
    f.store.put("messages", { ...final, blocks: mergeNativeMessage(mergeNativeMessage(final.blocks, beforeBlocks), afterBlocks) });
    assert.deepEqual(f.messages(), before);
  } finally { f.store.close(); }
});

test("an interruption before any visible reply places all later output below the input", () => {
  const f = fixture();
  try {
    f.interrupt("second");
    f.frame("assistant", { text: "Later." });
    assert.deepEqual(f.messages().map(f.text), ["Start", "second", "Later."]);
  } finally { f.store.close(); }
});

test("hidden inputs do not split a reply and other conversations stay untouched", () => {
  const f = fixture();
  try {
    f.frame("assistant", { text: "Before." });
    f.interrupt("hidden", { hiddenInput: true });
    const other = f.store.createConversation("private", [f.input.botId], "Other");
    f.store.beginSubmission({ ...f.input, conversationId: other.id, submissionId: "other", message: "Elsewhere" });
    f.frame("assistant", { text: "Before.After." });
    assert.deepEqual(f.messages().map(f.text), ["Start", "Before.After."]);
  } finally { f.store.close(); }
});

test("files and widgets keep resolvable ownership and a separate report has no phantom interruptions", () => {
  const f = fixture();
  try {
    f.frame("assistant", { text: "Before." });
    f.interrupt("second");
    f.frame("assistant", { text: "Before.After." });
    const reply = f.store.get<Message>("messages", "engine:run")!;
    f.store.put("messages", { ...reply, blocks: [...reply.blocks,
      { id: "widget:view", kind: "widget", docId: "view", title: "Preview", sessionKey: f.first.submission.sessionKey },
      { id: "file:result", kind: "file", artifactId: "result", name: "result.txt", mediaType: "text/plain" },
    ] });
    const part = f.messages().at(-1)!;
    assert.deepEqual(part.blocks.map((block) => block.kind), ["text", "widget", "file"]);
    assert.equal(f.store.get<Message>("messages", part.id)?.blocks.find((block) => block.kind === "widget")?.docId, "view");
    const other = f.store.createConversation("private", [f.input.botId], "Report");
    f.store.put("messages", { ...f.store.get<Message>("messages", "engine:run")!, id: "report:test",
      conversationId: other.id, final: true });
    assert.deepEqual(f.store.messages(other.id).map(f.text), ["Before.After."]);
  } finally { f.store.close(); }
});
