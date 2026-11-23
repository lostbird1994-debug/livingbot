import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { Migrations } from "./migration.ts";
import { WorkbenchStore } from "./store.ts";
import { Workspaces } from "./workspaces.ts";
import { verifyMigrationBackup } from "./migration-backup.ts";

async function fixture() {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp(resolve("local/test-fixtures/migration-flow-"));
  const source = join(root, "original");
  await mkdir(join(source, "skills", "example"), { recursive: true });
  await mkdir(join(source, "memory"));
  await writeFile(join(source, "AGENTS.md"), "# Synthetic identity\nKeep this profile.");
  await writeFile(join(source, "MEMORY.md"), "青岚项目交付十二月十日。");
  await writeFile(join(source, "memory", "source.md"), "Synthetic sourced note.");
  await writeFile(join(source, "skills", "example", "SKILL.md"), "# Synthetic method\nUse sources.");
  const store = new WorkbenchStore(join(root, "product.sqlite"));
  const workspaces = new Workspaces(join(root, "managed"));
  const registrations: { agentId: string; workspace: string }[] = [];
  let rejectRegistration = false;
  const migrations = new Migrations({
    store, workspaces, backupRoot: join(root, "backups"),
    registration: { async ensure(input) {
      registrations.push(input);
      if (rejectRegistration) throw new Error("Synthetic lost registration receipt");
    } },
  });
  return { root, source, store, workspaces, migrations, registrations, rejectRegistration(value: boolean) { rejectRegistration = value; } };
}

test("migration preview is nonmutating and explicit apply preserves identity, memory and ability bytes", async () => {
  const f = await fixture();
  try {
    const before = await readdir(f.source);
    const plan = await f.migrations.preview({ source: f.source, name: "Atlas", identity: "Synthetic role" });
    assert.equal(plan.state, "preview");
    assert.equal(f.store.snapshot().bots.length, 0);
    assert.deepEqual(await readdir(f.source), before);
    const first = f.migrations.apply(plan.id);
    const repeated = f.migrations.apply(plan.id);
    assert.equal(first, repeated);
    const result = await first;
    assert.equal(result.state, "ready");
    assert.equal(result.copied, 4);
    assert.equal(f.store.snapshot().bots.length, 1);
    const bot = f.store.snapshot().bots[0];
    assert.equal(bot.identity, "Synthetic role");
    assert.equal(bot.agentId, result.agentId);
    assert.equal(f.store.snapshot().conversations.length, 1);
    assert.equal((await f.migrations.apply(plan.id)).botId, bot.id);
    assert.equal(f.registrations.length, 1);
    const manifest = await verifyMigrationBackup(result.backup!);
    assert.equal((await stat(join(result.workspace!, "skills/example/SKILL.md"))).nlink, 1,
      "Native skill loader requires an independent file rather than a hardlink");
    for (const entry of manifest.files.filter((file) => file.path !== "AGENTS.md")) {
      assert.deepEqual(await readFile(join(result.workspace!, entry.path)), await readFile(join(f.source, entry.path)));
    }
    const instructions = await readFile(join(result.workspace!, "AGENTS.md"), "utf8");
    assert.ok(instructions.startsWith("# Synthetic identity\nKeep this profile."));
    assert.ok(instructions.includes("Synthetic role"));
    assert.ok(instructions.includes("Never permanently delete"));
    assert.equal(await readFile(join(f.source, "AGENTS.md"), "utf8"), "# Synthetic identity\nKeep this profile.");
  } finally { f.store.close(); }
});

test("failed native registration publishes no Bot and reopening resumes one owned import", async () => {
  const f = await fixture();
  let store = f.store;
  try {
    const plan = await f.migrations.preview({ source: f.source, name: "Atlas" });
    f.rejectRegistration(true);
    await assert.rejects(f.migrations.apply(plan.id), /lost registration/);
    const failed = f.migrations.get(plan.id);
    assert.equal(failed.state, "failed");
    assert.equal(store.snapshot().bots.length, 0);
    await verifyMigrationBackup(failed.backup!);
    store.close();
    store = new WorkbenchStore(join(f.root, "product.sqlite"));
    const resumed = new Migrations({
      store, workspaces: f.workspaces, backupRoot: join(f.root, "backups"),
      registration: { async ensure(input) { assert.equal(input.agentId, failed.agentId); } },
    });
    const result = await resumed.apply(plan.id);
    assert.equal(result.state, "ready");
    assert.equal(result.backup, failed.backup);
    assert.equal(result.botId, failed.botId);
    assert.equal(store.snapshot().bots.length, 1);
    assert.equal((await readdir(join(f.root, "backups"))).filter((name) => name.startsWith("bot-backup-")).length, 1);
  } finally { store.close(); }
});

