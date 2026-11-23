import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchWorkbench } from "./main.ts";
import type { Task } from "../../../packages/workbench/src/contracts.ts";
import type { ModelSettings } from "../../../packages/kernel-runtime/src/model-settings.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/model-settings-"));
const model = createServer(async (request, response) => {
  for await (const _ of request) { /* Synthetic model only. */ }
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish_reason] of [[{ role: "assistant", content: "Synthetic model configured." }, null], [{}, "stop"]]) {
    response.write(`data: ${JSON.stringify({ id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
const evidence: { scenarios: string[]; error?: string } = { scenarios: [] };
async function request<T>(path: string, input?: unknown): Promise<T> {
  const { token } = JSON.parse(await readFile(app!.authPath, "utf8"));
  const result = await fetch(`${app!.url}${path}`, {
    method: input ? "POST" : "GET", headers: { authorization: `Bearer ${token}`,
      ...(input ? { "content-type": "application/json" } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  const value = await result.json();
  assert.equal(result.status, 200, JSON.stringify(value));
  return value as T;
}
try {
  const options = { root: join(root, "application"), nodeExecutable: process.execPath, kernelEntry: resolve(values["kernel-entry"]) };
  app = await launchWorkbench(options);
  assert.equal((await request<ModelSettings>("/api/model-settings")).configured, false);
  evidence.scenarios.push("Fresh application exposes unconfigured model without reading old credentials");
  const saved = await request<ModelSettings>("/api/model-settings", {
    id: "local", model: "synthetic", api: "openai-completions", apiKey: "synthetic-private-key",
    baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
  });
  assert.equal(saved.configured, true);
  const summary = await request<ModelSettings>("/api/model-settings");
  assert.equal(summary.model, "synthetic");
  assert.ok(!JSON.stringify(summary).includes("synthetic-private-key"));
  evidence.scenarios.push("Native configuration save works through authenticated API without credential echo");
  const bot = app.store.snapshot().bots[0];
  const conversation = app.store.privateConversation(bot.id);
  const task = await app.service.submit({ submissionId: randomUUID(), botId: bot.id,
    conversationId: conversation.id, message: "Verify the configured model." });
  await new Promise<void>((done, reject) => {
    const store = app!.store;
    const timer = setTimeout(() => { store.off("event", changed); reject(new Error("Synthetic model timeout")); }, 45000);
    function changed() {
      const current = store.get<Task>("tasks", task.id)!;
      if (!["completed", "failed", "cancelled"].includes(current.status)) return;
      clearTimeout(timer); store.off("event", changed);
      if (current.status !== "completed") reject(new Error(`Task ${current.status}`)); else done();
    }
    store.on("event", changed); changed();
  });
  evidence.scenarios.push("A real native kernel turn completes using the newly saved synthetic model");
  await app.close(); app = undefined;
  app = await launchWorkbench(options);
  assert.equal((await request<ModelSettings>("/api/model-settings")).model, "synthetic");
  assert.equal(app.store.get<Task>("tasks", task.id)?.status, "completed");
  evidence.scenarios.push("Restart retains model configuration and completed turn");
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await app?.close();
  await new Promise<void>((done) => model.close(() => done()));
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ root, ...evidence }));
}
