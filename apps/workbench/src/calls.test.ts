import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { localCalls } from "./calls.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import { WorkbenchService } from "../../../packages/workbench/src/service.ts";
import type { Submission } from "../../../packages/kernel-runtime/src/contracts.ts";
import type { Message, Run } from "../../../packages/workbench/src/contracts.ts";

function fixture() {
  const sent: Submission[] = [];
  const kernel = Object.assign(new EventEmitter(), {
    generation: 1, phase: "ready",
    async request<T>() { return [] as T; },
    async send(input: Submission) { sent.push(input); return { runId: input.idempotencyKey, status: "started" }; },
    async recoverHistory() { return { messages: [] }; }, async abort() { return {}; },
  });
  const store = new WorkbenchStore(":memory:");
  const service = new WorkbenchService(store, kernel);
  const bot = store.createBot({ name: "Synthetic" });
  const conversation = store.privateConversation(bot.id);
  return { sent, store, service, bot, conversation, calls: localCalls(service) };
}

test("voice turns use spoken guidance; repeated hangup leaves one marker and one hidden wrapup", async () => {
  const f = fixture();
  try {
    await f.service.submit({ submissionId: "call:synthetic:turn", botId: f.bot.id,
      conversationId: f.conversation.id, message: "Synthetic spoken request" });
    assert.match(f.sent[0].message, /live voice call/);
    assert.equal(f.store.messages(f.conversation.id)[0].blocks[0].kind, "text");
    const input = { botId: f.bot.id, callId: "synthetic", durationSeconds: 12 };
    await f.calls.rpc("endCall", input);
    await f.calls.rpc("endCall", input);
    const messages = f.store.messages(f.conversation.id);
    assert.equal(messages.filter((message) => message.blocks[0]?.kind === "voice_call").length, 1);
    assert.equal(messages.filter((message) => message.role === "user").length, 1);
    assert.equal(f.sent.length, 2);
    const initialMarker = f.store.get<Message>("messages", "call:synthetic:marker")!;
    const wrapup = f.store.list<Run>("runs").find((run) => run.id === "call-wrapup:synthetic")!;
    assert.ok(wrapup);
    f.store.put("runs", { ...wrapup, state: "running" });
    const finish = { agentId: f.bot.agentId, sessionKey: wrapup.sessionKey, runId: wrapup.id,
      operation: "end_call", toolCallId: "finish", title: "  Synthetic call title  ", farewell: "  Talk soon.  " };
    assert.deepEqual(f.calls.tool(finish), { ok: true });
    const updated = f.store.get<Message>("messages", initialMarker.id)!;
    assert.equal(updated.createdAt, initialMarker.createdAt);
    assert.deepEqual(updated.blocks, [{
      id: "call", kind: "voice_call", callId: "synthetic",
      title: "Synthetic call title", farewell: "Talk soon.", durationSeconds: 12,
    }]);
    const ended = f.store.eventsAfter(0).filter((event) => event.type === "thread.call.ended");
    assert.equal(ended.length, 2);
    assert.deepEqual(ended.at(-1)?.data, { conversationId: f.conversation.id, ...updated.blocks[0] });
    const cursor = f.store.cursor();
    f.calls.tool(finish);
    f.calls.tool({ ...finish, farewell: "" });
    await f.calls.rpc("endCall", input);
    assert.equal(f.store.cursor(), cursor, "unchanged retries must not republish the marker");
    assert.equal(f.sent.length, 2, "metadata updates must not dispatch another wrapup");
    assert.equal(f.store.messages(f.conversation.id).filter((message) =>
      message.blocks[0]?.kind === "voice_call").length, 1);
    assert.deepEqual(f.store.get<Message>("messages", initialMarker.id)?.blocks, updated.blocks);
    const other = f.store.createBot({ name: "Other" });
    await assert.rejects(f.calls.rpc("endCall", { ...input, botId: other.id }), /another conversation/);
  } finally { f.service.detach(); f.store.close(); }
});

