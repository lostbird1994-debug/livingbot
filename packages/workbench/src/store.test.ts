import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Block, Message, Run, Task } from "./contracts.ts";
import { WorkbenchStore } from "./store.ts";
import { EngineProjector } from "./projector.ts";

function setup() {
  const store = new WorkbenchStore(":memory:");
  const bot = store.createBot({ name: "Example", agentId: "example" });
  const conversation = store.createConversation("private", [bot.id], "Example conversation");
  const submission = store.beginSubmission({
    submissionId: "submission-1", conversationId: conversation.id, botId: bot.id, message: "Synthetic task",
  });
  const projector = new EngineProjector(store);
  return { store, bot, conversation, ...submission, projector };
}

test("submission identity is durable, conflicts are refused and user input appears once", () => {
  const { store, bot, conversation, task } = setup();
  const repeated = store.beginSubmission({
    submissionId: "submission-1", conversationId: conversation.id, botId: bot.id, message: "Synthetic task",
  });
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.task.id, task.id);
  assert.equal(store.messages(conversation.id).length, 1);
  assert.throws(() => store.beginSubmission({
    submissionId: "submission-1", conversationId: conversation.id, botId: bot.id, message: "Changed",
  }), /conflicts/);
  store.close();
});

test("product transactions publish only after commit and rollback records with their events", () => {
  const store = new WorkbenchStore(":memory:");
  const delivered: unknown[] = [];
  store.on("event", (event) => delivered.push(event));
  assert.throws(() => store.transaction(() => {
    store.createBot({ name: "Rollback", id: "rollback", agentId: "rollback" });
    assert.equal(delivered.length, 0);
    throw new Error("Synthetic storage workflow failure");
  }));
  assert.equal(store.get("bots", "rollback"), undefined);
  assert.equal(store.cursor(), 0);
  assert.equal(delivered.length, 0);
  store.createBot({ name: "Committed", agentId: "committed" });
  assert.equal(delivered.length, 1);
  store.close();
});

test("spaces persist with Bot and group ownership; removing one preserves its conversations", () => {
  const store = new WorkbenchStore(":memory:");
  const space = store.createSpace("项目组");
  const first = store.createBot({ name: "First", agentId: "first", spaceId: space.id });
  const second = store.createBot({ name: "Second", agentId: "second", spaceId: space.id });
  const group = store.createConversation("group", [first.id, second.id], "Project");
  const defaultBot = store.createBot({ name: "Default", agentId: "default" });
  assert.equal(first.spaceId, space.id);
  assert.equal(group.spaceId, space.id);
  assert.equal(store.spaceIdForBot(defaultBot.id), "local");
  assert.throws(() => store.createConversation("group", [first.id, defaultBot.id], "Invalid"), /one space/);
  assert.equal(store.listSpaces().length, 2);
  store.removeSpace(space.id);
  assert.equal(store.get("spaces", space.id), undefined);
  assert.equal(store.spaceIdForBot(first.id), "local");
  assert.equal(store.get<typeof group>("conversations", group.id)?.spaceId, "local");
  store.close();
});

