import assert from "node:assert/strict";
import test from "node:test";
import type { Message, Run } from "./contracts.ts";
import { WorkbenchStore } from "./store.ts";
import { ConversationContext } from "./context.ts";

function fixture() {
  const store = new WorkbenchStore(":memory:");
  const first = store.createBot({ name: "First" });
  const second = store.createBot({ name: "Second" });
  const privateFirst = store.privateConversation(first.id);
  const privateSecond = store.privateConversation(second.id);
  const group = store.createConversation("group", [first.id, second.id], "Project group");
  const otherGroup = store.createConversation("group", [first.id], "Other group");
  for (const [conversation, text] of [
    [privateFirst, "First private source"], [privateSecond, "Second private source"],
    [group, "Group source"], [otherGroup, "Other group source"],
  ] as const) store.put<Message>("messages", {
    id: conversation.id, conversationId: conversation.id, role: "user",
    blocks: [{ id: "text", kind: "text", text }, { id: "reasoning", kind: "reasoning", text: "Hidden reasoning" }],
    final: true, createdAt: Date.now(), updatedAt: Date.now(),
  });
  return { store, context: new ConversationContext(store), first, second, privateFirst, privateSecond, group, otherGroup };
}

test("private recall includes the Bot's groups and excludes another Bot's private conversation", () => {
  const f = fixture();
  const passages = f.context.candidates({ botId: f.first.id, destinationConversationId: f.privateFirst.id });
  assert.deepEqual(new Set(passages.map((passage) => passage.conversationId)), new Set([f.privateFirst.id, f.group.id, f.otherGroup.id]));
  assert.equal(passages.some((passage) => passage.text.includes("Hidden reasoning")), false);
  assert.throws(() => f.context.candidates({ botId: f.second.id, destinationConversationId: f.privateFirst.id }), /participant/);
  f.store.close();
});

test("group recall requires explicit sharing for private or other-group sources; revocation closes access", () => {
  const f = fixture();
  const read = () => f.context.candidates({ botId: f.second.id, destinationConversationId: f.group.id });
  assert.deepEqual(read().map((passage) => passage.conversationId), [f.group.id]);
  const share = f.context.share({
    sourceConversationId: f.privateFirst.id, destinationConversationId: f.group.id, messageIds: [f.privateFirst.id],
  });
  assert.equal(read().find((passage) => passage.messageId === f.privateFirst.id)?.scope, "shared");
  f.context.revoke(share.id);
  assert.deepEqual(read().map((passage) => passage.conversationId), [f.group.id]);
  f.store.close();
});

test("sharing retries retain one grant, cannot reactivate a revoked grant and cannot change source content", () => {
  const f = fixture();
  try {
    const input = {
      id: "stable-context-share-identity", sourceConversationId: f.privateFirst.id,
      destinationConversationId: f.group.id, messageIds: [f.privateFirst.id],
    };
    const first = f.context.share(input);
    assert.deepEqual(f.context.share(input), first);
    assert.equal(f.store.list("contextShares").length, 1);
    assert.throws(() => f.context.share({ ...input, destinationConversationId: f.otherGroup.id }), /conflicts/);
    assert.throws(() => f.context.share({ ...input, messageIds: [f.group.id] }), /conflicts/);
    const revoked = f.context.revoke(first.id);
    assert.deepEqual(f.context.share(input), revoked);
    assert.deepEqual(f.context.revoke(first.id), revoked);
    assert.equal(f.context.candidates({ botId: f.second.id, destinationConversationId: f.group.id })
      .some((passage) => passage.conversationId === f.privateFirst.id), false);
    assert.throws(() => f.context.share({ ...input, id: "different-share-identity", messageIds: [f.privateSecond.id] }), /available source/);
    assert.throws(() => f.context.share({ ...input, id: "different-share-identity", messageIds: [] }), /1–100/);
    assert.equal(f.store.messages(f.privateFirst.id).length, 1);
  } finally { f.store.close(); }
});

test("LLM relevance selection cannot widen source scope or bypass the result bound", async () => {
  const f = fixture();
  const input = { botId: f.first.id, destinationConversationId: f.privateFirst.id, query: "Relevant group work" };
  const passages = await f.context.relevant(input, { select: async () => [f.group.id] });
  assert.equal(passages[0].conversationId, f.group.id);
  await assert.rejects(f.context.relevant(input, { select: async () => [f.privateSecond.id] }), /unauthorized/);
  await assert.rejects(f.context.relevant({ ...input, limit: 1 }, { select: async () => [f.privateFirst.id, f.group.id] }), /bound/);
  f.store.close();
});

