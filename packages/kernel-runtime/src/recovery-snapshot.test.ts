import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createRecoverySnapshot, restoreRecoverySnapshot, verifyRecoverySnapshot } from "./recovery-snapshot.ts";

async function fixture() {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp(resolve("local/test-fixtures/memory-recovery-"));
  const state = join(root, "state");
  const workspace = join(root, "workspace");
  await mkdir(join(state, "agents", "atlas"), { recursive: true });
  await mkdir(join(workspace, "memory", "empty"), { recursive: true });
  await writeFile(join(state, "agents", "atlas", "database.bin"), Buffer.from([0, 1, 2, 255]), { mode: 0o600, flag: "wx" });
  await writeFile(join(workspace, "MEMORY.md"), "合成记忆\n", { mode: 0o600, flag: "wx" });
  return { root, state, workspace, sources: [{ id: "kernel-state", path: state }, { id: "workspace", path: workspace }], backups: join(root, "backups") };
}

test("recovery snapshot retains binary state, Unicode files and empty directories with independent verification", async () => {
  const f = await fixture();
  const path = await createRecoverySnapshot(f.sources, f.backups);
  const manifest = await verifyRecoverySnapshot(path);
  assert.equal(manifest.files.length, 2);
  assert.ok(manifest.directories.some((item) => item.root === "workspace" && item.path === "memory/empty"));
  assert.deepEqual(await readFile(join(path, "files", "kernel-state", "agents", "atlas", "database.bin")), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(f.workspace, "MEMORY.md"), "后来新增的合成记忆\n");
  assert.equal((await readFile(join(path, "files", "workspace", "MEMORY.md"))).toString(), "合成记忆\n");
  await verifyRecoverySnapshot(path);
});

test("recovery snapshot rejects symlink sources, overlapping roots and nested destinations without changing source", async () => {
  const f = await fixture();
  await assert.rejects(createRecoverySnapshot(f.sources, join(f.workspace, "backups")), /separate/);
  await assert.rejects(createRecoverySnapshot([{ id: "outer", path: f.root }, { id: "inner", path: f.workspace }], f.backups));
  await symlink(f.state, join(f.workspace, "external"));
  await assert.rejects(createRecoverySnapshot(f.sources, f.backups), /symbolic links/);
  assert.equal((await readFile(join(f.workspace, "MEMORY.md"))).toString(), "合成记忆\n");
});

test("recovery verification rejects modified bytes, extra files and manifest tampering", async () => {
  const changed = await fixture();
  const first = await createRecoverySnapshot(changed.sources, changed.backups);
  await writeFile(join(first, "files", "workspace", "MEMORY.md"), "被修改\n");
  await assert.rejects(verifyRecoverySnapshot(first), /changed|integrity/);
  const extra = await fixture();
  const second = await createRecoverySnapshot(extra.sources, extra.backups);
  await writeFile(join(second, "files", "workspace", "extra.txt"), "Unrecorded");
  await assert.rejects(verifyRecoverySnapshot(second), /unrecorded/);
  const tampered = await fixture();
  const third = await createRecoverySnapshot(tampered.sources, tampered.backups);
  const manifest = JSON.parse((await readFile(join(third, "manifest.json"))).toString());
  manifest.roots[0].path = tampered.workspace;
  await writeFile(join(third, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyRecoverySnapshot(third), /integrity/);
});

test("explicit runtime exclusions are recorded and never followed while durable files remain verified", async () => {
  const f = await fixture();
  await mkdir(join(f.state, "tmp"));
  await symlink(f.workspace, join(f.state, "tmp", "native-cli-shim"));
  const sources = [{ id: "kernel-state", path: f.state, exclude: ["tmp"] }, f.sources[1]];
  const path = await createRecoverySnapshot(sources, f.backups);
  const manifest = await verifyRecoverySnapshot(path);
  assert.deepEqual(manifest.roots[0].exclude, ["tmp"]);
  assert.equal(manifest.files.some((file) => file.path.startsWith("tmp/")), false);
  assert.equal(manifest.files.some((file) => file.path.endsWith("database.bin")), true);
  await assert.rejects(createRecoverySnapshot([{ id: "state", path: f.state, exclude: ["../outside"] }], f.backups), /path/);
});

test("a verified copy restores into a fresh independent target and never overwrites", async () => {
  const f = await fixture();
  const path = await createRecoverySnapshot(f.sources, f.backups);
  const target = join(f.root, "restored");
  const receipt = await restoreRecoverySnapshot(path, target);
  assert.equal(receipt.files, 2);
  assert.equal(receipt.bytes, 4 + Buffer.byteLength("合成记忆\n"));
  assert.deepEqual(await readFile(join(target, "files", "kernel-state", "agents", "atlas", "database.bin")),
    Buffer.from([0, 1, 2, 255]));
  assert.equal((await readFile(join(target, "files", "workspace", "MEMORY.md"))).toString(), "合成记忆\n");
  await verifyRecoverySnapshot(path);
  await assert.rejects(restoreRecoverySnapshot(path, target), /already exists/);
});

test("restoring refuses a tampered copy, live sources and the copy itself", async () => {
  const f = await fixture();
  const path = await createRecoverySnapshot(f.sources, f.backups);
  await assert.rejects(restoreRecoverySnapshot(path, join(f.workspace, "restored")), /recorded sources/);
  await assert.rejects(restoreRecoverySnapshot(path, join(f.state, "restored")), /recorded sources/);
  await assert.rejects(restoreRecoverySnapshot(path, join(path, "restored")), /separate from the copy/);
  await writeFile(join(path, "files", "workspace", "MEMORY.md"), "被篡改的合成记忆\n");
  await assert.rejects(restoreRecoverySnapshot(path, join(f.root, "restored")), /changed or exceeds/);
  assert.equal((await readFile(join(f.workspace, "MEMORY.md"))).toString(), "合成记忆\n");
});
