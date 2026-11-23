import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { freeLoopbackPort, launchWorkbench } from "./main.ts";
import { buildKernelConfig, newGatewayToken, writeKernelConfig } from "../../../packages/kernel-runtime/src/config.ts";
import { preparePaths, runtimePaths } from "../../../packages/kernel-runtime/src/paths.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import type { SubmissionRecord, Task } from "../../../packages/workbench/src/contracts.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-steering-"));
process.env.OPENCLAW_STATE_DIR = join(root, "sdk-client");
const paths = runtimePaths(join(root, "application"));
await preparePaths(paths);
const seed = new WorkbenchStore(join(paths.root, "workbench.sqlite"));
const bot = seed.createBot({ name: "Atlas", agentId: "atlas" });
seed.close();
const initial = "SYNTHETIC-STEERING-ORIGINAL";
const addition = "SYNTHETIC-STEERING-ADDITION";
let modelEntered!: () => void;
const entered = new Promise<void>((done) => { modelEntered = done; });
let held: ServerResponse | undefined;
let continued: ServerResponse | undefined;
let continuationEntered!: () => void;
const continuation = new Promise<void>((done) => { continuationEntered = done; });
const requests: unknown[] = [];
function respond(response: ServerResponse, delta: unknown, finish = "stop") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [content, reason] of [[delta, null], [{}, finish]]) response.write(`data: ${JSON.stringify({
    id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
    choices: [{ index: 0, delta: content, finish_reason: reason }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  if (requests.length === 1) { held = response; modelEntered(); return; }
  if (requests.length === 2) {
    respond(response, { role: "assistant", content: "SYNTHETIC-ANSWER-WHILE-WORK-CONTINUES", tool_calls: [{
      index: 0, id: randomUUID(), type: "function", function: { name: "exec", arguments: JSON.stringify({ command: "printf synthetic-steering-continuation", host: "gateway" }) },
    }] }, "tool_calls");
    return;
  }
  if (requests.length === 3) { continued = response; continuationEntered(); return; }
  respond(response, { role: "assistant", content: "Synthetic final after input receipt." });
});
await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
const evidence: { scenarios: string[]; requests: unknown[]; frames: unknown[]; tasks?: Task[]; submissions?: SubmissionRecord[]; error?: string } = {
  scenarios: [], requests, frames: [],
};
function deadline<T>(promise: Promise<T>): Promise<T> {
  return new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Native steering deadline exceeded")), 35_000);
    promise.then((value) => { clearTimeout(timer); done(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
function until(id: string, predicate: (task: Task) => boolean): Promise<Task> {
  return new Promise((done, reject) => {
    const store = app!.store;
    const timer = setTimeout(() => { store.off("event", changed); reject(new Error("Native steering task deadline exceeded")); }, 35_000);
    function changed() {
      const task = app!.service.task(id);
      if (!predicate(task)) return;
      clearTimeout(timer); store.off("event", changed); done(task);
    }
    store.on("event", changed); changed();
  });
}
try {
  const config = buildKernelConfig(paths, await freeLoopbackPort(), newGatewayToken(), [{ id: bot.agentId }], {
    id: "synthetic", baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    api: "openai-completions", apiKey: "synthetic", model: "synthetic", contextWindow: 64_000, maxTokens: 1000,
  });
  config.tools = { exec: { mode: "full", notifyOnExit: false } };
  await writeKernelConfig(paths, config);
  app = await launchWorkbench({ root: paths.root, kernelEntry: resolve(values["kernel-entry"]), nodeExecutable: process.execPath, localEmbeddings: false });
  app.kernel.on("observation", (event) => evidence.frames.push(event));
  const conversationId = app.store.privateConversation(bot.id).id;
  const originalInput = { submissionId: randomUUID(), conversationId, botId: bot.id, message: initial };
  const original = await app.service.submit(originalInput);
  await deadline(entered);
  assert.equal(app.service.task(original.id).status, "running");
  const steerInput = { ...originalInput, submissionId: randomUUID(), message: addition };
  const send = app.kernel.send.bind(app.kernel);
  app.kernel.send = async (input) => {
    const receipt = await send(input);
    if (input.idempotencyKey === steerInput.submissionId) throw new Error("Synthetic lost steering acknowledgment");
    return receipt;
  };
  await assert.rejects(app.service.submit(steerInput), /Synthetic lost steering acknowledgment/);
  const pending = app.store.get<SubmissionRecord>("submissions", steerInput.submissionId)!;
  const steered = app.service.task(pending.taskId);
  assert.notEqual(original.id, steered.id);
  assert.equal(app.service.task(original.id).status, "running");
  respond(held!, { role: "assistant", tool_calls: [{
    index: 0, id: randomUUID(), type: "function",
    function: { name: "exec", arguments: JSON.stringify({ command: "printf synthetic-steering-tool", host: "gateway" }) },
  }] }, "tool_calls");
  held = undefined;
  await deadline(continuation);
  assert.equal(app.service.task(original.id).status, "running");
  assert.ok(app.store.messages(conversationId).some((message) => message.runId === originalInput.submissionId &&
    message.blocks.some((block) => block.kind === "text" && block.text === "SYNTHETIC-ANSWER-WHILE-WORK-CONTINUES")));
  evidence.scenarios.push("ordinary-send-steers-and-answer-is-visible-before-original-work-completes");
  respond(continued!, { role: "assistant", content: "Synthetic final after input receipt." });
  continued = undefined;
  await until(original.id, (task) => task.status === "completed");
  const delivered = await until(steered.id, (task) => task.status === "completed" && task.inputDisposition === "steered");
  assert.equal(delivered.inputDisposition, "steered");
  const laterMessages = (requests[1] as { messages: { role: string; content: unknown }[] }).messages;
  assert.equal(laterMessages.filter((entry) => entry.role === "user" && JSON.stringify(entry.content).includes(addition)).length, 1);
  assert.equal(app.store.messages(conversationId).filter((entry) => entry.role === "user").length, 2);
  const originalReceipt = app.store.get<SubmissionRecord>("submissions", originalInput.submissionId)!;
  assert.equal(app.store.get<SubmissionRecord>("submissions", steerInput.submissionId)!.state, "pending");
  app.kernel.send = send;
  await app.close();
  app = await launchWorkbench({ root: paths.root, kernelEntry: resolve(values["kernel-entry"]), nodeExecutable: process.execPath, localEmbeddings: false });
  app.kernel.on("observation", (event) => evidence.frames.push(event));
  await app.service.reconcile();
  const duplicate = await app.service.submit(steerInput);
  assert.equal(duplicate.id, steered.id);
  assert.equal(app.service.task(steered.id).inputDisposition, "steered");
  assert.equal(app.service.task(original.id).status, "completed");
  assert.equal(app.store.messages(conversationId).filter((entry) => entry.role === "user").length, 2);
  assert.equal(requests.length, 3, "Recovery must not start a new model turn for delivered steering");
  const steerReceipt = app.store.get<SubmissionRecord>("submissions", steerInput.submissionId)!;
  assert.equal(steerReceipt.state, "accepted");
  assert.notEqual(steerReceipt.engineRunId, originalReceipt.engineRunId);
  assert.equal(app.store.get<{ taskId: string }>("runs", originalReceipt.engineRunId!)?.taskId, original.id);
  evidence.scenarios.push("active-native-steering-injects-one-input-into-the-existing-model-conversation-with-separate-owned-receipts");
  evidence.scenarios.push("lost-steering-acknowledgment-recovers-across-product-and-kernel-restart-without-another-model-turn");
  const idle = await app.service.submit({ ...steerInput, submissionId: randomUUID(), message: "SYNTHETIC-IDLE-STEER" });
  const idleFinal = await until(idle.id, (task) => task.status === "completed");
  assert.equal(idleFinal.inputDisposition, undefined);
  evidence.scenarios.push("idle-native-steering-starts-a-normal-turn");
  evidence.tasks = app.store.list<Task>("tasks");
  evidence.submissions = app.store.list<SubmissionRecord>("submissions");
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  if (continued && !continued.destroyed) respond(continued, { role: "assistant", content: "Synthetic cleanup." });
  if (held && !held.destroyed) respond(held, { role: "assistant", content: "Synthetic cleanup." });
  if (app) await app.close();
  await new Promise<void>((done) => model.close(() => done()));
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
  console.log({ root, scenarios: evidence.scenarios, error: evidence.error });
}