test("ordered text, bounded reasoning model and tools preserve boundaries; equal-sequence final is not lost", () => {
  const { store, projector, submission, task, conversation } = setup();
  store.acceptSubmission(submission.id, "run-1", 1);
  const sessionKey = submission.sessionKey;
  const frame = (stream: string, seq: number, data: Record<string, unknown>) =>
    projector.frame(1, { event: "agent", payload: { sessionKey, runId: "run-1", seq, stream, data } });
  frame("lifecycle", 1, { phase: "start" });
  frame("assistant", 2, { itemId: "comment", text: "Checking the input." });
  frame("reasoning", 3, { itemId: "thought", text: "Synthetic reasoning." });
  frame("item", 4, { kind: "tool", toolCallId: "read-1", name: "read", title: "Read the source file", phase: "start" });
  frame("tool", 5, { toolCallId: "read-1", name: "read", phase: "start" });
  frame("tool", 6, { toolCallId: "read-1", name: "read", phase: "result" });
  frame("assistant", 7, { itemId: "answer", text: "Completed." });
  frame("lifecycle", 8, { phase: "end" });
  const final = {
    event: "chat",
    payload: { sessionKey, runId: "run-1", seq: 8, state: "final", message: { content: [{ type: "text", text: "Completed." }] } },
  };
  projector.frame(1, final);
  const cursor = store.cursor();
  projector.frame(1, final);
  frame("lifecycle", 9, { phase: "start" });
  assert.equal(store.cursor(), cursor);
  assert.equal(store.get<Task>("tasks", task.id)?.status, "completed");
  const reply = store.messages(conversation.id).find((message) => message.role === "assistant");
  assert.deepEqual(reply?.blocks.map((block) => block.kind), ["text", "reasoning", "tool", "text"]);
  assert.equal(reply?.blocks[2].kind === "tool" && reply.blocks[2].title, "Read the source file");
  assert.equal(reply?.final, true);
  store.close();
});

test("native thinking persistence receipts and interleaved item updates never duplicate reasoning", () => {
  const { store, projector, submission, conversation } = setup();
  store.acceptSubmission(submission.id, "thinking-run", 1);
  const frame = (stream: string, seq: number, data: Record<string, unknown>) => projector.frame(1, {
    event: "agent", payload: { runId: "thinking-run", sessionKey: submission.sessionKey, seq, stream, data },
  });
  frame("thinking", 1, { itemId: "first-thought", text: "First reasoning." });
  frame("assistant", 2, { itemId: "commentary", text: "Reading the workspace." });
  frame("thinking", 3, {
    phase: "persisted", itemId: "first-thought", messageId: "native-first-message", messageRunId: "thinking-run",
  });
  frame("tool", 4, { toolCallId: "read-workspace", name: "read", phase: "result" });
  frame("thinking", 5, { itemId: "first-thought", text: "First reasoning, corrected." });
  frame("thinking", 6, { itemId: "second-thought", text: "Second reasoning." });
  frame("thinking", 7, { phase: "persisted", itemId: "unknown-receipt", messageId: "native-other-message" });
  const reply = store.messages(conversation.id).find((message) => message.role === "assistant")!;
  assert.deepEqual(reply.blocks.map((block) => block.kind), ["reasoning", "text", "tool", "reasoning"]);
  assert.equal(new Set(reply.blocks.map((block) => block.id)).size, reply.blocks.length);
  assert.equal(reply.blocks[0].kind === "reasoning" && reply.blocks[0].text, "First reasoning, corrected.");
  projector.frame(1, { event: "chat", payload: {
    sessionKey: submission.sessionKey, runId: "thinking-run", seq: 8,
    state: "final", message: { content: "Final answer." },
  } });
  const final = store.get<Message>("messages", reply.id)!;
  assert.deepEqual(final.blocks.map((block) => block.kind), ["reasoning", "text", "tool", "reasoning", "text"]);
  store.close();
});

test("catalog calls retain native parent ownership across tool updates", () => {
  const { store, projector, submission, conversation } = setup();
  store.acceptSubmission(submission.id, "catalog-run", 1);
  const frame = (seq: number, data: Record<string, unknown>) => projector.frame(1, {
    event: "agent", payload: { runId: "catalog-run", sessionKey: submission.sessionKey, seq, stream: "tool", data },
  });
  frame(1, { toolCallId: "wrapper", name: "dispatch_action", phase: "start" });
  frame(2, { toolCallId: "target", parentToolCallId: "wrapper", name: "ask_user", phase: "start" });
  frame(3, { toolCallId: "target", name: "ask_user", phase: "result" });
  const blocks = store.messages(conversation.id).flatMap((message) => message.blocks).filter((block) => block.kind === "tool");
  assert.equal(blocks.length, 2);
  const child = blocks.find((block) => block.id === "tool:target");
  assert.equal(child?.kind === "tool" && child.parentId, "tool:wrapper");
  store.close();
});