test("native context access binds the active run, pages sources and respects live revocation", () => {
  const f = fixture();
  try {
    const started = f.store.beginSubmission({
      submissionId: "context-native", botId: f.first.id,
      conversationId: f.privateFirst.id, message: "Recall prior work",
    });
    f.store.acceptSubmission(started.submission.id, "native-context-run", 1);
    const run = f.store.get<Run>("runs", "native-context-run")!;
    f.store.put("runs", { ...run, state: "running" });
    const authority = {
      agentId: f.first.agentId, sessionKey: run.sessionKey, runId: run.id,
    };
    const list = f.context.invoke({ ...authority, operation: "list", limit: 1 }) as {
      conversations: { id: string }[]; nextBefore: string;
    };
    assert.equal(list.conversations.length, 1);
    const next = f.context.invoke({ ...authority, operation: "list", before: list.nextBefore }) as {
      conversations: { id: string }[];
    };
    assert.equal(next.conversations.some((item) => item.id === list.conversations[0].id), false);
    const read = f.context.invoke({ ...authority, operation: "read", conversationId: f.group.id }) as {
      messages: { messageId: string; text: string }[];
    };
    assert.equal(read.messages[0].messageId, f.group.id);
    assert.equal(read.messages[0].text, "Group source");
    assert.throws(() => f.context.invoke({
      ...authority, operation: "read", conversationId: f.privateSecond.id,
    }), /audience/);
    assert.throws(() => f.context.invoke({
      ...authority, agentId: f.second.agentId, operation: "list",
    }), /authority/);
    const groupInput = f.store.beginSubmission({
      submissionId: "context-group", botId: f.first.id,
      conversationId: f.group.id, message: "Use an explicitly shared note",
    });
    f.store.acceptSubmission(groupInput.submission.id, "native-group-context-run", 1);
    const groupRun = f.store.get<Run>("runs", "native-group-context-run")!;
    f.store.put("runs", { ...groupRun, state: "running" });
    const groupAuthority = { ...authority, sessionKey: groupRun.sessionKey, runId: groupRun.id };
    assert.throws(() => f.context.invoke({
      ...groupAuthority, operation: "read", conversationId: f.privateFirst.id,
    }), /audience/);
    const share = f.context.share({
      sourceConversationId: f.privateFirst.id, destinationConversationId: f.group.id,
      messageIds: [f.privateFirst.id],
    });
    const shared = f.context.invoke({
      ...groupAuthority, operation: "read", conversationId: f.privateFirst.id,
    }) as { messages: { messageId: string }[] };
    assert.deepEqual(shared.messages.map((message) => message.messageId), [f.privateFirst.id]);
    f.context.revoke(share.id);
    assert.throws(() => f.context.invoke({
      ...groupAuthority, operation: "read", conversationId: f.privateFirst.id,
    }), /audience/);
    f.store.put("runs", { ...run, state: "completed" });
    assert.throws(() => f.context.invoke({ ...authority, operation: "list" }), /authority/);
  } finally { f.store.close(); }
});

test("group recall preserves Bot attribution and live task states; shared excerpts exclude source task and member metadata", () => {
  const f = fixture();
  try {
    const started = f.store.beginSubmission({
      submissionId: "recall-current-task", botId: f.first.id,
      conversationId: f.privateFirst.id, message: "Check group progress",
    });
    f.store.acceptSubmission(started.submission.id, "recall-current-run", 1);
    const run = f.store.get<Run>("runs", "recall-current-run")!;
    f.store.put("runs", { ...run, state: "running" });
    const authority = { agentId: f.first.agentId, sessionKey: run.sessionKey, runId: run.id };
    const groupTask = f.store.beginSubmission({
      submissionId: "group-progress", conversationId: f.group.id, botId: f.second.id, message: "Prepare results",
    });
    f.store.updateTask(groupTask.task.id, "waiting");
    f.store.put<Message>("messages", {
      id: "second-group-reply", conversationId: f.group.id, role: "assistant", botId: f.second.id,
      blocks: [{ id: "text", kind: "text", text: "Synthetic completed milestone" }],
      final: true, createdAt: Date.now(), updatedAt: Date.now(),
    });
    type Result = {
      members?: { botId: string; name: string }[];
      tasks?: { id: string; botId: string; status: string }[];
      messages: { messageId: string; botId?: string; botName?: string }[];
    };
    const recalled = f.context.invoke({ ...authority, operation: "read", conversationId: f.group.id }) as Result;
    assert.equal(recalled.members?.length, 2);
    assert.equal(recalled.tasks?.find((task) => task.id === groupTask.task.id)?.status, "waiting");
    assert.equal(recalled.messages.find((message) => message.messageId === "second-group-reply")?.botId, f.second.id);
    assert.equal(recalled.messages.find((message) => message.messageId === "second-group-reply")?.botName, f.second.name);
    const other = f.store.createBot({ name: "Shared author" });
    const source = f.store.privateConversation(other.id);
    const note = f.store.beginSubmission({
      submissionId: "private-unshared-task-title", conversationId: source.id, botId: other.id,
      message: "Private task metadata",
    });
    f.store.put<Message>("messages", {
      id: "shared-excerpt", conversationId: source.id, botId: other.id, role: "assistant",
      taskId: note.task.id, blocks: [{ id: "text", kind: "text", text: "Selected public excerpt" }],
      final: true, createdAt: Date.now(), updatedAt: Date.now(),
    });
    f.context.share({ sourceConversationId: source.id, destinationConversationId: f.privateFirst.id, messageIds: ["shared-excerpt"] });
    const excerpt = f.context.invoke({ ...authority, operation: "read", conversationId: source.id }) as Result;
    assert.equal(excerpt.members, undefined);
    assert.equal(excerpt.tasks, undefined);
    assert.deepEqual(excerpt.messages.map((message) => message.messageId), ["shared-excerpt"]);
  } finally { f.store.close(); }
});
