import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Acceptance, HistoryPage, Submission } from "../../kernel-runtime/src/contracts.ts";
import type { Artifact, GroupInput, Run, SubmissionRecord, Task } from "./contracts.ts";
import { WorkbenchStore } from "./store.ts";
import { WorkbenchService } from "./service.ts";

class GroupKernel extends EventEmitter {
  generation = 1;
  phase = "ready";
  sent: Submission[] = [];
  aborted: { sessionKey: string; runId?: string }[] = [];
  abortHandler?: (runId?: string) => Promise<unknown>;
  handler?: (input: Submission) => Promise<Acceptance>;
  async request<T = unknown>(method: string): Promise<T> {
    return (method === "question.list" ? { questions: [] } : []) as T;
  }
  async send(input: Submission): Promise<Acceptance> {
    this.sent.push(input);
    return this.handler ? this.handler(input) : { runId: input.idempotencyKey, status: "started" };
  }
  async recoverHistory(): Promise<HistoryPage> { return { messages: [] }; }
  async abort(sessionKey: string, runId?: string) {
    this.aborted.push({ sessionKey, runId });
    return this.abortHandler ? this.abortHandler(runId) : {};
  }
}

function fixture() {
  const store = new WorkbenchStore(":memory:");
  const bots = [store.createBot({ name: "Atlas" }), store.createBot({ name: "Moss" })];
  const group = store.createConversation("group", bots.map((bot) => bot.id), "Project");
  const kernel = new GroupKernel();
  const service = new WorkbenchService(store, kernel);
  const input: GroupInput = { submissionId: "assignment-one", conversationId: group.id, botIds: bots.map((bot) => bot.id), message: "Prepare the project" };
  return { store, bots, group, kernel, service, input };
}

test("group dispatch persists all recipients before concurrent execution and retries only uncertain receipts", async () => {
  const f = fixture();
  try {
    let release!: (receipt: Acceptance) => void;
    let calls = 0;
    f.kernel.handler = (input) => {
      assert.equal(f.store.list("tasks").length, 2);
      assert.equal(f.store.messages(f.group.id).length, 1);
      if (++calls === 1) return new Promise((resolve) => { release = resolve; });
      return Promise.reject(new Error("Lost receipt"));
    };
    const pending = f.service.submitGroup(f.input);
    assert.equal(f.kernel.sent.length, 2);
    release({ runId: f.kernel.sent[0].idempotencyKey, status: "started" });
    const receipt = await pending;
    assert.deepEqual(receipt.outcomes.map((item) => item.accepted), [true, false]);
    f.kernel.handler = undefined;
    const retry = await f.service.submitGroup({ ...f.input, botIds: [...f.input.botIds].reverse() });
    assert.ok(retry.outcomes.every((item) => item.accepted));
    assert.equal(f.kernel.sent.length, 3);
    assert.equal(f.kernel.sent[1].idempotencyKey, f.kernel.sent[2].idempotencyKey);
    assert.equal(f.store.list("tasks").length, 2);
    assert.equal(f.store.messages(f.group.id).length, 1);
    await assert.rejects(f.service.submitGroup({ ...f.input, botIds: [f.bots[0].id] }), /conflicts/);
    assert.equal(f.kernel.sent.length, 3);
  } finally { f.service.detach(); f.store.close(); }
});

test("invalid group members, empty input and conflicting retries leave no partial assignments", async () => {
  const f = fixture();
  try {
    const outsider = f.store.createBot({ name: "June" });
    for (const input of [
      { ...f.input, botIds: [f.bots[0].id, outsider.id] },
      { ...f.input, botIds: [] },
      { ...f.input, botIds: [f.bots[0].id, f.bots[0].id] },
      { ...f.input, message: "" },
      { ...f.input, conversationId: f.store.privateConversation(f.bots[0].id).id },
    ]) await assert.rejects(f.service.submitGroup(input));
    assert.equal(f.store.list("tasks").length, 0);
    assert.equal(f.store.list("submissions").length, 0);
    assert.equal(f.store.list("messages").length, 0);
    assert.equal(f.kernel.sent.length, 0);
  } finally { f.service.detach(); f.store.close(); }
});