test("late native tool results update final group and private receipts without reopening work or notifying twice", () => {
  for (const state of ["final", "error", "aborted"]) {
    const { store, bot, projector } = setup();
    try {
      const group = store.createConversation("group", [bot.id], "Synthetic receipt group");
      const destination = store.privateConversation(bot.id);
      const { task, submission } = store.beginSubmission({
        submissionId: "late-result", conversationId: group.id, botId: bot.id,
        reportConversationId: destination.id, message: "Synthetic tool receipt",
      });
      store.acceptSubmission(submission.id, "late-run", 1);
      const payload = { sessionKey: submission.sessionKey, runId: "late-run" };
      projector.frame(1, { event: "agent", payload: {
        ...payload, seq: 1, stream: "tool", data: {
          toolCallId: "child-call", parentToolCallId: "wrapper", name: "read",
          title: "Read synthetic task file", phase: "start",
        },
      } });
      projector.frame(1, { event: "chat", payload: {
        ...payload, seq: 2, state, message: { content: "Synthetic final report." },
      } });
      const beforeTask = store.get<Task>("tasks", task.id);
      const beforeRun = store.get<Run>("runs", "late-run");
      const notices = store.snapshot().notifications;
      const messages = [`engine:late-run`, `report:${task.id}`]
        .map((id) => store.get<Message>("messages", id)!);
      const result = { event: "agent", payload: {
        ...payload, seq: 3, stream: "tool", data: { toolCallId: "child-call", phase: "result", result: { ok: true } },
      } };
      projector.frame(1, result);
      for (const previous of messages) {
        const current = store.get<Message>("messages", previous.id)!;
        assert.equal(current.final, true);
        assert.ok(current.updatedAt > previous.updatedAt);
        assert.deepEqual(current.blocks.filter((block) => block.kind !== "tool"),
          previous.blocks.filter((block) => block.kind !== "tool"));
        const tool = current.blocks.find((block) => block.kind === "tool")!;
        assert.equal(tool.phase, "result");
        assert.equal(tool.name, "read");
        assert.equal(tool.title, "Read synthetic task file");
        assert.equal(tool.parentId, "tool:wrapper");
      }
      const cursor = store.cursor();
      projector.frame(1, result);
      projector.frame(1, { event: "agent", payload: {
        ...payload, seq: 4, stream: "tool", data: { toolCallId: "child-call", name: "read", phase: "start" },
      } });
      assert.equal(store.cursor(), cursor);
      assert.deepEqual(store.get<Task>("tasks", task.id), beforeTask);
      assert.deepEqual(store.get<Run>("runs", "late-run"), beforeRun);
      assert.deepEqual(store.snapshot().notifications, notices);
    } finally { store.close(); }
  }
});

test("graceful recovery associates a new engine run with its interrupted product task", () => {
  const { store, projector, submission, task } = setup();
  store.acceptSubmission(submission.id, "old-run", 1);
  const payload = { sessionKey: submission.sessionKey, runId: "old-run", seq: 1, stream: "lifecycle", data: { phase: "start" } };
  projector.frame(1, { event: "agent", payload });
  projector.observe({ type: "exit", code: 0, signal: null, generation: 1 });
  assert.equal(store.get<Task>("tasks", task.id)?.status, "interrupted");
  projector.frame(2, { event: "agent", payload: { ...payload, runId: "new-run" } });
  assert.equal(store.get<Task>("tasks", task.id)?.status, "running");
  assert.equal(store.list("tasks").length, 1);
  projector.frame(2, { event: "chat", payload: {
    sessionKey: submission.sessionKey, runId: "new-run", seq: 2,
    state: "final", message: { content: "Recovered." },
  } });
  assert.equal(store.get<Task>("tasks", task.id)?.status, "completed");
  store.close();
});

