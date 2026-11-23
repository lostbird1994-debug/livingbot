import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchWorkbench } from "./main.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import type { Message, Task } from "../../../packages/workbench/src/contracts.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" }, serve: { type: "boolean" }, batch: { type: "boolean" }, "file-batch": { type: "boolean" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-widgets-"));
const application = join(root, "application");
await mkdir(application);
const seed = new WorkbenchStore(join(application, "workbench.sqlite"));
const bot = seed.createBot({ name: "Atlas", agentId: "atlas" });
seed.createBot({ name: "Moss", agentId: "moss" });
const conversation = seed.privateConversation(bot.id);
seed.close();
const requests: unknown[] = [];
let failedBatchB = false;
const source = `<div class="card"><h2>交互计数</h2><button id="increment">增加</button><output id="count">0</output>
<button id="ask">继续解释</button><button id="ask-again">进一步说明</button></div>
<svg viewBox="0 0 200 40" aria-label="示例图"><rect width="100" height="20" fill="currentColor"/></svg>
<script>let count=0;document.getElementById("increment").onclick=()=>document.getElementById("count").textContent=String(++count);
document.getElementById("ask").onclick=()=>void openclaw.prompt.send("请继续解释这张交互图。");
document.getElementById("ask-again").onclick=()=>sendPrompt("请进一步说明这张交互图。");
void openclaw.prompt.send("自动运行不得发送这条消息。");</script>`;
const model = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(input);
    const hasBatchB = JSON.stringify(input.messages).includes("batch-b.txt");
    if (values["file-batch"] && hasBatchB && !failedBatchB) {
      failedBatchB = true;
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Synthetic one-time batch failure", type: "invalid_request_error" } }));
      return;
    }
    if (values.batch || values["file-batch"]) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [part, finish] of [[{ role: "assistant", content: "已单独整理本文件并生成结果。" }, null], [{}, "stop"]]) {
        response.write(`data: ${JSON.stringify({
          id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic-batch",
          choices: [{ index: 0, delta: part, finish_reason: finish }],
        })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
      return;
    }
    const returned = input.messages.some((message: { role: string }) => message.role === "tool");
    const delta = returned ? { role: "assistant", content: "交互预览已生成。" } : {
      role: "assistant", tool_calls: [{
        index: 0, id: randomUUID(), type: "function", function: {
          name: "dispatch_action", arguments: JSON.stringify({
            id: "show_widget", args: { title: "交互计数", widget_code: source },
          }),
        },
      }],
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [part, finish] of [[delta, null], [{}, returned ? "stop" : "tool_calls"]]) {
      response.write(`data: ${JSON.stringify({
        id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
        choices: [{ index: 0, delta: part, finish_reason: finish }],
      })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
const scenarios: string[] = [];
let failure: string | undefined;
async function launch() {
  return launchWorkbench({
    root: application, nodeExecutable: process.execPath, kernelEntry: resolve(values["kernel-entry"]!),
    ...(values.serve ? { webRoot: resolve("apps/workbench-web/dist") } : {}),
    connection: {
      id: "synthetic", api: "openai-completions", apiKey: "synthetic",
      baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      model: "synthetic", contextWindow: 64_000, maxTokens: 1000,
    },
  });
}
try {
  app = await launch();
  if (values["file-batch"]) {
    const files = app.service.files!;
    const attachments = await Promise.all(["batch-a.txt", "batch-b.txt"].map((name, index) => files.attach({
      id: randomUUID(), botId: bot.id, conversationId: conversation.id, name, mediaType: "text/plain",
      bytes: Buffer.from(`Synthetic batch source ${index + 1}`),
    })));
    const receipt = await app.service.submitFileBatch({
      id: randomUUID(), botId: bot.id, conversationId: conversation.id,
      instruction: "Summarize this file independently", attachmentIds: attachments.map((file) => file.id),
    });
    assert.equal(receipt.outcomes.length, 2);
    assert.equal(receipt.outcomes.filter((outcome) => outcome.accepted).length, 1, JSON.stringify(receipt.outcomes));
    const taskIds = receipt.outcomes.map((outcome) => outcome.task.id);
    await new Promise<void>((done, reject) => {
      const store = app!.store;
      const timer = setTimeout(() => { store.off("event", changed); reject(new Error("File batch failure scenario deadline exceeded")); }, 90_000);
      function changed() {
        const tasks = taskIds.map((id) => store.get<Task>("tasks", id));
        if (tasks[0]?.status !== "completed" || tasks[1]?.status !== "failed") return;
        clearTimeout(timer); store.off("event", changed);
        done();
      }
      store.on("event", changed); changed();
    });
    const retry = await app.service.retryFileBatch(receipt.batch.id, "native-file-batch-retry-stable");
    assert.equal(retry.outcomes.length, 1);
    assert.equal(retry.outcomes[0].task.id, taskIds[1]);
    assert.ok(retry.outcomes[0].accepted, JSON.stringify(retry.outcomes[0]));
    await new Promise<void>((done, reject) => {
      const store = app!.store;
      const timer = setTimeout(() => { store.off("event", changed); reject(new Error("File batch retry deadline exceeded")); }, 90_000);
      function changed() {
        const tasks = taskIds.map((id) => store.get<Task>("tasks", id));
        if (tasks.some((task) => task?.status !== "completed")) return;
        clearTimeout(timer); store.off("event", changed); done();
      }
      store.on("event", changed); changed();
    });
    const userInputs = app.store.messages(conversation.id).filter((message) =>
      message.role === "user" && taskIds.includes(message.taskId ?? ""));
    const inputsFor = (taskId: string) => userInputs.filter((message) => message.taskId === taskId);
    // Each item owns its submitted input; only the retried item gains a continuation.
    assert.equal(userInputs.length, 3);
    assert.equal(new Set(userInputs.map((message) => message.taskId)).size, 2);
    assert.equal(inputsFor(taskIds[0]).length, 1);
    assert.equal(inputsFor(taskIds[1]).length, 2);
    const replies = app.store.messages(conversation.id).filter((message) =>
      message.role === "assistant" && taskIds.includes(message.taskId ?? ""));
    const completed = replies.filter((message) => message.taskId === taskIds[0]);
    // The successful item keeps exactly one final result and is never replayed.
    assert.equal(completed.length, 1);
    assert.ok(completed[0].blocks.every((block) => block.kind === "text"), JSON.stringify(completed[0].blocks));
    const resumed = replies.filter((message) => message.taskId === taskIds[1]);
    assert.equal(resumed.length, 2);
    assert.match(JSON.stringify(resumed[0].blocks), /工作未完成/);
    assert.match(JSON.stringify(resumed[1].blocks), /已单独整理本文件并生成结果/);
    const batchARequest = requests.findIndex((entry) => JSON.stringify(entry).includes("batch-a.txt"));
    const batchBRequest = requests.findIndex((entry) => JSON.stringify(entry).includes("batch-b.txt"));
    assert.ok(batchARequest >= 0 && batchBRequest > batchARequest);
    assert.equal(failedBatchB, true);
    scenarios.push("official-kernel-orders-file-turns-and-resumes-only-the-failed-item-to-two-finals");
    console.log({ root, taskIds, scenarios });
  } else if (values.batch) {
    console.log(JSON.stringify({ root, url: app.url, authenticationFile: app.authPath }));
    await new Promise<void>((done) => { process.once("SIGINT", done); process.once("SIGTERM", done); });
  } else {
  const task = await app.service.submit({
    submissionId: randomUUID(), botId: bot.id, conversationId: conversation.id,
    message: "调用 show_widget 展示一个可点击增加的计数器。",
  });
  await new Promise<void>((done, reject) => {
    const store = app!.store;
    const timer = setTimeout(() => { store.off("event", changed); reject(new Error("Widget task deadline exceeded")); }, 60_000);
    function changed() {
      const state = store.get<Task>("tasks", task.id)?.status;
      if (state !== "completed" && state !== "failed") return;
      clearTimeout(timer); store.off("event", changed);
      if (state === "completed") done(); else reject(new Error("Widget task failed"));
    }
    store.on("event", changed); changed();
  });
  const message = app.store.messages(conversation.id).find((item) => item.taskId === task.id && item.role === "assistant")!;
  const widget = message.blocks.find((block) => block.kind === "widget");
  assert.ok(widget?.kind === "widget", JSON.stringify(message));
  assert.ok(JSON.stringify(requests[0]).includes("show_widget"));
  scenarios.push("native-show-widget-available-and-projected-from-actual-final");
  const document = await app.kernel.request<{ html: string }>("canvas.document.view", {
    docId: widget.docId, sessionKey: widget.sessionKey,
  });
  assert.ok(document.html.includes('id="increment"'));
  assert.ok(document.html.includes("Content-Security-Policy"));
  scenarios.push("official-document-view-returns-wrapped-interactive-html");
  const calls = requests.length;
  await app.close();
  app = await launch();
  const restored = app.store.get<Message>("messages", message.id)!;
  assert.deepEqual(restored.blocks.filter((block) => block.kind === "widget"), [widget]);
  const reopened = await app.kernel.request<{ html: string }>("canvas.document.view", {
    docId: widget.docId, sessionKey: widget.sessionKey,
  });
  assert.equal(reopened.html, document.html);
  assert.equal(requests.length, calls);
  scenarios.push("full-restart-retains-native-reference-and-exact-html-without-model-reexecution");
  const auth = JSON.parse(await readFile(app.authPath, "utf8"));
  const path = `${app.url}/api/messages/${encodeURIComponent(message.id)}/widgets/${encodeURIComponent(widget.id)}`;
  assert.equal((await fetch(path)).status, 401);
  const response = await fetch(path, { headers: { authorization: `Bearer ${auth.token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { html: document.html });
  assert.equal((await fetch(path.replace(encodeURIComponent(widget.id), "widget%3Acv_foreign"), {
    headers: { authorization: `Bearer ${auth.token}` },
  })).status, 404);
  scenarios.push("authenticated-product-read-after-restart-preserves-html-and-rejects-unowned-document");
  if (values.serve) {
    console.log(JSON.stringify({ root, url: app.url, authenticationFile: app.authPath, scenarios }));
    await new Promise<void>((done) => {
      process.once("SIGINT", done); process.once("SIGTERM", done);
    });
  }
  }
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
