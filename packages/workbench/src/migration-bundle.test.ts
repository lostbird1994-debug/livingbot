import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { prepareMigrationBundle } from "./migration-bundle.ts";
import { createMigrationBackup } from "./migration-backup.ts";
import { inspectMigrationSkill, inspectMigrationWorkspace } from "./migration-inventory.ts";
import { Migrations } from "./migration.ts";
import { WorkbenchStore } from "./store.ts";
import { Workspaces } from "./workspaces.ts";

test("portable batch previews all identities and imports each once with persona, color, memory and skill intact", async () => {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp(resolve("local/test-fixtures/migration-bundle-"));
  const sources = [];
  for (let index = 0; index < 8; index++) {
    const source = join(root, `source-${index}`);
    await mkdir(join(source, "skills", "example"), { recursive: true });
    await writeFile(join(source, "AGENTS.md"), `Original profile ${index}`);
    await writeFile(join(source, "MEMORY.md"), `Source memory ${index}`);
    await writeFile(join(source, "skills/example/SKILL.md"), `Method ${index}`);
    const backup = await createMigrationBackup(await inspectMigrationWorkspace(source), join(root, "backups"));
    sources.push({
      sourceIdentity: `source-${index}`, source: "", name: `Example ${index}`, backup, color: "purple",
      identity: `Original database instructions ${index}`, description: `Description ${index}`,
      profile: { personality: `Retained personality ${index}` },
    });
  }
  const path = await prepareMigrationBundle(join(root, "export"), sources);
  const store = new WorkbenchStore(":memory:");
  const migrations = new Migrations({ store, workspaces: new Workspaces(join(root, "managed")),
    backupRoot: join(root, "import-backups"), registration: { async ensure() {} } });
  try {
    const previews = await migrations.previewBundle(path);
    assert.equal(previews.length, 8);
    assert.equal(store.snapshot().bots.length, 0);
    assert.deepEqual((await migrations.previewBundle(path)).map((item) => item.id), previews.map((item) => item.id));
    for (const [index, preview] of previews.entries()) {
      const result = await migrations.apply(preview.id);
      const bot = store.snapshot().bots.find((item) => item.id === result.botId)!;
      assert.equal(bot.identity, sources[index].identity);
      assert.equal(bot.description, sources[index].description);
      assert.equal(bot.color, "purple");
      assert.ok((await readFile(join(result.workspace!, "AGENTS.md"), "utf8")).includes(sources[index].identity));
      const profile = JSON.parse(await readFile(join(result.workspace!, "profile/livingbot-migration-source.json"), "utf8"));
      assert.equal(profile.original.personality, `Retained personality ${index}`);
      assert.equal(await readFile(join(result.workspace!, "MEMORY.md"), "utf8"), `Source memory ${index}`);
      assert.equal(await readFile(join(result.workspace!, "skills/example/SKILL.md"), "utf8"), `Method ${index}`);
      assert.equal(await readFile(join(root, `source-${index}/AGENTS.md`), "utf8"), `Original profile ${index}`);
    }
    await migrations.previewBundle(path);
    assert.equal(store.snapshot().bots.length, 8);
    assert.equal(migrations.list().length, 8);
  } finally { store.close(); }
});

test("batch preview rejects escaping sources and duplicate identities without creating Bots", async () => {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp(resolve("local/test-fixtures/migration-bundle-boundary-"));
  const store = new WorkbenchStore(":memory:");
  const migrations = new Migrations({ store, workspaces: new Workspaces(join(root, "managed")),
    backupRoot: join(root, "backups"), registration: { async ensure() {} } });
  try {
    const path = join(root, "livingbot-migration.json");
    const bot = { sourceIdentity: "example", source: "../outside", name: "Example" };
    await writeFile(path, JSON.stringify({ format: "livingbot-migration-v1", bots: [bot] }));
    await assert.rejects(migrations.previewBundle(path), /无效/);
    await mkdir(join(root, "workspace"));
    await writeFile(path, JSON.stringify({ format: "livingbot-migration-v1", bots: [{ ...bot, source: "workspace" }, { ...bot, source: "workspace" }] }));
    await assert.rejects(migrations.previewBundle(path), /无效/);
    assert.equal(store.snapshot().bots.length, 0);
    assert.equal(migrations.list().length, 0);
  } finally { store.close(); }
});