test("hard-crash recovery keeps queued custody separate from the active continuation", () => {
  const { store, projector, submission, task, bot, conversation } = setup();
  store.acceptSubmission(submission.id, "active-before-crash", 1);
  projector.frame(1, { event: "agent", payload: {
    runId: "active-before-crash", sessionKey: submission.sessionKey, seq: 1, stream: "lifecycle", data: { phase: "start" },
  } });
  const queued = store.beginSubmission({
    submissionId: "queued-after-active", conversationId: conversation.id, botId: bot.id, message: "Synthetic followup",
  });
  store.acceptSubmission(queued.submission.id, "queued-receipt", 1);
  projector.frame(1, { event: "chat", payload: {
    runId: "queued-receipt", sessionKey: submission.sessionKey, seq: 1, state: "aborted", stopReason: "restart",
  } });
  assert.equal(store.get<Task>("tasks", queued.task.id)?.status, "queued");
  assert.equal(store.messages(conversation.id).filter((message) => message.runId === "queued-receipt").length, 0);
  projector.observe({ type: "exit", code: null, signal: "SIGKILL", generation: 1 });
  assert.equal(store.get<Task>("tasks", task.id)?.status, "interrupted");
  assert.equal(store.get<Task>("tasks", queued.task.id)?.status, "queued");
  projector.frame(2, { event: "agent", payload: {
    runId: "continued-after-crash", sessionKey: submission.sessionKey, seq: 1, stream: "lifecycle", data: { phase: "start" },
  } });
  assert.equal(store.get<Task>("tasks", task.id)?.status, "running");
  assert.equal(store.get<Task>("tasks", queued.task.id)?.status, "queued");
  store.close();
});

test("a retained run resets sequence on a new generation and ignores delayed prior owners", () => {
  const { store, projector, submission, task } = setup();
  store.acceptSubmission(submission.id, "retained-run", 4);
  const frame = (generation: number, seq: number, stream: string, data: Record<string, unknown>) =>
    projector.frame(generation, { event: "agent", payload: {
      runId: "retained-run", sessionKey: submission.sessionKey, seq, stream, data,
    } });
  frame(4, 80, "lifecycle", { phase: "start" });
  projector.observe({ type: "exit", code: 0, signal: null, generation: 4 });
  assert.equal(store.get<Task>("tasks", task.id)?.status, "interrupted");
  frame(5, 1, "lifecycle", { phase: "start" });
  assert.equal(store.get<Task>("tasks", task.id)?.status, "running");
  assert.equal(store.get<Run>("runs", "retained-run")?.lastSequence, 1);
  assert.equal(store.get<Run>("runs", "retained-run")?.kernelExit, undefined);
  frame(4, 81, "assistant", { text: "Stale owner" });
  assert.equal(store.get<Run>("runs", "retained-run")?.generation, 5);
  projector.observe({ type: "exit", code: null, signal: "SIGKILL", generation: 4 });
  assert.equal(store.get<Task>("tasks", task.id)?.status, "running");
  frame(5, 2, "assistant", { text: "Current owner" });
  frame(5, 1, "assistant", { text: "Out of order" });
  projector.frame(5, { event: "chat", payload: {
    runId: "retained-run", sessionKey: submission.sessionKey, seq: 2, state: "final",
    message: { content: "Current final" },
  } });
  assert.equal(store.get<Task>("tasks", task.id)?.status, "completed");
  assert.equal(store.get<Run>("runs", "retained-run")?.lastSequence, 2);
  store.close();
});

