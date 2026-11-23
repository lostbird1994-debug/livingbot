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
import type { RuntimeObservation } from "../../../packages/kernel-runtime/src/contracts.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
const kernelEntry = resolve(values["kernel-entry"]);
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-queue-"));
const paths = runtimePaths(join(root, "application"));
await preparePaths(paths);
const seed = new WorkbenchStore(join(paths.root, "workbench.sqlite"));
const bot = seed.createBot({ name: "Atlas", agentId: "atlas" });
seed.close();
const turns: string[] = [];
const heldBefore = new Set<string>();
const waiting = new Map<string, () => void>();
const holds = new Map<string, ServerResponse>();
const requests: unknown[] = [];
function respond(response: ServerResponse, token: string) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish] of [[{ role: "assistant", content: `Synthetic receipt ${token}` }, null], [{}, "stop"]]) {
    response.write(`data: ${JSON.stringify({
      id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  const messages = body.messages as { role: string; content: unknown }[];
  // Tokens are fixture input identities, not a natural-language quality rubric.
  const token = messages.filter((entry) => entry.role === "user").flatMap((entry) =>
    [...JSON.stringify(entry.content).matchAll(/QUEUE:[a-z]+:\d+/g)].map((match) => match[0])).at(-1);
  if (!token) { response.writeHead(400); response.end(); return; }
  turns.push(token);
  if (token.endsWith(":0") && !heldBefore.has(token)) {
    heldBefore.add(token); holds.set(token, response); waiting.get(token)?.(); return;
  }
  respond(response, token);
});
await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
const evidence: { scenarios: string[]; turns: string[]; requests: unknown[]; observations: RuntimeObservation[]; tasks?: Task[]; error?: string } = {
  scenarios: [], turns, requests, observations: [],
};
function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Queue deadline: ${label}`)), 45_000);
    promise.then((value) => { clearTimeout(timer); done(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
function until(id: string): Promise<Task> {
  return new Promise((done, reject) => {
    const store = app!.store;
    const timer = setTimeout(() => { store.off("event", changed); reject(new Error(`Queued task deadline: ${id}`)); }, 45_000);
    function changed() {
      const task = app!.service.task(id);
      if (!["completed", "failed", "cancelled"].includes(task.status)) return;
      clearTimeout(timer); store.off("event", changed); done(task);
    }
    store.on("event", changed); changed();
  });
}
async function launch() {
  const next = await launchWorkbench({ root: paths.root, kernelEntry, nodeExecutable: process.execPath });
  next.kernel.on("observation", (event) => evidence.observations.push(event));
  return next;
}
async function scenario(name: string, recovery: "none" | "gateway" | "product") {
  const conversationId = app!.store.createConversation("private", [bot.id], `Synthetic queue ${name}`).id;
  const inputs = Array.from({ length: 4 }, (_, index) => ({
    submissionId: randomUUID(), conversationId, botId: bot.id, message: `QUEUE:${name}:${index}`, queueMode: "followup" as const,
  }));
  const started: Task[] = [];
  const firstEntered = new Promise<void>((done) => { waiting.set(inputs[0].message, done); });
  started.push(await app!.service.submit(inputs[0]));
  await deadline(firstEntered, "model start");
  const send = app!.kernel.send.bind(app!.kernel);
  let lost = false;
  if (recovery !== "none") app!.kernel.send = async (input) => {
    const result = await send(input);
    if (input.idempotencyKey === inputs[2].submissionId && !lost) {
      lost = true; throw new Error("Synthetic queued acknowledgment lost");
    }
    return result;
  };
  for (const input of inputs.slice(1)) {
    try { started.push(await app!.service.submit(input)); }
    catch (error) {
      assert.match(String(error), /Synthetic queued acknowledgment lost/);
      const receipt = app!.store.get<SubmissionRecord>("submissions", input.submissionId)!;
      started.push(app!.service.task(receipt.taskId));
    }
  }
  app!.kernel.send = send;
  assert.equal(app!.service.task(started[0].id).status, "running");
  for (const task of started.slice(1)) assert.equal(app!.service.task(task.id).status, "queued");
  if (recovery === "none") {
    respond(holds.get(inputs[0].message)!, inputs[0].message);
  } else if (recovery === "product") {
    await app!.close();
    app = await launch();
  } else if (recovery === "gateway") {
    await app!.kernel.restart();
  }
  holds.delete(inputs[0].message);
  await app!.service.reconcile();
  const outcomes = await Promise.all(started.map((task) => until(task.id)));
  assert.ok(outcomes.every((task) => task.status === "completed"), JSON.stringify(outcomes));
  const observed = turns.filter((token) => token.startsWith(`QUEUE:${name}:`));
  assert.deepEqual(observed, recovery === "none"
    ? inputs.map((input) => input.message)
    : [inputs[0].message, ...inputs.map((input) => input.message)]);
  assert.equal(app!.store.messages(conversationId).filter((entry) => entry.role === "user").length, 4);
  const finals = app!.store.messages(conversationId).filter((entry) => entry.role === "assistant" && entry.final &&
    entry.blocks.some((block) => block.kind === "text" && block.text));
  assert.equal(finals.length, 4);
  for (const task of started) assert.equal(finals.filter((entry) => entry.taskId === task.id).length, 1);
  for (const input of inputs) {
    const receipt = app!.store.get<SubmissionRecord>("submissions", input.submissionId)!;
    assert.equal(receipt.state, "accepted");
    assert.equal((await app!.service.submit(input)).id, receipt.taskId);
  }
  evidence.scenarios.push(`${name}-four-inputs-retain-fifo-and-exactly-one-final-per-task`);
}
try {
  await writeKernelConfig(paths, buildKernelConfig(paths, await freeLoopbackPort(), newGatewayToken(), [{ id: bot.agentId }], {
    id: "synthetic", baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    api: "openai-completions", apiKey: "synthetic", model: "synthetic", contextWindow: 64_000, maxTokens: 1000,
  }));
  app = await launch();
  await scenario("ordered", "none");
  await scenario("gateway", "gateway");
  await scenario("product", "product");
  evidence.tasks = app.store.list<Task>("tasks");
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  evidence.tasks = app?.store.list<Task>("tasks");
  process.exitCode = 1;
} finally {
  for (const [token, response] of holds) if (!response.destroyed) respond(response, token);
  if (app) await app.close();
  await new Promise<void>((done) => model.close(() => done()));
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
  console.log({ root, scenarios: evidence.scenarios, error: evidence.error });
}
