import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchWorkbench } from "./main.ts";
import { verifyMigrationBackup } from "../../../packages/workbench/src/migration-backup.ts";
import type { Task } from "../../../packages/workbench/src/contracts.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-migration-"));
const source = join(root, "previous-workspace");
await mkdir(join(source, "skills", "synthetic-evidence"), { recursive: true });
await mkdir(join(source, ".rakazo", "memory-archive"), { recursive: true });
await mkdir(join(source, "memory"));
const original = "# Synthetic original identity\n\nKeep source-grounded project notes.\n";
const modelRequests: { messages: { role: string; content: unknown }[] }[] = [];
await writeFile(join(source, "AGENTS.md"), original, { flag: "wx", mode: 0o600 });
await writeFile(join(source, "MEMORY.md"), "# 合成迁移项目\n\n霜叶计划的交付代号是 MIGRATION-7824。\n", { flag: "wx", mode: 0o600 });
await writeFile(join(source, ".rakazo", "memory-archive", "past.md"), "# 旧归档\n\n石桥项目的归档代号是 ARCHIVE-3482。\n", { flag: "wx", mode: 0o600 });
await writeFile(join(source, "memory", "facts.json"), '{"project":"银杉项目","reference":"STRUCTURED-6752"}\n', { flag: "wx", mode: 0o600 });
await writeFile(join(source, "skills", "synthetic-evidence", "SKILL.md"),
  "---\nname: synthetic-evidence\ndescription: Use this method to review synthetic evidence.\n---\n\nPreserve source references.\n",
  { flag: "wx", mode: 0o600 });
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  modelRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish] of [[{ role: "assistant", content: "Synthetic imported Bot response." }, null], [{}, "stop"]]) {
    response.write(`data: ${JSON.stringify({
      id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
const evidence: { scenarios: string[]; error?: string } = { scenarios: [] };
try {
  app = await launchWorkbench({
    root: join(root, "application"), kernelEntry: resolve(values["kernel-entry"]), nodeExecutable: process.execPath,
    connection: {
      id: "synthetic", baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      api: "openai-completions", apiKey: "synthetic", model: "synthetic", contextWindow: 32_000, maxTokens: 1000,
    },
  });
  const token = JSON.parse(await readFile(app.authPath, "utf8")).token;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const response = await fetch(`${app.url}/api/migrations/preview`, {
    method: "POST", headers, body: JSON.stringify({ source, name: "Imported Atlas" }),
  });
  assert.equal(response.status, 201);
  const plan = await response.json();
  assert.equal(app.store.snapshot().bots.length, 1);
  assert.equal(await readFile(join(source, "AGENTS.md"), "utf8"), original);
  evidence.scenarios.push("authenticated-preview-keeps-native-and-product-rosters-unchanged");
  const applied = await fetch(`${app.url}/api/migrations/${plan.id}/apply`, {
    method: "POST", headers, body: "{}",
  });
  const result = await applied.json();
  assert.equal(applied.status, 200, JSON.stringify(result));
  assert.equal(result.state, "ready");
  assert.equal(app.store.snapshot().bots.length, 2);
  await verifyMigrationBackup(result.backup);
  const agents = await app.kernel.request<{ agents: { id: string }[] }>("agents.list", {});
  assert.ok(agents.agents.some((agent) => agent.id === result.agentId));
  const memory = await app.service.memories!.search(result.botId, { query: "霜叶计划" });
  assert.ok(memory.hits.some((hit) => hit.excerpt.includes("MIGRATION-7824")));
  for (const query of ["ARCHIVE-3482", "STRUCTURED-6752"]) {
    assert.ok((await app.service.memories!.search(result.botId, { query })).hits.some((hit) => hit.excerpt.includes(query)));
  }
  const skills = await app.kernel.request<{ skills: { name: string; eligible: boolean }[] }>("skills.status", { agentId: result.agentId });
  assert.ok(skills.skills.some((skill) => skill.name === "synthetic-evidence" && skill.eligible));
  evidence.scenarios.push("native-registration-loads-imported-identity-memory-and-workspace-skill");
  evidence.scenarios.push("legacy-archive-and-structured-memory-projections-are-native-searchable");
  const conversation = app.store.privateConversation(result.botId);
  const task = await app.service.submit({
    submissionId: randomUUID(), conversationId: conversation.id, botId: result.botId, message: "Hello imported Bot",
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { app!.store.off("event", changed); reject(new Error("Imported turn deadline exceeded")); }, 45_000);
    function changed() {
      const current = app!.store.get<Task>("tasks", task.id)!;
      if (!["completed", "failed", "cancelled"].includes(current.status)) return;
      clearTimeout(timer); app!.store.off("event", changed);
      if (current.status === "completed") resolve(); else reject(new Error(`Imported turn ${current.status}`));
    }
    app!.store.on("event", changed); changed();
  });
  const repeated = await app.migrations.apply(plan.id);
  assert.ok(modelRequests.some((request) => request.messages.some((message) =>
    message.role === "system" && JSON.stringify(message.content).includes("Keep source-grounded project notes.") &&
    JSON.stringify(message.content).includes("Never permanently delete"))));
  assert.equal(repeated.botId, result.botId);
  assert.equal(app.store.snapshot().bots.length, 2);
  assert.equal(await readFile(join(source, "AGENTS.md"), "utf8"), original);
  evidence.scenarios.push("imported-bot-executes-native-turn-and-retries-do-not-duplicate-bots");
  await app.kernel.restart();
  assert.ok((await app.service.memories!.search(result.botId, { query: "霜叶计划" })).hits.length);
  evidence.scenarios.push("imported-native-agent-memory-survives-restart-with-original-source-retained");
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await app?.close();
  await new Promise<void>((resolve) => model.close(() => resolve()));
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ root, ...evidence }, null, 2));
}
