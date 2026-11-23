import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchWorkbench } from "./main.ts";
import { OpenClawCapabilities } from "../../../packages/kernel-runtime/src/capabilities.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import type { Artifact, Task } from "../../../packages/workbench/src/contracts.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-work-methods-"));
const application = join(root, "application");
await mkdir(application);
const seed = new WorkbenchStore(join(application, "workbench.sqlite"));
const bots = ["Atlas", "Moss"].map((name) => seed.createBot({ name, agentId: name.toLowerCase() }));
seed.close();
const methods = ["livingbot-text-revisions", "livingbot-batch-work"];
const original = "# 合成文档\n\n保留的开头。\n\n## 选定段落\n\n原始内容。\n\n## 保留章节\n\n原样保留。\n";
const edited = original.replace("原始内容。", "修改后的内容。");
const requests: unknown[] = [];
let methodPath = "";
const model = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(input);
    const messages = input.messages as { role: string; content: unknown }[];
    const returned = messages.filter((message) => message.role === "tool").length;
    const steps = [
      { name: "read", args: { path: methodPath } },
      { name: "read", args: { path: "inbox/original.md" } },
      { name: "write", args: { path: "tasks/document-review/revised.md", content: original } },
      { name: "edit", args: {
        path: "tasks/document-review/revised.md", oldText: "原始内容。", newText: "修改后的内容。",
      } },
      { name: "dispatch_action", args: { id: "livingbot_deliver_file", args: {
        relativePath: "tasks/document-review/revised.md", mediaType: "text/markdown",
      } } },
    ];
    const call = steps[returned];
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = call ? { role: "assistant", tool_calls: [{
      index: 0, id: randomUUID(), type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }] } : { role: "assistant", content: "已修改选定段落，保留原件及其他章节，并交付修订稿。" };
    for (const [part, finish] of [[delta, null], [{}, call ? "tool_calls" : "stop"]]) {
      response.write(`data: ${JSON.stringify({
        id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
        choices: [{ index: 0, delta: part, finish_reason: finish }],
      })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
const scenarios: string[] = [];
let failure: string | undefined;
async function launch() {
  return launchWorkbench({
    root: application, nodeExecutable: process.execPath, kernelEntry: resolve(values["kernel-entry"]!),
    connection: {
      id: "synthetic", api: "openai-completions", apiKey: "synthetic",
      baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      model: "synthetic", contextWindow: 64_000, maxTokens: 1000,
    },
  });
}
async function inventory(index: number) {
  const bot = bots[index];
  const chat = app!.store.privateConversation(bot.id);
  return new OpenClawCapabilities(app!.kernel).read(bot.agentId, app!.store.engineSessionKey(chat.id, bot.id));
}
try {
  app = await launch();
  const native = await app.kernel.request<{ skills: { name: string; filePath: string; source: string; eligible: boolean }[] }>(
    "skills.status", { agentId: bots[0].agentId, refresh: true });
  for (const name of methods) {
    const entry = native.skills.find((skill) => skill.name === name);
    assert.ok(entry?.eligible, `${name} must be discovered and eligible`);
    assert.ok(entry.filePath);
  }
  methodPath = native.skills.find((skill) => skill.name === methods[0])!.filePath;
  const initial = await inventory(0);
  for (const name of methods) assert.ok(initial.some((item) =>
    item.nativeName === name && item.nativeKind === "skill" && item.enabled && item.ready));
  assert.equal(initial.find((item) => item.nativeName === methods[0])?.name, "精确文本修订");
  scenarios.push("all-packaged-plugin-methods-are-native-eligible-and-have-readable-product-labels");
  const adapter = new OpenClawCapabilities(app.kernel);
  await adapter.setEnabled(bots[0].agentId, initial.find((item) => item.nativeName === methods[0])!, false);
  assert.equal((await inventory(0)).find((item) => item.nativeName === methods[0])?.enabled, false);
  assert.equal((await inventory(1)).find((item) => item.nativeName === methods[0])?.enabled, true);
  scenarios.push("disabling-one-bots-method-retains-the-other-bots-access");
  await app.close();
  app = await launch();
  assert.equal((await inventory(0)).find((item) => item.nativeName === methods[0])?.enabled, false);
  const disabled = (await inventory(0)).find((item) => item.nativeName === methods[0])!;
  await new OpenClawCapabilities(app.kernel).setEnabled(bots[0].agentId, disabled, true);
  assert.equal((await inventory(0)).find((item) => item.nativeName === methods[0])?.enabled, true);
  scenarios.push("native-method-permission-survives-full-restart-and-can-be-restored");
  await writeFile(join(app.paths.workspaces, bots[0].agentId, "inbox/original.md"), original, { flag: "wx", mode: 0o600 });
  const task = await app.service.submit({
    submissionId: randomUUID(), botId: bots[0].id, conversationId: app.store.privateConversation(bots[0].id).id,
    message: "使用文档处理方法修改 inbox/original.md 的选定段落，保留原件和其他章节并交付修订稿。",
  });
  await new Promise<void>((done, reject) => {
    const store = app!.store;
    const timer = setTimeout(() => { store.off("event", changed); reject(new Error("Document task deadline exceeded")); }, 60_000);
    function changed() {
      const state = store.get<Task>("tasks", task.id)?.status;
      if (state !== "completed" && state !== "failed") return;
      clearTimeout(timer); store.off("event", changed);
      if (state === "completed") done(); else reject(new Error("Document task failed"));
    }
    store.on("event", changed); changed();
  });
  const artifacts = app.store.find<Artifact>("artifacts", "taskId", task.id);
  assert.equal(artifacts.length, 1);
  assert.equal((await app.service.files!.read(artifacts[0].id)).bytes.toString(), edited);
  assert.equal(await readFile(join(app.paths.workspaces, bots[0].agentId, "inbox/original.md"), "utf8"), original);
  assert.ok(JSON.stringify(requests[0]).includes("livingbot-text-revisions"));
  // Protocol assertion: native read must return the actual packaged skill bytes.
  const skillText = await readFile(methodPath, "utf8");
  const second = requests[1] as { messages: { role: string; content: unknown }[] };
  assert.ok(second.messages.some((message) => message.role === "tool" &&
    JSON.stringify(message.content).includes(skillText.split("\n").find((line) => line.startsWith("description:"))!.slice(13))));
  scenarios.push("native-model-reads-packaged-method-uses-file-tools-and-delivers-exact-revision-with-original-intact");
  const calls = requests.length;
  await app.close();
  app = await launch();
  assert.equal(app.store.get<Task>("tasks", task.id)?.status, "completed");
  assert.equal((await app.service.files!.read(artifacts[0].id)).bytes.toString(), edited);
  assert.equal(requests.length, calls);
  scenarios.push("native-method-and-real-delivery-retain-after-restart-without-model-reexecution");
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  model.closeAllConnections();
  await new Promise<void>((done) => model.close(() => done()));
  await writeFile(join(root, "evidence.json"), JSON.stringify({ scenarios, failure, requests }, null, 2), { mode: 0o600, flag: "wx" });
  console.log({ root, scenarios, failure });
}