test("an interrupted copy resumes only its verified prefix without overwriting existing bytes", async () => {
  const f = await fixture();
  try {
    const plan = await f.migrations.preview({ source: f.source, name: "Resume" });
    f.rejectRegistration(true);
    await assert.rejects(f.migrations.apply(plan.id));
    const staged = f.migrations.get(plan.id);
    const source = await readFile(join(f.source, "MEMORY.md"));
    await writeFile(join(staged.workspace!, "MEMORY.md"), source.subarray(0, 9));
    f.rejectRegistration(false);
    const result = await f.migrations.apply(plan.id);
    assert.equal(result.state, "ready");
    assert.deepEqual(await readFile(join(staged.workspace!, "MEMORY.md")), source);
    assert.deepEqual(await readFile(join(f.source, "MEMORY.md")), source);
  } finally { f.store.close(); }
});

test("changed previews and modified staging never publish or overwrite data", async () => {
  const f = await fixture();
  try {
    const changed = await f.migrations.preview({ source: f.source, name: "Changed" });
    await writeFile(join(f.source, "MEMORY.md"), "New user-authored memory");
    await assert.rejects(f.migrations.apply(changed.id), /changed/);
    assert.equal(f.store.snapshot().bots.length, 0);
    const plan = await f.migrations.preview({ source: f.source, name: "Retry" });
    f.rejectRegistration(true);
    await assert.rejects(f.migrations.apply(plan.id));
    const staged = f.migrations.get(plan.id);
    const target = join(staged.workspace!, "MEMORY.md");
    await writeFile(target, "Keep this manual edit");
    f.rejectRegistration(false);
    await assert.rejects(f.migrations.apply(plan.id), /differs/);
    assert.equal(await readFile(target, "utf8"), "Keep this manual edit");
    assert.equal(f.store.snapshot().bots.length, 0);
    assert.equal(await readFile(join(f.source, "MEMORY.md"), "utf8"), "New user-authored memory");
  } finally { f.store.close(); }
});

test("excluded sources need review and symlinked destinations cannot overwrite the source", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.source, "private-output.txt"), "Keep in original");
    const plan = await f.migrations.preview({ source: f.source, name: "Review" });
    assert.throws(() => f.migrations.apply(plan.id), /excluded/);
    await mkdir(f.workspaces.root);
    await symlink(f.source, join(f.workspaces.root, plan.agentId));
    await assert.rejects(f.migrations.apply(plan.id, true), /escaped/);
    assert.equal(f.store.snapshot().bots.length, 0);
    assert.equal(await readFile(join(f.source, "private-output.txt"), "utf8"), "Keep in original");
    await assert.rejects(f.migrations.preview({ source: f.workspaces.root, name: "Self" }), /outside/);
  } finally { f.store.close(); }
});

test("legacy archive and structured memories retain originals and get inspectable native Markdown projections", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.source, ".rakazo", "memory-archive"), { recursive: true });
    await writeFile(join(f.source, ".rakazo", "memory-archive", "past.md"), "Synthetic archived memory");
    const structured = '{"project":"Synthetic","delivery":"MIGRATION-STRUCTURED-93"}\n';
    await writeFile(join(f.source, "memory", "facts.jsonl"), structured);
    const plan = await f.migrations.preview({ source: f.source, name: "Archive" });
    assert.equal(plan.projections?.length, 2);
    const result = await f.migrations.apply(plan.id);
    for (const projection of result.projections!) {
      const source = await readFile(join(f.source, projection.source));
      assert.deepEqual(await readFile(join(result.workspace!, projection.source)), source);
      const projected = await readFile(join(result.workspace!, projection.target), "utf8");
      assert.ok(projected.includes(source.toString()));
      if (projection.format === "structured") {
        assert.ok(projected.includes("SHA256:"));
        assert.ok(projected.includes("Source: memory/facts.jsonl"));
      }
    }
  } finally { f.store.close(); }
});