test("group steering keeps one visible input and each selected Bot's mode across uncertain retries", async () => {
  const f = fixture();
  try {
    f.kernel.handler = async () => { throw new Error("Lost group steering receipt"); };
    const input = { ...f.input, queueMode: "steer" as const };
    const receipt = await f.service.submitGroup(input);
    assert.ok(receipt.outcomes.every((outcome) => !outcome.accepted));
    await assert.rejects(f.service.submitGroup({ ...input, queueMode: "followup" }), /conflicts/);
    f.kernel.handler = undefined;
    await f.service.reconcile();
    assert.equal(f.store.messages(f.group.id).length, 1);
    assert.equal(f.store.list("tasks").length, 2);
    assert.deepEqual(f.kernel.sent.map((entry) => entry.queueMode), ["steer", "steer", "steer", "steer"]);
  } finally { f.service.detach(); f.store.close(); }
});

test("group attachment access follows current membership and conversation rather than uploader identity", () => {
  const f = fixture();
  try {
    const file: Artifact = {
      id: "synthetic-group-file", botId: f.bots[0].id, conversationId: f.group.id,
      name: "source.txt", path: "synthetic-unused", mediaType: "text/plain", bytes: 1,
      digest: "synthetic-unused", createdAt: 1, origin: "attachment",
    };
    f.store.put("artifacts", file);
    assert.equal(f.store.attachment(file.id, f.bots[1].id, f.group.id).id, file.id);
    const privateChat = f.store.privateConversation(f.bots[1].id);
    assert.throws(() => f.store.attachment(file.id, f.bots[1].id, privateChat.id), /belong/);
    const other = f.store.createConversation("group", f.group.botIds, "Other group");
    assert.throws(() => f.store.attachment(file.id, f.bots[1].id, other.id), /belong/);
    f.store.put("conversations", { ...f.group, botIds: [f.bots[1].id] });
    assert.throws(() => f.store.attachment(file.id, f.bots[1].id, f.group.id), /belong/);
  } finally { f.service.detach(); f.store.close(); }
});

test("native private reporting binds to the executing Bot, preserves retry routing, and delivers failure and stop receipts", async () => {
  const f = fixture();
  try {
    const receipt = await f.service.submitGroup(f.input);
    for (const [index, outcome] of receipt.outcomes.entries()) {
      const submission = f.store.list<SubmissionRecord>("submissions").find((item) => item.taskId === outcome.task.id)!;
      const run = f.store.get<Run>("runs", submission.engineRunId!)!;
      f.store.put("runs", { ...run, state: "running" });
      const bot = f.bots.find((item) => item.id === outcome.botId)!;
      const authority = { agentId: bot.agentId, sessionKey: run.sessionKey, runId: run.id };
      const destination = f.service.reportPrivately(authority);
      assert.equal(f.store.privateConversation(bot.id).id, destination.conversationId);
      assert.deepEqual(f.service.reportPrivately(authority), destination);
      assert.throws(() => f.service.reportPrivately({ ...authority, agentId: f.bots.find((item) => item.id !== bot.id)!.agentId }), /authority/);
      // Selecting a reporting destination must not invalidate the original input.
      await f.service.submitGroup(f.input);
      f.kernel.emit("observation", { type: "frame", generation: 1, frame: { event: "chat", payload: {
        runId: run.id, sessionKey: run.sessionKey, state: index === 0 ? "error" : "aborted",
        errorMessage: index === 0 ? "Synthetic failure" : undefined,
      } } });
      assert.equal(f.store.messages(destination.conversationId).length, 1);
      assert.equal(f.store.messages(destination.conversationId)[0].botId, bot.id);
      assert.equal(f.service.task(outcome.task.id).status, index === 0 ? "failed" : "cancelled");
      assert.throws(() => f.service.reportPrivately(authority), /authority/);
    }
    assert.equal(f.kernel.sent.length, 2);
  } finally { f.service.detach(); f.store.close(); }
});

