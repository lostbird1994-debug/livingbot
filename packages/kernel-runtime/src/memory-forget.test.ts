import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { memoryForgetPreview, memoryForgetScopeSummary, memoryPreviewDigest, OpenClawMemoryForgetPreview } from "./memory-forget.ts";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimePaths } from "./paths.ts";

function report() {
  return {
    agentId: "atlas", dryRun: true, sessionIds: ["native-session"],
    sessionResolutions: [{ sessionId: "native-session", sessionKey: "agent:atlas:explicit:example", source: "live" }],
    entryKeys: ["entry"], mixedLineageEntryKeys: ["entry"], untargetableEntryKeys: ["old-entry"],
    curatedWrites: [{ relativePath: "memory/project.md", observedAt: 1 }],
    artifacts: Object.fromEntries([
      "memoryFiles", "memoryEntries", "memoryLines", "sessionCorpusFiles", "sessionCorpusLines",
      "indexChunks", "indexSources", "ftsRows", "vectorRows", "embeddingCacheRows",
      "shortTermEntries", "seenHashScopes", "backups", "originRows",
    ].map((key) => [key, 0])),
    refusals: ["Historical text requires manual review"],
  };
}

test("forgetting previews retain native uncertainty and counters without leaking unknown diagnostics", () => {
  const input = { ...report(), privateDiagnostic: "/private/not-returned" };
  const preview = memoryForgetPreview(input, "atlas");
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.mixedLineageEntryKeys, ["entry"]);
  assert.deepEqual(preview.refusals, input.refusals);
  assert.equal(JSON.stringify(preview).includes("privateDiagnostic"), false);
  const unresolved = report();
  unresolved.sessionResolutions = [{ sessionId: "missing", sessionKey: "agent:atlas:explicit:missing", source: "unresolved" }];
  assert.equal(memoryForgetPreview(unresolved, "atlas").sessionResolutions[0].source, "unresolved");
});

test("forgetting preview parser rejects apply output, ownership mismatch, escaping paths and corrupt counts", () => {
  assert.throws(() => memoryForgetPreview({ ...report(), dryRun: false }, "atlas"), /ownership/);
  assert.throws(() => memoryForgetPreview(report(), "moss"), /ownership/);
  assert.throws(() => memoryForgetPreview({
    ...report(), curatedWrites: [{ relativePath: "../other/MEMORY.md", observedAt: 1 }],
  }, "atlas"), /path/);
  const input = report();
  input.artifacts.memoryFiles = -1;
  assert.throws(() => memoryForgetPreview(input, "atlas"), /count/);
});

test("forgetting report states every affected scope and names the untouched ones honestly", () => {
  const input = report();
  input.artifacts.memoryFiles = 1;
  input.artifacts.memoryLines = 4;
  input.artifacts.sessionCorpusFiles = 1;
  input.artifacts.indexChunks = 6;
  const scopes = memoryForgetScopeSummary(memoryForgetPreview(input, "atlas"));
  const affected = scopes.filter((scope) => scope.affected).map((scope) => scope.id);
  assert.deepEqual(affected, ["memory-documents", "session-transcripts", "retrieval-index", "curated-writes"]);
  assert.deepEqual(scopes.find((scope) => scope.id === "memory-documents")?.counts,
    { memoryFiles: 1, memoryEntries: 0, memoryLines: 4 });
  // An empty native counter is reported as untouched rather than hidden.
  assert.equal(scopes.find((scope) => scope.id === "native-backups")?.affected, false);
  assert.deepEqual(memoryForgetScopeSummary(memoryForgetPreview(report(), "atlas")).filter((scope) => scope.affected)
    .map((scope) => scope.id), ["curated-writes"]);
});

test("native preview refuses malformed or another agent's selectors before starting a child", async () => {
  const adapter = new OpenClawMemoryForgetPreview({
    nodeExecutable: "/unavailable-node", entry: "/unavailable-kernel", paths: runtimePaths(resolve("local/unused-memory-preview")),
  });
  await assert.rejects(adapter.preview("atlas", []), /Select/);
  await assert.rejects(adapter.preview("atlas", ["agent:moss:explicit:example"]), /ownership/);
  await assert.rejects(adapter.preview("atlas", ["agent:atlas:explicit:example\n--apply"]), /field/);
  await assert.rejects(adapter.preview("../atlas", ["agent:atlas:explicit:example"]), /identifier/);
});

