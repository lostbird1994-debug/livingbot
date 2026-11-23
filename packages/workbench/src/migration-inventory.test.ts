import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { inspectMigrationWorkspace } from "./migration-inventory.ts";

test("migration inventory hashes identity, memory and abilities without importing or following links", async () => {
  await mkdir("local/test-fixtures", { recursive: true });
  const fixture = await mkdtemp("local/test-fixtures/migration-inventory-");
  const root = resolve(fixture, "source");
  for (const area of ["memory", "skills/example", "node_modules", "projects"]) await mkdir(join(root, area), { recursive: true });
  const source = "# Synthetic identity\n";
  await writeFile(join(root, "AGENTS.md"), source);
  await writeFile(join(root, "memory/example.md"), "Synthetic memory");
  await writeFile(join(root, "skills/example/SKILL.md"), "Synthetic ability");
  await writeFile(join(root, "projects/output.txt"), "Keep the original");
  await symlink(join(root, "memory/example.md"), join(root, "memory/link.md"));
  const inventory = await inspectMigrationWorkspace(root);
  assert.equal(inventory.complete, true);
  assert.equal(inventory.files.find((file) => file.path === "AGENTS.md")?.sha256,
    createHash("sha256").update(source).digest("hex"));
  assert.equal(inventory.files.find((file) => file.path === "memory/link.md")?.status, "symlink");
  assert.equal(inventory.files.find((file) => file.path === "skills/example/SKILL.md")?.kind, "ability");
  assert.equal(inventory.files.find((file) => file.path === "projects/output.txt")?.status, "metadata-only");
  assert.equal(inventory.omitted[0].path, "node_modules");
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), source);
});
