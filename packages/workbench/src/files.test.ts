import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Files, maxFileBytes } from "./files.ts";
import { Workspaces } from "./workspaces.ts";
import { WorkbenchStore } from "./store.ts";
import { WorkbenchService } from "./service.ts";
import type { Message, Run } from "./contracts.ts";
import type { Submission } from "../../kernel-runtime/src/contracts.ts";

async function fixture() {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp("local/test-fixtures/files-");
  const store = new WorkbenchStore(":memory:");
  const bot = store.createBot({ name: "Example" });
  const conversation = store.privateConversation(bot.id);
  const workspaces = new Workspaces(join(process.cwd(), root, "bots"));
  const files = new Files(store, workspaces);
  return { root, store, bot, conversation, workspaces, files };
}

test("the space file listing filters by owner and Trash keeps original bytes recoverable", async () => {
  const f = await fixture();
  try {
    const file = await f.files.attach({ id: "trash-fixture-01", botId: f.bot.id,
      conversationId: f.conversation.id, name: "synthetic-trash.txt",
      mediaType: "text/plain", bytes: Buffer.from("recoverable synthetic bytes") });
    const other = f.store.createBot({ name: "Other" });
    assert.equal(f.files.listSpace({ botId: other.id }).files.length, 0);
    assert.equal(f.files.listSpace().files.length, 1);
    assert.equal("path" in f.files.listSpace().files[0]!, false);
    if (process.platform === "darwin") {
      const receipt = await f.files.trash(file.id);
      assert.equal(receipt.original, file.path);
      assert.ok(receipt.recovery.includes("/.Trash/LivingBot-file-"));
      assert.equal(await readFile(receipt.recovery, "utf8"), "recoverable synthetic bytes");
      await assert.rejects(stat(file.path), { code: "ENOENT" });
      await assert.rejects(f.files.read(file.id), /废纸篓|Trash/);
      assert.equal(f.files.listSpace().files.length, 0);
      assert.deepEqual(await f.files.trash(file.id), receipt);
      console.log(JSON.stringify({ fixtureTrash: receipt }));
    }
  } finally { f.store.close(); }
});

test("attachment retries preserve one immutable file, scope and exact submission bytes", async () => {
  const f = await fixture();
  const sent: Submission[] = [];
  const kernel = Object.assign(new EventEmitter(), {
    generation: 1, phase: "ready",
    async request<T>(): Promise<T> { throw new Error("Unexpected request"); },
    async send(input: Submission) { sent.push(input); return { runId: input.idempotencyKey, status: "started" }; },
    async recoverHistory() { return { messages: [] }; },
    async abort() { return {}; },
  });
  const service = new WorkbenchService(f.store, kernel, undefined, f.files);
  try {
    const input = {
      id: "attachment-example-1", botId: f.bot.id, conversationId: f.conversation.id,
      name: "资料.txt", mediaType: "text/plain", bytes: Buffer.from("Synthetic attachment"),
    };
    const [first, repeated] = await Promise.all([f.files.attach(input), f.files.attach(input)]);
    assert.equal(first.id, repeated.id);
    assert.equal(f.store.list("artifacts").length, 1);
    await assert.rejects(f.files.attach({ ...input, bytes: Buffer.from("Different") }), /conflicts/);
    const other = f.store.createBot({ name: "Other" });
    const otherConversation = f.store.privateConversation(other.id);
    assert.throws(() => f.files.validateAttachments([first.id], other.id, otherConversation.id), /belong/);
    const submission = {
      submissionId: "file-submission", botId: f.bot.id, conversationId: f.conversation.id,
      message: "", attachmentIds: [first.id],
    };
    await service.submit(submission);
    await service.submit(submission);
    assert.equal(sent.length, 1);
    assert.equal(Buffer.from(sent[0].attachments![0].content, "base64").toString(), "Synthetic attachment");
    assert.equal(f.store.messages(f.conversation.id)[0].blocks[0].kind, "file");
    await assert.rejects(service.submit({ ...submission, attachmentIds: [] }), /length|conflicts/);
    await writeFile(first.path, "tampered fixture");
    await assert.rejects(f.files.read(first.id), /integrity/);
  } finally { service.detach(); f.store.close(); }
});