test("uncertain group inputs recover with their original task and one visible message", async () => {
  const f = fixture();
  try {
    f.kernel.handler = async () => { throw new Error("Disconnected"); };
    const receipt = await f.service.submitGroup(f.input);
    assert.ok(receipt.outcomes.every((item) => !item.accepted));
    f.kernel.handler = undefined;
    await f.service.reconcile();
    assert.equal(f.store.messages(f.group.id).length, 1);
    assert.equal(f.store.list("tasks").length, 2);
    assert.ok(f.store.list<SubmissionRecord>("submissions").every((item) => item.state === "accepted"));
    assert.equal(f.kernel.sent.length, 4);
  } finally { f.service.detach(); f.store.close(); }
});

async function parentTask(f: ReturnType<typeof fixture>) {
  const task = await f.service.submit({
    submissionId: "coordinator-input", conversationId: f.group.id, botId: f.bots[0].id, message: "Coordinate work",
  });
  const run = f.store.get<Run>("runs", "coordinator-input")!;
  f.store.put("runs", { ...run, state: "running" });
  f.store.updateTask(task.id, "running");
  return { task, authority: {
    agentId: f.bots[0].agentId, sessionKey: run.sessionKey, runId: run.id, toolCallId: "assign-call-one",
  } };
}

test("native group delegation retains parent and speaker, retries exact assignments, and excludes other groups", async () => {
  const f = fixture();
  try {
    const parent = await parentTask(f);
    const input = { ...parent.authority, assignments: [{ botId: f.bots[1].id, message: "Prepare source notes", report: "private" as const }] };
    const result = await f.service.assignGroup(input);
    const child = result.outcomes[0].task;
    assert.equal(child.parentTaskId, parent.task.id);
    assert.equal(child.botId, f.bots[1].id);
    assert.equal(child.reportConversationId, f.store.privateConversation(f.bots[1].id).id);
    assert.equal(f.kernel.sent.length, 2);
    const message = f.store.messages(f.group.id).find((item) => item.taskId === child.id)!;
    assert.equal(message.role, "assistant");
    assert.equal(message.botId, f.bots[0].id);
    const repeated = await f.service.assignGroup(input);
    assert.equal(repeated.outcomes[0].task.id, child.id);
    assert.equal(f.kernel.sent.length, 2);
    const childRun = f.store.list<Run>("runs").find((run) => run.taskId === child.id)!;
    f.store.put("runs", { ...childRun, state: "running" });
    await assert.rejects(f.service.assignGroup({
      agentId: f.bots[1].agentId, sessionKey: childRun.sessionKey, runId: childRun.id,
      toolCallId: "cycle-call", assignments: [{ botId: f.bots[0].id, message: "Return work to the ancestor" }],
    }), /ancestor/);
    await assert.rejects(f.service.assignGroup({ ...input, assignments: [{ ...input.assignments[0], message: "Changed" }] }), /conflicts/);
    const outsider = f.store.createBot({ name: "Outsider" });
    await assert.rejects(f.service.assignGroup({ ...input, toolCallId: "another-call", assignments: [{ botId: outsider.id, message: "Outside" }] }), /members/);
    await assert.rejects(f.service.assignGroup({ ...input, toolCallId: "self-call", assignments: [{ botId: f.bots[0].id, message: "Self" }] }), /members/);
    assert.equal(f.store.list("tasks").length, 2);
    f.store.updateTask(parent.task.id, "stopping");
    await assert.rejects(f.service.assignGroup({ ...input, toolCallId: "late-call" }), /authority/);
  } finally { f.service.detach(); f.store.close(); }
});

