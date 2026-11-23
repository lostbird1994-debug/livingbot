import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchWorkbench } from "./main.ts";
import { prepareMigrationBundle } from "../../../packages/workbench/src/migration-bundle.ts";
import type { MigrationBundleSource } from "../../../packages/workbench/src/migration-bundle.ts";
import { createMigrationBackup, verifyMigrationBackup } from "../../../packages/workbench/src/migration-backup.ts";
import { inspectMigrationSkill, inspectMigrationWorkspace } from "../../../packages/workbench/src/migration-inventory.ts";
import type { MigrationPreview } from "../../../packages/workbench/src/migration.ts";
import type { Bot, Task } from "../../../packages/workbench/src/contracts.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-migration-batch-"));
const sharedBackups: string[] = [];
for (let index = 0; index < 2; index++) {
  const source = join(root, `shared-${index}`);
  await mkdir(source);
  await writeFile(join(source, "MEMORY.md"), `# Shared source\n\nSHAREDAUDIENCE${index}4938 is the shared project reference.\n`);
  sharedBackups.push(await createMigrationBackup(await inspectMigrationWorkspace(source), join(root, "source-backups")));
}
const sharedSkill = join(root, "shared-method");
await mkdir(join(sharedSkill, "references"), { recursive: true });
await writeFile(join(sharedSkill, "SKILL.md"), "---\nname: shared-method\ndescription: Review shared synthetic evidence.\n---\n\nRead references/steps.md.\n");
await writeFile(join(sharedSkill, "references", "steps.md"), "Retain exact references.");
const sharedSkillBackup = await createMigrationBackup(await inspectMigrationSkill(sharedSkill), join(root, "source-backups"));
const sources: MigrationBundleSource[] = [];
for (let index = 0; index < 8; index++) {
  const source = join(root, `source-${index}`);
  await mkdir(join(source, "skills", "synthetic-evidence"), { recursive: true });
  await writeFile(join(source, "AGENTS.md"), `Original source identity ${index}\n`);
  await writeFile(join(source, "MEMORY.md"), `# Synthetic memory\n\nBATCHREF${index}7824 is the project reference.\n`);
  await writeFile(join(source, "skills", "synthetic-evidence", "SKILL.md"),
    "---\nname: synthetic-evidence\ndescription: Review synthetic evidence.\n---\n\nPreserve source references.\n");
  sources.push({
    sourceIdentity: `synthetic-${index}`, name: `Imported ${index}`, color: "purple",
    description: `Synthetic description ${index}`, identity: `Database persona ${index}`,
    backup: await createMigrationBackup(await inspectMigrationWorkspace(source), join(root, "source-backups")),
    supplements: [
      { backup: sharedBackups[index < 4 ? 0 : 1], directory: "memory/imported-shared" },
      { backup: sharedSkillBackup, directory: "skills/shared-method" },
    ],
  });
}
const bundle = await prepareMigrationBundle(join(root, "export"), sources);
const requests: { messages: { role: string; content: unknown }[] }[] = [];
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish_reason] of [[{ role: "assistant", content: "Synthetic batch response." }, null], [{}, "stop"]]) {
    response.write(`data: ${JSON.stringify({ id: randomUUID(), object: "chat.completion.chunk",
      created: 1, model: "synthetic", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
const evidence: { scenarios: string[]; importedBots: number; error?: string } = { scenarios: [], importedBots: 0 };
try {
  const options = {
    root: join(root, "application"), kernelEntry: resolve(values["kernel-entry"]), nodeExecutable: process.execPath,
    connection: { id: "synthetic", baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      api: "openai-completions" as const, apiKey: "synthetic", model: "synthetic", contextWindow: 32_000, maxTokens: 1000 },
  };
  app = await launchWorkbench(options);
  const token = JSON.parse(await readFile(app.authPath, "utf8")).token;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const endpoint = `${app.url}/api/migrations/bundle-preview`;
  assert.equal((await fetch(endpoint, { method: "POST", body: JSON.stringify({ path: bundle }) })).status, 401);
  const initialBots = app.store.snapshot().bots.length;
  const preview = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ path: bundle }) });
  assert.equal(preview.status, 201);
  const plans: MigrationPreview[] = (await preview.json()).migrations;
  assert.equal(plans.length, 8);
  assert.equal(app.store.snapshot().bots.length, initialBots);
  evidence.scenarios.push("authenticated-eight-bot-preview-does-not-activate-agents");
  const imported: MigrationPreview[] = [];
  for (const [index, plan] of plans.entries()) {
    const response: Response = await fetch(`${app.url}/api/migrations/${plan.id}/apply`, { method: "POST", headers, body: "{}" });
    const result: MigrationPreview = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.state, "ready");
    await verifyMigrationBackup(result.backup!);
    const bot: Bot = app.store.snapshot().bots.find((item) => item.id === result.botId)!;
    assert.equal(bot.identity, sources[index].identity);
    assert.equal(bot.color, sources[index].color);
    assert.equal(bot.description, sources[index].description);
    const query = `BATCHREF${index}7824`;
    const memory = await app.service.memories!.search(bot.id, { query });
    assert.ok(memory.hits.some((hit) => hit.excerpt.includes(query)));
    const audience = index < 4 ? 0 : 1;
    const sharedQuery = `SHAREDAUDIENCE${audience}4938`;
    assert.ok((await app.service.memories!.search(bot.id, { query: sharedQuery })).hits.some((hit) => hit.excerpt.includes(sharedQuery)));
    const excludedQuery = `SHAREDAUDIENCE${1 - audience}4938`;
    assert.ok(!(await app.service.memories!.search(bot.id, { query: excludedQuery })).hits.some((hit) => hit.excerpt.includes(excludedQuery)));
    const skills = await app.kernel.request<{ skills: { name: string; eligible: boolean }[] }>("skills.status", { agentId: result.agentId });
    assert.ok(skills.skills.some((skill) => skill.name === "synthetic-evidence" && skill.eligible));
    assert.ok(skills.skills.some((skill) => skill.name === "shared-method" && skill.eligible));
    const before = requests.length;
    const task = await app.service.submit({
      submissionId: randomUUID(), conversationId: app.store.privateConversation(bot.id).id,
      botId: bot.id, message: "Hello imported Bot",
    });
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => { app!.store.off("event", changed); reject(new Error("Native turn deadline exceeded")); }, 45_000);
      function changed() {
        const current = app!.store.get<Task>("tasks", task.id)!;
        if (!["completed", "failed", "cancelled"].includes(current.status)) return;
        clearTimeout(timer); app!.store.off("event", changed);
        if (current.status === "completed") done(); else reject(new Error(`Native turn ${current.status}`));
      }
      app!.store.on("event", changed); changed();
    });
    // Check exact fixture bytes in the native prompt, not generated prose quality.
    assert.ok(requests.slice(before).some((request) => request.messages.some((message) =>
      message.role === "system" && JSON.stringify(message.content).includes(sources[index].identity!))));
    assert.equal(await readFile(join(root, `source-${index}`, "AGENTS.md"), "utf8"), `Original source identity ${index}\n`);
    imported.push(result);
    evidence.importedBots++;
  }
  evidence.scenarios.push("all-eight-imports-retain-persona-color-native-memory-eligible-skill-and-execute-native-turn");
  evidence.scenarios.push("shared-memory-retains-original-two-audience-boundaries-and-shared-methods-load-natively");
  const repeated = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ path: bundle }) });
  assert.deepEqual((await repeated.json()).migrations.map((item: MigrationPreview) => item.id), plans.map((item) => item.id));
  for (const result of imported) assert.equal((await app.migrations.apply(result.id)).botId, result.botId);
  assert.equal(app.store.snapshot().bots.length, initialBots + 8);
  evidence.scenarios.push("repeated-batch-preview-and-import-do-not-duplicate-bots");
  await app.close(); app = undefined;
  app = await launchWorkbench(options);
  assert.equal(app.store.snapshot().bots.length, initialBots + 8);
  assert.equal(app.migrations.list().filter((plan) => plan.state === "ready").length, 8);
  for (const [index, result] of imported.entries()) {
    assert.ok((await app.service.memories!.search(result.botId, { query: `BATCHREF${index}7824` })).hits.length);
  }
  evidence.scenarios.push("full-product-and-kernel-restart-retain-eight-imports-and-searchable-memories");
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await app?.close();
  await new Promise<void>((done) => model.close(() => done()));
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ root, ...evidence }, null, 2));
}
