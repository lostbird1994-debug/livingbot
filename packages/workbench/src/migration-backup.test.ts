import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createMigrationBackup, verifyMigrationBackup } from "./migration-backup.ts";
import { inspectMigrationWorkspace } from "./migration-inventory.ts";

async function fixture() {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp(resolve("local/test-fixtures/migration-backup-"));
  const source = join(root, "source");
  await mkdir(join(source, "memory"), { recursive: true });
  await mkdir(join(source, "skills", "example"), { recursive: true });
  await writeFile(join(source, "SOUL.md"), "Synthetic identity");
  await writeFile(join(source, "memory", "project.md"), "合成项目记忆");
  await writeFile(join(source, "skills", "example", "SKILL.md"), "Synthetic ability");
  await writeFile(join(source, "unselected.txt"), "Retain in original workspace");
  await symlink(join(source, "memory", "project.md"), join(source, "memory", "linked.md"));
  return { source, backups: join(root, "backups") };
}

test("explicit backup copies and verifies selected bytes while preserving source and recording exclusions", async () => {
  const f = await fixture();
  const inventory = await inspectMigrationWorkspace(f.source);
  const original = await readdir(f.source);
  const backup = await createMigrationBackup(inventory, f.backups);
  const manifest = await verifyMigrationBackup(backup);
  assert.equal(manifest.files.length, 3);
  assert.ok(manifest.excluded.some((item) => item.path === "memory/linked.md"));
  assert.ok(manifest.excluded.some((item) => item.path === "unselected.txt"));
  assert.deepEqual(await readdir(f.source), original);
  for (const file of manifest.files) {
    assert.deepEqual(await readFile(join(backup, "files", file.path)), await readFile(join(f.source, file.path)));
  }
  const another = await createMigrationBackup(inventory, f.backups);
  assert.notEqual(backup, another);
  await writeFile(join(backup, "files", "SOUL.md"), "Tampered evidence");
  await assert.rejects(verifyMigrationBackup(backup), /changed/);
  assert.equal(await readFile(join(f.source, "SOUL.md"), "utf8"), "Synthetic identity");
});

test("backup rejects changed preview, incomplete selection, path traversal and source overlap", async () => {
  const f = await fixture();
  const inventory = await inspectMigrationWorkspace(f.source);
  await assert.rejects(createMigrationBackup({ ...inventory, complete: false }, f.backups), /incomplete/);
  await assert.rejects(createMigrationBackup(inventory, join(f.source, "backup")), /separate/);
  await assert.rejects(createMigrationBackup({
    ...inventory, files: [{ ...inventory.files.find((file) => file.path === "SOUL.md")!, path: "../outside" }],
  }, f.backups), /path/);
  await writeFile(join(f.source, "SOUL.md"), "Updated identity after preview");
  await assert.rejects(createMigrationBackup(inventory, f.backups), /changed/);
  assert.equal(await readFile(join(f.source, "SOUL.md"), "utf8"), "Updated identity after preview");
});