test("hangup without a user utterance for that call creates no marker or hidden wrapup", async () => {
  const f = fixture();
  try {
    const input = { botId: f.bot.id, callId: "empty", durationSeconds: 0 };
    const cursor = f.store.cursor();
    assert.deepEqual(await f.calls.rpc("endCall", input), { ok: true });
    assert.equal(f.store.cursor(), cursor);
    const other = f.store.createBot({ name: "Other" });
    const otherConversation = f.store.privateConversation(other.id);
    // Another call, another conversation and a bot's own opening are not
    // evidence that this user said anything on the closing call.
    for (const [id, conversationId, role, clientNonce] of [
      ["other-call", f.conversation.id, "user", "call:empty-other:turn"],
      ["other-conversation", otherConversation.id, "user", "call:empty:turn"],
      ["bot-opening", f.conversation.id, "assistant", "call:empty:opening"],
    ] as const) {
      f.store.put<Message>("messages", { id, conversationId, role, clientNonce,
        blocks: [{ id: "text", kind: "text", text: "Synthetic" }], final: true, createdAt: 1, updatedAt: 1 });
    }
    const afterFixtures = f.store.cursor();
    await f.calls.rpc("endCall", input);
    await f.calls.rpc("endCall", input);
    assert.equal(f.store.cursor(), afterFixtures);
    assert.equal(f.store.get("messages", "call:empty:marker"), undefined);
    assert.equal(f.store.get("submissions", "call-wrapup:empty"), undefined);
    assert.deepEqual(f.store.list("tasks"), []);
    assert.equal(f.sent.length, 0);
    await assert.rejects(f.calls.rpc("endCall", { ...input, callId: "invalid:id" }));
  } finally { f.service.detach(); f.store.close(); }
});

test("native incoming call is durable, can be answered once, and cannot cross Bot authority", async () => {
  const f = fixture();
  try {
    f.store.put("voiceCredentials", { id: "synthetic", voiceId: "synthetic", secret: "PRIVATE_TEST_KEY" });
    await f.service.submit({ submissionId: "synthetic-turn", botId: f.bot.id, conversationId: f.conversation.id, message: "Hello" });
    const run = f.store.list<Run>("runs")[0];
    f.store.put("runs", { ...run, state: "running" });
    const authority = { agentId: f.bot.agentId, sessionKey: run.sessionKey, runId: run.id };
    const block = f.calls.tool({ ...authority, operation: "call_user", toolCallId: "call-1", reason: "Discuss", opening: "Hello" });
    assert.ok("kind" in block && block.kind === "call_request");
    if (!("kind" in block) || block.kind !== "call_request") throw new Error("Missing request");
    const result = await f.calls.rpc("answerCall", { botId: f.bot.id, callId: block.callId });
    assert.deepEqual(result, { opening: "Hello", reason: "Discuss" });
    assert.equal((await f.calls.rpc("answerCall", { botId: f.bot.id, callId: block.callId }) as { opening: string }).opening, "Hello");
    assert.throws(() => f.calls.tool({ ...authority, agentId: "other", operation: "end_call", toolCallId: "end" }), /authority/);
    const request = f.store.list<Message>("messages").find((message) => message.blocks[0]?.kind === "call_request");
    assert.equal(request?.blocks[0].kind === "call_request" && request.blocks[0].status, "answered");
    assert.ok(!JSON.stringify(f.store.eventsAfter(0)).includes("PRIVATE_TEST_KEY"));
    assert.ok(!JSON.stringify(f.store.snapshot()).includes("PRIVATE_TEST_KEY"));
  } finally { f.service.detach(); f.store.close(); }
});

test("an interrupted voice reply preserves the heard portion without exposing another conversation", async () => {
  const f = fixture();
  try {
    f.store.put<Message>("messages", { id: "spoken-reply", conversationId: f.conversation.id,
      role: "assistant", botId: f.bot.id, blocks: [{ id: "text", kind: "text", text: "The complete reply" }],
      final: true, createdAt: 1, updatedAt: 1 });
    await f.service.submit({ submissionId: "call:synthetic:interrupt", botId: f.bot.id,
      conversationId: f.conversation.id, message: "Please clarify",
      voicePlayback: { messageId: "spoken-reply", heardText: "The complete" } });
    assert.match(f.sent[0].message, /"heardText":"The complete"/);
    const other = f.store.createBot({ name: "Other" });
    await assert.rejects(f.service.submit({ submissionId: "call:other:interrupt", botId: other.id,
      conversationId: f.store.privateConversation(other.id).id, message: "Clarify",
      voicePlayback: { messageId: "spoken-reply", heardText: "The complete" } }), /playback/);
  } finally { f.service.detach(); f.store.close(); }
});
