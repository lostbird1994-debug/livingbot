import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { RecoverableMemoryFiles } from "./recoverable-memory-files.ts";

async function fixture() {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp(resolve("local/test-fixtures/recoverable-files-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const journal = join(root, "changes.jsonl");
  const files = new RecoverableMemoryFiles({ workspace, trash: join(homedir(), ".Trash"), journal });
  return { root, workspace, journal, files };
}

test("recoverable memory writes reject drift and links before moving any original", async () => {
  const f = await fixture();
  const path = join(f.workspace, "MEMORY.md");
  await writeFile(path, "Original");
  await assert.rejects(f.files.commitContent({ filePath: path, content: "Next", expectedContent: "Wrong" }), /changed/);
  await assert.rejects(f.files.commitContent({ filePath: path, content: null }), /observed/);
  await symlink(f.root, join(f.workspace, "outside"));
  await assert.rejects(f.files.readFile(join(f.workspace, "outside", "private.txt")), /parent/);
  await assert.rejects(f.files.readFile(join(f.root, "private.txt")), /escaped/);
  assert.equal(await readFile(path, "utf8"), "Original");
});

test("recoverable memory publication retains rewritten and removed originals in macOS Trash", { skip: process.platform !== "darwin" }, async () => {
  const f = await fixture();
  const path = join(f.workspace, "MEMORY.md");
  await writeFile(path, "合成原始记忆\n");
  await f.files.commitContent({ filePath: path, expectedContent: "合成原始记忆\n", content: "合成剩余记忆\n" });
  assert.equal(await readFile(path, "utf8"), "合成剩余记忆\n");
  await f.files.commitContent({ filePath: path, expectedContent: "合成剩余记忆\n", content: null });
  await assert.rejects(readFile(path), { code: "ENOENT" });
  const receipts = (await readFile(f.journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const committed = receipts.filter((receipt) => receipt.phase === "committed");
  assert.equal(committed.length, 2);
  assert.equal(await readFile(committed[0].recovery, "utf8"), "合成原始记忆\n");
  assert.equal(await readFile(committed[1].recovery, "utf8"), "合成剩余记忆\n");
  assert.ok(committed.every((receipt) => receipt.recovery.startsWith(join(homedir(), ".Trash", "LivingBot-memory-"))));
  // Kept evidence names each exact original and recoverable destination.
  console.log(JSON.stringify({ recoverableMoves: committed.map(({ original, recovery }) => ({ original, recovery })), journal: f.journal }));
});