test("portable packages retain the original exclusion list and require its acknowledgment", async () => {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp(resolve("local/test-fixtures/migration-bundle-exclusions-"));
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "MEMORY.md"), "Retained memory");
  await writeFile(join(source, "old-project.txt"), "Original project is retained separately");
  const backup = await createMigrationBackup(await inspectMigrationWorkspace(source), join(root, "backups"));
  const path = await prepareMigrationBundle(join(root, "export"), [{
    sourceIdentity: "example", name: "Example", backup,
  }]);
  const store = new WorkbenchStore(":memory:");
  const migrations = new Migrations({ store, workspaces: new Workspaces(join(root, "managed")),
    backupRoot: join(root, "import-backups"), registration: { async ensure() {} } });
  try {
    const [preview] = await migrations.previewBundle(path);
    assert.equal(preview.sourceExclusions?.[0].path, "old-project.txt");
    assert.throws(() => migrations.apply(preview.id), /excluded/);
    assert.equal((await migrations.apply(preview.id, true)).state, "ready");
    assert.equal(await readFile(join(source, "old-project.txt"), "utf8"), "Original project is retained separately");
  } finally { store.close(); }
});

test("shared memory stays with its original audience and selected skills keep their references and scripts", async () => {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp(resolve("local/test-fixtures/migration-supplements-"));
  const groups = [];
  for (let index = 0; index < 2; index++) {
    const source = join(root, `group-${index}`);
    await mkdir(source);
    await writeFile(join(source, "MEMORY.md"), `Shared group ${index}`);
    groups.push(await createMigrationBackup(await inspectMigrationWorkspace(source), join(root, "backups")));
  }
  const skill = join(root, "shared-skill");
  await mkdir(join(skill, "references"), { recursive: true });
  await mkdir(join(skill, "scripts"));
  await writeFile(join(skill, "SKILL.md"), "Shared method");
  await writeFile(join(skill, "references", "steps.md"), "Original instructions");
  await writeFile(join(skill, "scripts", "run.mjs"), "console.log('Synthetic method');");
  const skillBackup = await createMigrationBackup(await inspectMigrationSkill(skill), join(root, "backups"));
  const sources = [];
  for (let index = 0; index < 2; index++) {
    const source = join(root, `private-${index}`);
    await mkdir(source);
    await writeFile(join(source, "MEMORY.md"), `Private ${index}`);
    sources.push({
      sourceIdentity: `example-${index}`, name: `Example ${index}`,
      backup: await createMigrationBackup(await inspectMigrationWorkspace(source), join(root, "backups")),
      supplements: [{ backup: groups[index], directory: "memory/imported-shared" },
        { backup: skillBackup, directory: "skills/shared-method" }],
    });
  }
  const path = await prepareMigrationBundle(join(root, "export"), sources);
  const store = new WorkbenchStore(":memory:");
  const migrations = new Migrations({ store, workspaces: new Workspaces(join(root, "managed")),
    backupRoot: join(root, "import-backups"), registration: { async ensure() {} } });
  try {
    for (const [index, preview] of (await migrations.previewBundle(path)).entries()) {
      const result = await migrations.apply(preview.id);
      assert.equal(await readFile(join(result.workspace!, "MEMORY.md"), "utf8"), `Private ${index}`);
      assert.equal(await readFile(join(result.workspace!, "memory/imported-shared/MEMORY.md"), "utf8"), `Shared group ${index}`);
      for (const file of ["SKILL.md", "references/steps.md", "scripts/run.mjs"]) {
        assert.equal(await readFile(join(result.workspace!, "skills/shared-method", file), "utf8"),
          await readFile(join(skill, file), "utf8"));
      }
    }
    await assert.rejects(prepareMigrationBundle(join(root, "invalid"), [{
      ...sources[0], supplements: [{ backup: groups[1], directory: ".." }],
    }]), /relative directory/);
    const collision = join(root, "collision");
    await mkdir(join(collision, "memory/imported-shared"), { recursive: true });
    await writeFile(join(collision, "memory/imported-shared/MEMORY.md"), "Existing private source");
    await assert.rejects(prepareMigrationBundle(join(root, "conflict"), [{
      ...sources[0], backup: await createMigrationBackup(await inspectMigrationWorkspace(collision), join(root, "backups")),
    }]), /Conflicting migration sources/);
    assert.equal(await readFile(join(collision, "memory/imported-shared/MEMORY.md"), "utf8"), "Existing private source");
  } finally { store.close(); }
});