test("native recovery preparation refuses drift before copying and retains an independently verified offline snapshot", async () => {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp(resolve("local/test-fixtures/forget-preparation-"));
  const paths = runtimePaths(root);
  await mkdir(paths.state, { recursive: true });
  await mkdir(join(paths.workspaces, "atlas"), { recursive: true });
  await writeFile(join(paths.state, "synthetic.bin"), Buffer.from([1, 2, 0, 255]));
  await writeFile(join(paths.workspaces, "atlas", "MEMORY.md"), "Synthetic memory");
  const adapter = new OpenClawMemoryForgetPreview({ nodeExecutable: "/unused", entry: "/unused", paths });
  const preview = memoryForgetPreview(report(), "atlas");
  // Offline provider fixture: no native process or semantic evaluator.
  adapter.preview = async () => preview;
  await assert.rejects(adapter.prepare("atlas", ["agent:atlas:explicit:example"], "a".repeat(64)), /changed/);
  const digest = memoryPreviewDigest(preview);
  const recovery = await adapter.prepare("atlas", ["agent:atlas:explicit:example"], digest);
  assert.equal(recovery.previewDigest, digest);
  assert.equal(recovery.files, 2);
  assert.deepEqual(await readFile(join(root, "memory-recovery", recovery.id, "files", "kernel-state", "synthetic.bin")), Buffer.from([1, 2, 0, 255]));
});

test("startup refuses running or recovery-required memory operations and accepts completed native outcomes", async () => {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp(resolve("local/test-fixtures/forget-startup-"));
  const paths = runtimePaths(root);
  const adapter = new OpenClawMemoryForgetPreview({ nodeExecutable: "/unused", entry: "/unused", paths });
  await adapter.assertNoUnfinishedOperations();
  const operation = join(root, "memory-operations", "memory-forget-synthetic");
  await mkdir(operation, { recursive: true });
  await writeFile(join(operation, "prepared.json"), "{}");
  await adapter.assertNoUnfinishedOperations();
  await writeFile(join(operation, "running.json"), "{}");
  await assert.rejects(adapter.assertNoUnfinishedOperations(), /explicit recovery/);
  await writeFile(join(operation, "outcome.json"), JSON.stringify({ status: "recovery-required" }));
  await assert.rejects(adapter.assertNoUnfinishedOperations(), /explicit recovery/);
  await writeFile(join(operation, "outcome.json"), JSON.stringify({ status: "completed" }));
  await adapter.assertNoUnfinishedOperations();
});

test("durable forgetting requests recover exact outcomes and never repeat uncertain native operations", async () => {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp(resolve("local/test-fixtures/forget-request-"));
  const adapter = new OpenClawMemoryForgetPreview({ nodeExecutable: "/unused", entry: "/unused", paths: runtimePaths(root) });
  const requestId = "memory-forget-reviewed";
  const sessions = ["agent:atlas:explicit:example"];
  const digest = "a".repeat(64);
  assert.equal(await adapter.outcome("atlas", sessions, digest, requestId), undefined);
  const operation = join(root, "memory-operations", "memory-forget-synthetic");
  await mkdir(operation, { recursive: true });
  await writeFile(join(operation, "request.json"), JSON.stringify({ requestId, agentId: "atlas", sessions, expectedDigest: digest }));
  assert.equal(await adapter.outcome("atlas", sessions, digest, requestId), undefined);
  await writeFile(join(operation, "running.json"), "{}");
  await assert.rejects(adapter.apply("atlas", sessions, digest, requestId), /explicit recovery/);
  const outcome = {
    id: "memory-forget-synthetic", agentId: "atlas", status: "completed", createdAt: 1, files: [],
    recovery: { id: "memory-recovery-synthetic", createdAt: 1, digest: "b".repeat(64), previewDigest: digest,
      files: 2, bytes: 8, scope: "kernel-and-selected-workspace" },
  };
  await writeFile(join(operation, "outcome.json"), JSON.stringify(outcome));
  // The unavailable executable ensures this is a disk receipt read, not a second CLI call.
  assert.deepEqual(await adapter.apply("atlas", sessions, digest, requestId), outcome);
  await assert.rejects(adapter.outcome("moss", sessions, digest, requestId), /ownership/);
  await assert.rejects(adapter.outcome("atlas", [...sessions, "agent:atlas:explicit:other"], digest, requestId), /ownership/);
  await assert.rejects(adapter.outcome("atlas", sessions, "b".repeat(64), requestId), /ownership/);
  assert.equal(await adapter.outcome("atlas", sessions, digest, "memory-forget-other"), undefined);
});
