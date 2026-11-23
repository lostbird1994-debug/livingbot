import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Acceptance, HistoryPage, Submission } from "../../kernel-runtime/src/contracts.ts";
import { Files } from "./files.ts";
import { WorkbenchService } from "./service.ts";
import { WorkbenchStore } from "./store.ts";
import { Workspaces } from "./workspaces.ts";

class BatchKernel extends EventEmitter {
  generation = 1;
  phase = "ready";
  sent: Submission[] = [];
  handler?: (input: Submission) => Promise<Acceptance>;
  async request<T>(): Promise<T> { return { questions: [] } as T; }
  async send(input: Submission): Promise<Acceptance> {
    this.sent.push(input);
    if (this.handler) return this.handler(input);
    return { runId: input.idempotencyKey, status: "started" };
  }
  complete(input: Submission): void {
    this.emit("observation", { type: "frame", generation: this.generation, frame: {
      event: "chat", payload: {
        runId: input.idempotencyKey, sessionKey: input.sessionKey, state: "final",
        message: { content: [{ type: "text", text: `Completed ${input.attachments?.[0]?.fileName ?? "work"}` }] },
      },
    } });
  }
  async recoverHistory(sessionKey: string): Promise<HistoryPage> {
    return { sessionInfo: { key: sessionKey, sessionId: "native-session", hasActiveRun: false, activeLeafEntryId: null } };
  }
  async abort() { return { aborted: true }; }
}

async function fixture() {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp("local/test-fixtures/file-batch-");
  const store = new WorkbenchStore(":memory:");
  const bot = store.createBot({ name: "Batch Bot" });
  const conversation = store.privateConversation(bot.id);
  const files = new Files(store, new Workspaces(join(process.cwd(), root, "workspaces")));
  const attachments = await Promise.all(["one.txt", "two.txt", "three.txt"].map((name, index) => files.attach({
    id: `file-batch-source-${index + 1}`, botId: bot.id, conversationId: conversation.id,
    name, mediaType: "text/plain", bytes: Buffer.from(`Synthetic ${name}`),
  })));
  const kernel = new BatchKernel();
  const service = new WorkbenchService(store, kernel, undefined, files);
  return { store, bot, conversation, attachments, kernel, service };
}

test("file batches create independent tasks and retry only failed items with durable identities", async () => {
  const f = await fixture();
  try {
    const input = {
      id: "file-batch-stable-identity", botId: f.bot.id, conversationId: f.conversation.id,
      instruction: "Extract the date and amount", attachmentIds: f.attachments.map((file) => file.id),
    };
    const first = await f.service.submitFileBatch(input);
    assert.equal(first.outcomes.length, 3);
    assert.equal(first.outcomes.filter((outcome) => outcome.accepted).length, 1);
    assert.equal(new Set(first.outcomes.map((outcome) => outcome.task.id)).size, 3);
    assert.equal(f.kernel.sent.length, 1);
    assert.equal(f.kernel.sent[0].attachments?.length, 1);
    assert.ok(f.kernel.sent[0].message.includes("Extract the date and amount"));
    assert.equal(f.store.snapshot().fileBatches[0].items.length, 3);

    const [failed, interrupted] = first.outcomes.map((outcome) => outcome.task);
    f.store.put("tasks", { ...failed, status: "failed", error: "Synthetic provider failure" });
    f.store.put("tasks", { ...interrupted, status: "interrupted" });
    // One action retries every item that still needs it, and only those.
    const completedTask = first.outcomes.map((outcome) => outcome.task)
      .find((task) => task.id !== failed.id && task.id !== interrupted.id)!;
    const completedSubmission = f.store.find<{ id: string; taskId: string }>("submissions", "taskId", completedTask.id)[0].id;
    const retry = await f.service.retryFileBatch(input.id, "file-batch-retry-stable-id");
    assert.deepEqual(retry.outcomes.map((outcome) => outcome.task.id).sort(), [failed.id, interrupted.id].sort());
    assert.ok(retry.outcomes.every((outcome) => outcome.accepted));
    assert.equal(f.kernel.sent.length, 3, "Both failed items are retried once, the completed one is not");
    assert.equal(f.kernel.sent.filter((turn) => turn.attachments?.[0]?.fileName === "one.txt" ||
      turn.attachments?.[0]?.fileName === "two.txt" || turn.attachments?.[0]?.fileName === "three.txt").length, 3);
    assert.deepEqual(retry.batch.items.map((item) => item.retries ?? 0).sort(), [0, 1, 1]);
    assert.deepEqual(f.store.find<{ id: string; taskId: string }>("submissions", "taskId", completedTask.id).map((entry) => entry.id),
      [completedSubmission], "The completed item keeps its original submission");
    const repeated = await f.service.retryFileBatch(input.id, "file-batch-retry-stable-id");
    assert.equal(repeated.outcomes.length, 2);
    assert.equal(f.kernel.sent.length, 3, "The same retry identity never dispatches again");
    assert.deepEqual(repeated.batch.items.map((item) => item.retries ?? 0).sort(), [0, 1, 1]);

    f.store.put("tasks", { ...f.service.task(failed.id), status: "failed" });
    f.store.put("tasks", { ...f.service.task(interrupted.id), status: "interrupted" });
    const nextRetry = await f.service.retryFileBatch(input.id, "file-batch-retry-next-stable-id");
    assert.deepEqual(nextRetry.outcomes.map((outcome) => outcome.task.id).sort(), [failed.id, interrupted.id].sort());
    assert.equal(f.kernel.sent.length, 5);
    assert.deepEqual(nextRetry.batch.items.map((item) => item.retries ?? 0).sort(), [0, 2, 2]);
    f.store.put("tasks", { ...f.service.task(failed.id), status: "completed" });
    f.store.put("tasks", { ...f.service.task(interrupted.id), status: "completed" });

    const duplicate = await f.service.submitFileBatch(input);
    assert.equal(duplicate.batch.id, input.id);
    assert.equal(duplicate.outcomes.length, 3);
    // The third item was still queued behind per-session ordering; replay
    // admits it and never redispatches the two finished items.
    assert.equal(f.kernel.sent.length, 6);
    await assert.rejects(f.service.submitFileBatch({ ...input, instruction: "Different request" }), /conflicts/);
    await assert.rejects(f.service.retryFileBatch(input.id, "file-batch-retry-conflict"), /No failed/);
  } finally { f.service.detach(); f.store.close(); }
});