test("native deliveries require the live task, refuse links and leave immutable receipts in both destinations", async () => {
  const f = await fixture();
  try {
    const group = f.store.createConversation("group", [f.bot.id], "Example project");
    const started = f.store.beginSubmission({
      submissionId: "delivery-task", botId: f.bot.id, conversationId: group.id,
      reportConversationId: f.conversation.id, message: "Produce a file",
    });
    f.store.acceptSubmission(started.submission.id, "delivery-native-run", 1);
    const run = f.store.get<Run>("runs", "delivery-native-run")!;
    f.store.put("runs", { ...run, state: "running" });
    const authority = {
      agentId: f.bot.agentId, sessionKey: run.sessionKey, runId: run.id, toolCallId: "call-1",
    };
    const source = await f.workspaces.write(f.bot.agentId, "projects", "example/result.txt", "Finished synthetic work");
    const file = await f.files.deliver({ ...authority, relativePath: "projects/example/result.txt", mediaType: "text/plain" });
    assert.ok(file.path.includes(`/tasks/${started.task.id}/deliveries/`));
    const repeat = await f.files.deliver({ ...authority, relativePath: "projects/example/result.txt", mediaType: "text/plain" });
    assert.equal(file.id, repeat.id);
    assert.equal((await f.files.read(file.id)).bytes.toString(), "Finished synthetic work");
    for (const conversation of [group, f.conversation]) {
      assert.equal(f.store.messages(conversation.id).filter((message: Message) =>
        message.blocks.some((block) => block.kind === "file" && block.artifactId === file.id)).length, 1);
    }
    await writeFile(source, "Changed source");
    assert.equal((await f.files.read(file.id)).bytes.toString(), "Finished synthetic work");
    await assert.rejects(f.files.deliver({ ...authority, relativePath: "projects/example/result.txt" }), /conflicts/);
    const newer = await f.files.deliver({ ...authority, toolCallId: "call-final", relativePath: "projects/example/result.txt" });
    assert.equal(newer.supersedesId, file.id);
    for (const conversation of [group, f.conversation]) {
      const reply = f.store.messages(conversation.id).find((message) => message.role === "assistant")!;
      assert.equal(reply.id, conversation.id === group.id ? `engine:${run.id}` : `report:${started.task.id}`);
      assert.equal(reply.final, false);
      assert.deepEqual(reply.blocks.filter((block) => block.kind === "file").map((block) => block.artifactId), [newer.id]);
    }
    assert.equal((await f.files.read(file.id)).bytes.toString(), "Finished synthetic work");

    await assert.rejects(f.files.deliver({ ...authority, relativePath: "../other/private.txt" }), /Deliver/);
    await assert.rejects(f.files.deliver({ ...authority, relativePath: "tasks/../profile/private.txt" }), /Deliver/);
    await symlink(source, join(await f.workspaces.prepare(f.bot.agentId), "tasks", "alias.txt"));
    await assert.rejects(f.files.deliver({ ...authority, relativePath: "tasks/alias.txt" }), /symbolic/);
    f.store.updateTask(started.task.id, "stopping");
    await assert.rejects(f.files.deliver({ ...authority, relativePath: "projects/example/result.txt" }), /authority/);
    f.store.put("runs", { ...run, state: "completed" });
    await assert.rejects(f.files.deliver({ ...authority, relativePath: "projects/example/result.txt" }), /authority/);
  } finally { f.store.close(); }
});

test("file inventory is paginated per Bot, exposes no host path and survives reopening", async () => {
  const f = await fixture();
  try {
    const other = f.store.createBot({ name: "Other files" });
    const first = await f.files.attach({
      id: "inventory-source-01", botId: f.bot.id, conversationId: f.conversation.id,
      name: "source.txt", mediaType: "text/plain", bytes: Buffer.from("Synthetic source"),
    });
    for (let index = 0; index < 54; index++) f.store.put("artifacts", {
      ...first, id: `inventory-${String(index).padStart(3, "0")}`,
    });
    f.store.put("artifacts", { ...first, id: "other-bot-artifact", botId: other.id });
    const firstPage = f.files.list(f.bot.id);
    assert.equal(firstPage.files.length, 50);
    assert.ok(firstPage.next);
    assert.ok(firstPage.files.every((file) => !("path" in file) && file.botId === f.bot.id));
    const second = f.files.list(f.bot.id, firstPage.next);
    assert.equal(second.files.length, 5);
    assert.equal(second.next, undefined);
    assert.equal(new Set([...firstPage.files, ...second.files].map((file) => file.id)).size, 55);
    assert.equal(f.files.list(other.id).files.length, 1);
    assert.throws(() => f.files.list(other.id, firstPage.next), /cursor/);
    assert.throws(() => f.files.list("missing"), /Unknown Bot/);
    const reopened = new Files(f.store, f.workspaces);
    assert.deepEqual(reopened.list(f.bot.id), firstPage);
    assert.equal((await reopened.read(first.id)).bytes.toString(), "Synthetic source");
  } finally { f.store.close(); }
});