test("native reply-dispatch model selection establishes activity without a lifecycle start", () => {
  const { store, projector, submission, task } = setup();
  store.acceptSubmission(submission.id, "reply-dispatch-run", 1);
  projector.frame(1, { event: "agent", payload: {
    runId: "reply-dispatch-run", sessionKey: submission.sessionKey, seq: 1,
    stream: "lifecycle", data: { phase: "model", provider: "synthetic", completionSource: "reply-dispatch" },
  } });
  assert.equal(store.get<Task>("tasks", task.id)?.status, "running");
  projector.frame(1, { event: "agent", payload: {
    runId: "reply-dispatch-run", sessionKey: submission.sessionKey, seq: 2,
    stream: "lifecycle", data: { phase: "model", provider: null, completionSource: "reply-dispatch" },
  } });
  assert.equal(store.get<Task>("tasks", task.id)?.status, "running");
  store.close();
});

test("report destination receives the actual final result without exposing another Bot's private chat", () => {
  const { store, bot, conversation } = setup();
  const second = store.createBot({ name: "Second", agentId: "second" });
  const group = store.createConversation("group", [bot.id, second.id], "Synthetic group");
  const { submission, task } = store.beginSubmission({
    submissionId: "group-1", conversationId: group.id, botId: bot.id,
    message: "Synthetic assigned task", reportConversationId: conversation.id,
  });
  const projector = new EngineProjector(store);
  store.acceptSubmission(submission.id, "group-run", 1);
  projector.frame(1, { event: "chat", payload: {
    sessionKey: submission.sessionKey, runId: "group-run", seq: 1,
    state: "final", message: { content: "Actual report." },
  } });
  const report = store.get<Message>("messages", `report:${task.id}`);
  assert.equal(report?.conversationId, conversation.id);
  assert.equal(report?.blocks[0].kind === "text" && report.blocks[0].text, "Actual report.");
  assert.equal(store.messages(store.privateConversation(second.id).id).length, 0);
  store.close();
});

test("reopening the local database retains submissions, events and messages", () => {
  mkdirSync("local/test-fixtures", { recursive: true });
  const fixture = mkdtempSync("local/test-fixtures/store-");
  const path = join(fixture, "product.sqlite");
  const store = new WorkbenchStore(path);
  const bot = store.createBot({ name: "Durable", agentId: "durable" });
  const conversation = store.privateConversation(bot.id);
  store.beginSubmission({ submissionId: "durable-1", botId: bot.id, conversationId: conversation.id, message: "Saved" });
  const cursor = store.cursor();
  store.close();
  const reopened = new WorkbenchStore(path);
  assert.equal(reopened.messages(conversation.id).length, 1);
  assert.equal(reopened.cursor(), cursor);
  assert.equal(reopened.get("submissions", "durable-1") !== undefined, true);
  reopened.close();
});

test("graceful stop keeps accepted followups separate from the interrupted active task", () => {
  const { store, projector, submission, bot, conversation, task } = setup();
  store.acceptSubmission(submission.id, "old-active", 1);
  projector.frame(1, { event: "agent", payload: {
    sessionKey: submission.sessionKey, runId: "old-active", stream: "lifecycle", seq: 1, data: { phase: "start" },
  } });
  const queued = store.beginSubmission({
    submissionId: "queued-input", conversationId: conversation.id, botId: bot.id, message: "Followup",
  });
  store.acceptSubmission(queued.submission.id, "queued-run", 1);
  projector.observe({ type: "exit", generation: 1, code: 0, signal: null });
  assert.equal(store.get<Task>("tasks", task.id)?.status, "interrupted");
  assert.equal(store.get<Task>("tasks", queued.task.id)?.status, "queued");
  projector.frame(2, { event: "agent", payload: {
    sessionKey: submission.sessionKey, runId: "new-continuation", stream: "lifecycle", seq: 1, data: { phase: "start" },
  } });
  assert.equal(store.get<Task>("tasks", task.id)?.status, "running");
  assert.equal(store.get<Task>("tasks", queued.task.id)?.status, "queued");
  projector.observe({ type: "exit", generation: 2, code: null, signal: "SIGKILL" });
  assert.equal(store.get<Task>("tasks", task.id)?.status, "interrupted");
  store.close();
});