test("lost delegated receipts recover original child identity without inventing a user-authored message", async () => {
  const f = fixture();
  try {
    const parent = await parentTask(f);
    f.kernel.handler = async () => { throw new Error("Receipt lost"); };
    const result = await f.service.assignGroup({
      ...parent.authority, assignments: [{ botId: f.bots[1].id, message: "Synthetic subtask" }],
    });
    assert.equal(result.outcomes[0].accepted, false);
    f.kernel.handler = undefined;
    await f.service.reconcile();
    assert.equal(f.store.list("tasks").length, 2);
    assert.equal(f.store.messages(f.group.id).filter((item) => item.role === "user").length, 1);
    assert.equal(f.store.messages(f.group.id).filter((item) => item.role === "assistant").length, 1);
    assert.equal(f.kernel.sent[1].idempotencyKey, f.kernel.sent[2].idempotencyKey);
  } finally { f.service.detach(); f.store.close(); }
});

test("stopping a coordinator attempts every descendant even when one abort fails and leaves unrelated work alone", async () => {
  const f = fixture();
  try {
    const third = f.store.createBot({ name: "June" });
    f.store.put("conversations", { ...f.group, botIds: [...f.group.botIds, third.id] });
    const parent = await parentTask(f);
    const children = await f.service.assignGroup({ ...parent.authority, assignments: [
      { botId: f.bots[1].id, message: "First part" }, { botId: third.id, message: "Second part" },
    ] });
    const independent = await f.service.submit({
      submissionId: "unrelated-work", botId: third.id,
      conversationId: f.store.privateConversation(third.id).id, message: "Unrelated",
    });
    const failingRun = f.store.list<SubmissionRecord>("submissions").find((item) => item.taskId === children.outcomes[0].task.id)!.engineRunId;
    f.kernel.abortHandler = async (runId) => { if (runId === failingRun) throw new Error("Abort transport failed"); return {}; };
    await assert.rejects(f.service.cancel(parent.task.id), AggregateError);
    assert.equal(f.kernel.aborted.length, 3);
    assert.equal(f.service.task(independent.id).status, "queued");
    for (const child of children.outcomes) assert.equal(f.service.task(child.task.id).status, "stopping");
    assert.ok(f.kernel.aborted.every((item) => item.runId !== "unrelated-work"));
    f.store.updateTask(parent.task.id, "completed");
    f.kernel.abortHandler = undefined;
    await f.service.cancel(parent.task.id);
    assert.equal(f.kernel.aborted.length, 5);
  } finally { f.service.detach(); f.store.close(); }
});

test("stopping while a delegated receipt is delayed retains intent and aborts its exact later run", async () => {
  const f = fixture();
  try {
    const parent = await parentTask(f);
    let release!: (value: Acceptance) => void;
    f.kernel.handler = () => new Promise((resolve) => { release = resolve; });
    const assigning = f.service.assignGroup({ ...parent.authority, assignments: [
      { botId: f.bots[1].id, message: "Delayed child work" },
    ] });
    const child = f.store.find<Task>("tasks", "parentTaskId", parent.task.id)[0];
    await f.service.cancel(parent.task.id);
    assert.equal(f.service.task(child.id).status, "stopping");
    assert.ok(f.service.task(child.id).stopRequestedAt);
    release({ runId: "delayed-native-child-run", status: "started" });
    const receipt = await assigning;
    assert.equal(receipt.outcomes[0].accepted, true);
    assert.ok(f.kernel.aborted.some((call) => call.runId === "delayed-native-child-run"));
    const run = f.store.get<Run>("runs", "delayed-native-child-run")!;
    f.kernel.emit("observation", { type: "frame", generation: 1, frame: {
      event: "agent", payload: { runId: run.id, sessionKey: run.sessionKey, stream: "lifecycle", data: { phase: "start" } },
    } });
    assert.equal(f.service.task(child.id).status, "stopping");
    f.kernel.emit("observation", { type: "frame", generation: 1, frame: {
      event: "chat", payload: { runId: run.id, sessionKey: run.sessionKey, state: "aborted" },
    } });
    assert.equal(f.service.task(child.id).status, "cancelled");
  } finally { f.service.detach(); f.store.close(); }
});