test("an anchored revision delivers a new version while the source and unrelated bytes survive", async () => {
  const f = await fixture();
  const source = "# 合成合同\r\n\r\n## 付款\r\n分三期支付，首期 30%。\r\n\r\n## 交付\r\n3 月 1 日交付。\r\n\r\n## 违约\r\n按日计罚。\r\n";
  try {
    const group = f.store.createConversation("group", [f.bot.id], "Revision project");
    const started = f.store.beginSubmission({
      submissionId: "revision-task", botId: f.bot.id, conversationId: group.id,
      reportConversationId: f.conversation.id, message: "按批注修订合同",
    });
    f.store.acceptSubmission(started.submission.id, "revision-native-run", 1);
    const run = f.store.get<Run>("runs", "revision-native-run")!;
    f.store.put("runs", { ...run, state: "running" });
    const authority = {
      agentId: f.bot.agentId, sessionKey: run.sessionKey, runId: run.id, toolCallId: "revision-call-1",
    };
    await f.workspaces.write(f.bot.agentId, "projects", "example/contract.md", source);
    const revised = await f.files.revise({
      ...authority, relativePath: "projects/example/contract.md", anchor: "首期 30%", replacement: "首期 20%",
    });
    // The user's original is untouched, and the new version is a separate immutable file.
    assert.equal((await f.workspaces.read(f.bot.agentId, "projects/example/contract.md", maxFileBytes)).toString(), source);
    const delivered = (await f.files.read(revised.artifact.id)).bytes.toString();
    assert.equal(delivered, source.replace("首期 30%", "首期 20%"));
    assert.ok(delivered.includes("\r\n## 交付\r\n3 月 1 日交付。"));
    assert.ok(delivered.includes("## 违约\r\n按日计罚。"));
    assert.ok(revised.artifact.path.includes(`/tasks/${started.task.id}/deliveries/`));
    assert.equal(revised.artifact.mediaType, "text/markdown");
    assert.equal(revised.passage.removed, "首期 30%");
    assert.equal(revised.passage.inserted, "首期 20%");
    assert.equal(revised.source.digest, createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex"));
    assert.notEqual(revised.artifact.digest, revised.source.digest);
    for (const conversation of [group, f.conversation]) {
      assert.equal(f.store.messages(conversation.id).filter((message: Message) =>
        message.blocks.some((block) => block.kind === "file" && block.artifactId === revised.artifact.id)).length, 1);
    }
    // One tool call produces one version, however often it is retried.
    const repeated = await f.files.revise({
      ...authority, relativePath: "projects/example/contract.md", anchor: "首期 30%", replacement: "首期 20%",
    });
    assert.equal(repeated.artifact.id, revised.artifact.id);
    assert.equal(f.store.list("artifacts").length, 1);
    // A further change is applied to the delivered version, not stacked on the original.
    const chained = await f.files.revise({
      ...authority, toolCallId: "revision-call-2", expectedDigest: revised.artifact.digest,
      relativePath: `tasks/${started.task.id}/deliveries/${revised.artifact.id}/contract.md`,
      anchor: "按日计罚", replacement: "按日计罚，上限为合同总额的 5%。",
    });
    const chainedText = (await f.files.read(chained.artifact.id)).bytes.toString();
    assert.ok(chainedText.includes("首期 20%") && chainedText.includes("上限为合同总额的 5%。"));
    assert.ok((await f.files.read(revised.artifact.id)).bytes.toString().includes("按日计罚。\r\n"));
    // An ambiguous anchor, a stale base and an impossible path are refused, not guessed.
    await f.workspaces.write(f.bot.agentId, "projects", "example/duplicated.md", `${source}\r\n分三期支付，首期 30%。`);
    await assert.rejects(f.files.revise({
      ...authority, toolCallId: "revision-call-3", relativePath: "projects/example/duplicated.md",
      anchor: "首期 30%", replacement: "首期 20%",
    }), /more than once/);
    await assert.rejects(f.files.revise({
      ...authority, toolCallId: "revision-call-4", relativePath: "projects/example/contract.md",
      anchor: "首期 30%", replacement: "首期 20%", expectedDigest: "b".repeat(64),
    }), /changed since it was reviewed/);
    await assert.rejects(f.files.revise({
      ...authority, toolCallId: "revision-call-5", relativePath: "../profile/identity.md",
      anchor: "a", replacement: "b",
    }), /Revise documents/);
    await assert.rejects(f.files.revise({
      ...authority, toolCallId: "revision-call-6", relativePath: "projects/example/contract.md",
      anchor: "不存在的段落", replacement: "b",
    }), /does not appear/);
    await f.workspaces.write(f.bot.agentId, "projects", "example/binary.md", Buffer.from([0xff, 0xfe, 0x00]));
    await assert.rejects(f.files.revise({
      ...authority, toolCallId: "revision-call-7", relativePath: "projects/example/binary.md",
      anchor: "a", replacement: "b",
    }), /UTF-8 text document/);
    assert.equal(f.store.list("artifacts").length, 2);
    // A stopped or finished task can no longer revise its documents.
    f.store.updateTask(started.task.id, "stopping");
    await assert.rejects(f.files.revise({
      ...authority, toolCallId: "revision-call-8", relativePath: "projects/example/contract.md",
      anchor: "首期 30%", replacement: "首期 20%",
    }), /authority/);
  } finally { f.store.close(); }
});