test("tool steps keep their readable identity but never persist native credentials", () => {
  const { store, projector, submission, conversation } = setup();
  store.acceptSubmission(submission.id, "secret-run", 1);
  const frame = (seq: number, stream: string, data: Record<string, unknown>) => projector.frame(1, {
    event: "agent", payload: { runId: "secret-run", sessionKey: submission.sessionKey, seq, stream, data },
  });
  // The exact review probe: inline credentials that appear inside ordinary
  // string fields, not under a credential-shaped key.
  frame(1, "tool", {
    toolCallId: "probe-call", name: "exec", title: "调用合成接口", phase: "start",
    input: {
      url: "https://example.test/?access_token=synthetic-query-token",
      command: "curl -H Authorization: Bearer synthetic-command-token",
    },
  });
  frame(2, "tool", {
    toolCallId: "probe-call", name: "exec", phase: "result",
    result: { ok: true, bytes: 64, stdout: "synthetic-command-token" },
  });
  frame(3, "tool", {
    toolCallId: "deploy-call", name: "exec", title: "部署到测试环境", phase: "start",
    input: { env: { DEPLOY_TOKEN: "synthetic-deploy-token" }, path: "projects/synthetic.md" },
  });
  frame(4, "tool", {
    toolCallId: "deploy-call", name: "exec", phase: "result",
    result: { ok: true, bytes: 64, path: "projects/synthetic.md" },
  });
  const serialized = JSON.stringify(store.messages(conversation.id));
  for (const leaked of ["synthetic-query-token", "synthetic-command-token", "synthetic-deploy-token",
    "projects/synthetic.md", "curl -H", "access_token"]) {
    assert.equal(serialized.includes(leaked), false, leaked);
  }
  const tools = store.messages(conversation.id).flatMap((message) => message.blocks)
    .filter((block): block is Extract<Block, { kind: "tool" }> => block.kind === "tool");
  assert.deepEqual(tools.map((block) => block.name), ["exec", "exec"]);
  assert.equal(tools[1].title, "部署到测试环境");
  assert.equal(tools[1].phase, "result");
  assert.deepEqual(JSON.parse(tools[0].detail!), {
    toolCallId: "probe-call", name: "exec", phase: "result", outcome: { bytes: 64, ok: true },
  });
  store.close();
});

test("the snapshot previews each conversation's newest message for the sidebar", () => {
  const { store, conversation } = setup();
  const other = store.createBot({ name: "Other", agentId: "other" });
  const empty = store.createConversation("private", [other.id], "Empty conversation");
  const snapshot = store.snapshot();
  // The newest row carries the message's own words and when it arrived.
  assert.deepEqual(snapshot.lastMessages[conversation.id], {
    role: "user", text: "Synthetic task", createdAt: store.messages(conversation.id)[0].createdAt,
  });
  assert.equal(snapshot.lastMessageSeq[conversation.id], 0);
  // A conversation with nothing to show is absent, so the row keeps no preview.
  assert.equal(snapshot.lastMessages[empty.id], undefined);
  assert.equal(snapshot.lastMessageSeq[empty.id], -1);
  store.close();
});

test("empty internal messages keep the readable preview without changing the read boundary", () => {
  const { store, conversation } = setup();
  const original = store.snapshot().lastMessages[conversation.id];
  store.put("messages", {
    id: "empty-assistant", conversationId: conversation.id, role: "assistant",
    blocks: [], final: true, createdAt: original.createdAt,
  });
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.lastMessages[conversation.id], original);
  assert.equal(snapshot.lastMessageSeq[conversation.id], 0);
  assert.equal(store.readState(conversation.id).unread, false);
  assert.ok(store.get("messages", "empty-assistant"), "Raw execution evidence remains stored");
  store.clearConversation(conversation.id);
  assert.equal(store.snapshot().lastMessages[conversation.id], undefined);
  store.close();
});
