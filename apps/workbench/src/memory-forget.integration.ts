import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchWorkbench } from "./main.ts";
import { OpenClawMemoryForgetPreview, memoryPreviewDigest } from "../../../packages/kernel-runtime/src/memory-forget.ts";
import { verifyRecoverySnapshot } from "../../../packages/kernel-runtime/src/recovery-snapshot.ts";
import type { Task } from "../../../packages/workbench/src/contracts.ts";
import type { ForgetReview } from "../../../packages/workbench/src/memory.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-forget-"));
const model = createServer(async (request, response) => {
  for await (const _ of request) { /* synthetic request only */ }
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish_reason] of [[{ role: "assistant", content: "Synthetic result." }, null], [{}, "stop"]]) {
    response.write(`data: ${JSON.stringify({ id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
const evidence: { scenarios: string[]; observations: unknown[]; error?: string } = { scenarios: [], observations: [] };
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
try {
  app = await launchWorkbench({
    root: join(root, "application"), nodeExecutable: process.execPath, kernelEntry: resolve(values["kernel-entry"]),
    connection: { id: "synthetic", baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      api: "openai-completions", apiKey: "synthetic", model: "synthetic", contextWindow: 32000, maxTokens: 1000 },
  });
  const { store, kernel, paths } = app;
  const bot = store.snapshot().bots[0];
  const conversation = store.privateConversation(bot.id);
  const task = await app.service.submit({ submissionId: randomUUID(), botId: bot.id, conversationId: conversation.id, message: "Synthetic forgotten fact." });
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => { store.off("event", changed); reject(new Error("Synthetic turn timeout")); }, 45000);
    function changed() {
      const current = store.get<Task>("tasks", task.id)!;
      if (!["completed", "failed", "cancelled"].includes(current.status)) return;
      clearTimeout(timer); store.off("event", changed);
      if (current.status !== "completed") reject(new Error("Synthetic task failed")); else done();
    }
    store.on("event", changed); changed();
  });
  const sessionKey = store.engineSessionKey(conversation.id, bot.id);
  const inventory = await kernel.request<{ sessions: { key: string; sessionId: string }[] }>("sessions.list", {});
  const session = inventory.sessions.find((session) => session.key === sessionKey)!;
  assert.ok(session.sessionId);
  const workspace = join(paths.workspaces, bot.agentId);
  const corpus = join(workspace, "memory", ".dreams", "session-corpus", "synthetic.txt");
  const memory = join(workspace, "MEMORY.md");
  const requestId = `memory-forget-${randomUUID()}`;
  await kernel.offlineMaintenance(async () => {
    await mkdir(join(workspace, "memory", ".dreams", "session-corpus"), { recursive: true });
    // Exact source notation recognized by the official provenance scrubber.
    const line = `[sessions/${bot.agentId}/${session.sessionId}.jsonl#L2] Synthetic forgotten fact with enough characters.`;
    await writeFile(corpus, `${line}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(memory, `# Synthetic memory\n\nSynthetic forgotten fact with enough characters.\n\nKeep this independent fact.\n`, { mode: 0o600, flag: "wx" });
    const adapter = new OpenClawMemoryForgetPreview({ nodeExecutable: process.execPath, entry: resolve(values["kernel-entry"]!), paths });
    const preview = await adapter.preview(bot.agentId, [sessionKey]);
    evidence.observations.push({ preview });
    assert.equal(preview.artifacts.sessionCorpusFiles, 1);
    assert.equal(preview.artifacts.memoryFiles, 1);
    store.put("settings", {
      id: requestId, botId: bot.id, conversationIds: [conversation.id], sessions: [sessionKey],
      createdAt: Date.now(), digest: memoryPreviewDigest(preview), report: preview,
    });
    const backup = await adapter.prepare(bot.agentId, [sessionKey], memoryPreviewDigest(preview));
    await verifyRecoverySnapshot(join(paths.root, "memory-recovery", backup.id));
    evidence.scenarios.push("reviewed-native-forgetting-has-verified-offline-backup");
    const outcome = await adapter.apply(bot.agentId, [sessionKey], memoryPreviewDigest(preview), requestId);
    evidence.observations.push({ outcome });
    assert.equal(outcome.status, "completed", outcome.error);
    const report = outcome.report!;
    assert.equal(report.dryRun, false);
    assert.deepEqual(report.sessionIds, [session.sessionId]);
    assert.equal(await readFile(memory, "utf8"), "# Synthetic memory\n\n\nKeep this independent fact.\n");
    await assert.rejects(readFile(corpus), { code: "ENOENT" });
    const moved = outcome.files;
    assert.equal(moved.length, 2);
    for (const receipt of moved) assert.ok((await readFile(receipt.recovery)).length > 0);
    evidence.observations.push({ backup, report, moved });
    evidence.scenarios.push("official-sdk-maintenance-preserves-rewritten-memory-and-removed-corpus-in-trash");
    const remaining = await adapter.preview(bot.agentId, [sessionKey]);
    assert.equal(remaining.artifacts.memoryFiles, 0);
    assert.equal(remaining.artifacts.sessionCorpusFiles, 0);
    evidence.scenarios.push("native-post-forget-preview-has-no-matching-workspace-artifacts");
    await adapter.assertNoUnfinishedOperations();
    evidence.scenarios.push("durable-completed-forgetting-outcome-allows-kernel-startup");
    assert.deepEqual(await adapter.apply(bot.agentId, [sessionKey], memoryPreviewDigest(preview), requestId), outcome);
    evidence.scenarios.push("exact-native-request-replays-durable-outcome-without-second-forgetting");
  });
  assert.equal(kernel.phase, "ready");
  evidence.scenarios.push("kernel-restarts-after-native-recoverable-forgetting");
  assert.equal(store.get<ForgetReview>("settings", requestId)?.outcome, undefined);
  await app.close();
  app = undefined;
  app = await launchWorkbench({
    root: paths.root, nodeExecutable: process.execPath, kernelEntry: resolve(values["kernel-entry"]),
  });
  const recovered = app.store.get<ForgetReview>("settings", requestId)!;
  assert.equal(recovered.outcome?.status, "completed");
  assert.equal(app.service.memories!.recoveries(bot.id)[0].outcome?.id, recovered.outcome?.id);
  assert.equal(app.kernel.phase, "ready");
  assert.equal(await readFile(memory, "utf8"), "# Synthetic memory\n\n\nKeep this independent fact.\n");
  evidence.scenarios.push("full-product-restart-recovers-lost-product-receipt-from-exact-native-outcome");
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await app?.close();
  await new Promise<void>((done) => model.close(() => done()));
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ root, ...evidence }, null, 2));
}