test("file batch admissions are ordered per session without blocking another Bot", async () => {
  const f = await fixture();
  try {
    let releaseFirst!: (receipt: Acceptance) => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    let secondStarted!: () => void;
    const second = new Promise<void>((resolve) => { secondStarted = resolve; });
    let thirdStarted!: () => void;
    const third = new Promise<void>((resolve) => { thirdStarted = resolve; });
    const batchSession = f.store.engineSessionKey(f.conversation.id, f.bot.id);
    f.kernel.handler = (input) => {
      if (input.sessionKey !== batchSession) return Promise.resolve({ runId: input.idempotencyKey, status: "started" });
      const index = f.kernel.sent.filter((turn) => turn.sessionKey === batchSession).length;
      if (index === 1) {
        firstStarted();
        return new Promise((resolve) => { releaseFirst = resolve; });
      }
      if (index === 2) secondStarted();
      if (index === 3) thirdStarted();
      return Promise.resolve({ runId: input.idempotencyKey, status: "started" });
    };
    const batch = f.service.submitFileBatch({
      id: "file-batch-ordered-session", botId: f.bot.id, conversationId: f.conversation.id,
      instruction: "Process in order", attachmentIds: f.attachments.map((file) => file.id),
    });
    await started;
    assert.equal(f.kernel.sent.length, 1);

    const other = f.store.createBot({ name: "Independent Bot" });
    const otherConversation = f.store.privateConversation(other.id);
    const independent = await f.service.submit({
      submissionId: "independent-during-batch", botId: other.id,
      conversationId: otherConversation.id, message: "Independent task",
    });
    assert.equal(independent.status, "queued");
    assert.equal(f.kernel.sent.length, 2);

    releaseFirst({ runId: f.kernel.sent[0].idempotencyKey, status: "started" });
    const receipt = await batch;
    assert.equal(receipt.outcomes.length, 3);
    assert.equal(receipt.outcomes.filter((outcome) => outcome.accepted).length, 1);
    assert.equal(f.kernel.sent.filter((turn) => turn.sessionKey === f.store.engineSessionKey(f.conversation.id, f.bot.id)).length, 1);
    f.kernel.complete(f.kernel.sent[0]);
    await second;
    assert.equal(f.kernel.sent.filter((turn) => turn.sessionKey === f.store.engineSessionKey(f.conversation.id, f.bot.id)).length, 2);
    f.kernel.complete(f.kernel.sent.at(-1)!);
    await third;
    assert.equal(f.kernel.sent.filter((turn) => turn.sessionKey === f.store.engineSessionKey(f.conversation.id, f.bot.id)).length, 3);
    f.kernel.complete(f.kernel.sent.at(-1)!);
    assert.deepEqual(f.kernel.sent.filter((turn) => turn.sessionKey === f.store.engineSessionKey(f.conversation.id, f.bot.id))
      .map((turn) => turn.attachments?.[0]?.fileName), ["one.txt", "two.txt", "three.txt"]);
  } finally { f.service.detach(); f.store.close(); }
});

test("file batch validation rejects duplicates, excessive inputs and another Bot's files before dispatch", async () => {
  const f = await fixture();
  try {
    const other = f.store.createBot({ name: "Other Bot" });
    const otherConversation = f.store.privateConversation(other.id);
    await assert.rejects(f.service.submitFileBatch({
      id: "file-batch-invalid-duplicate", botId: f.bot.id, conversationId: f.conversation.id,
      instruction: "Process", attachmentIds: [f.attachments[0].id, f.attachments[0].id],
    }), /Invalid file batch/);
    await assert.rejects(f.service.submitFileBatch({
      id: "file-batch-invalid-owner", botId: other.id, conversationId: otherConversation.id,
      instruction: "Process", attachmentIds: [f.attachments[0].id],
    }), /belong/);
    assert.equal(f.kernel.sent.length, 0);
    assert.equal(f.store.snapshot().fileBatches.length, 0);
  } finally { f.service.detach(); f.store.close(); }
});
