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
import type { RuntimeObservation } from "../../../packages/kernel-runtime/src/contracts.ts";
import type { Run, SubmissionRecord, Task } from "../../../packages/workbench/src/contracts.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
const kernelEntry = resolve(values["kernel-entry"]);
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-continuation-"));
const paths = runtimePaths(join(root, "application"));
await preparePaths(paths);
const seed = new WorkbenchStore(join(paths.root, "workbench.sqlite"));
const bot = seed.createBot({ name: "Atlas", agentId: "atlas" });
const conversation = seed.privateConversation(bot.id);
seed.close();
const turns: string[] = [];
const held = new Set<ServerResponse>();
let entered!: () => void;
const firstEntered = new Promise<void>((done) => { entered = done; });
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  // Fixture IDs measure dispatch identity, not the quality of generated prose.
  const messages = body.messages as { role: string; content: unknown }[];
  const token = messages.filter((entry) => entry.role === "user").flatMap((entry) =>
    [...JSON.stringify(entry.content).matchAll(/CONTINUE:\d+/g)].map((match) => match[0])).at(-1);
  if (!token) { response.writeHead(400); response.end(); return; }
  turns.push(token);
  if (turns.length === 1) { held.add(response); entered(); return; }
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish] of [[{ role: "assistant", content: `Synthetic final ${token}` }, null], [{}, "stop"]]) {
    response.write(`data: ${JSON.stringify({
      id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
const evidence: {
  scenarios: string[]; turns: string[]; observations: RuntimeObservation[];
  generations: number[]; tasks?: Task[]; error?: string;
} = { scenarios: [], turns, observations: [], generations: [] };
function deadline<T>(work: Promise<T>, label: string): Promise<T> {
  return new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Continuation deadline: ${label}`)), 45_000);
    work.then((value) => { clearTimeout(timer); done(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
function completed(id: string): Promise<Task> {
  const store = app!.store;
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { store.off("event", changed); reject(new Error(`Task deadline: ${id}`)); }, 45_000);
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
  evidence.generations.push(next.kernel.generation);
  return next;
}
try {
  await writeKernelConfig(paths, buildKernelConfig(paths, await freeLoopbackPort(), newGatewayToken(), [{ id: bot.agentId }], {
    id: "synthetic", baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    api: "openai-completions", apiKey: "synthetic", model: "synthetic", contextWindow: 64_000, maxTokens: 1000,
  }));
  app = await launch();
  const tasks: Task[] = [];
  const inputs = Array.from({ length: 4 }, (_, index) => ({
    submissionId: randomUUID(), conversationId: conversation.id, botId: bot.id, message: `CONTINUE:${index}`,
    queueMode: "followup" as const,
  }));
  tasks.push(await app.service.submit(inputs[0]));
  await deadline(firstEntered, "first model call");
  for (const input of inputs.slice(1)) tasks.push(await app.service.submit(input));
  const sessionKey = app.store.engineSessionKey(conversation.id, bot.id);
  // Fault injection waits for actual native queue ownership, rather than
  // assuming that the admission acknowledgment already installed its worker.
  let beforeCrash = await app.kernel.recoverHistory(sessionKey);
  const custodyDeadline = Date.now() + 10_000;
  while (beforeCrash.pendingInputs?.queuedCount !== 3 && Date.now() < custodyDeadline) {
    await new Promise((done) => setTimeout(done, 100));
    beforeCrash = await app.kernel.recoverHistory(sessionKey);
  }
  await writeFile(join(root, "history-before-crash.json"), JSON.stringify(beforeCrash, null, 2), { flag: "wx", mode: 0o600 });
  assert.equal(beforeCrash.pendingInputs?.queuedCount, 3, "All accepted inputs must enter native queue custody before crashing");
  const generation = app.kernel.generation;
  const ready = new Promise<void>((done) => {
    const changed = (event: RuntimeObservation) => {
      if (event.type !== "ready" || event.generation <= generation) return;
      app!.kernel.off("observation", changed); done();
    };
    app!.kernel.on("observation", changed);
  });
  const ownedPid = app.kernel.processId;
  assert.ok(ownedPid);
  process.kill(ownedPid, "SIGKILL");
  await deadline(ready, "owned native relaunch");
  await app.service.reconcile();
  const history = await app.kernel.recoverHistory(sessionKey);
  await writeFile(join(root, "history-after-crash.json"), JSON.stringify(history, null, 2), { flag: "wx", mode: 0o600 });
  const receipts = await app.kernel.request("chat.history", { sessionKey, inputRunIds: inputs.map((input) => input.submissionId) });
  await writeFile(join(root, "receipts-after-crash.json"), JSON.stringify(receipts, null, 2), { flag: "wx", mode: 0o600 });
  assert.equal(history.sessionInfo?.hasActiveRun, false);
  assert.equal(turns.length, 1, "Relaunch alone does not invent authority to resume a task");
  assert.ok(tasks.every((task) => app!.service.task(task.id).status === "interrupted"));
  evidence.scenarios.push("exact-native-input-receipts-identify-all-inert-crash-left-queue-owners");
  const afterCrashGeneration = app.kernel.generation;
  const oldRuns = tasks.map((task) => app!.store.find<Run>("runs", "taskId", task.id)[0]);
  await app.close();
  app = await launch();
  await app.service.reconcile();
  assert.ok(app.kernel.generation > afterCrashGeneration);
  for (const run of oldRuns) assert.deepEqual(app.store.get<Run>("runs", run.id)?.kernelExit, run.kernelExit);
  evidence.scenarios.push("full-product-reopen-advances-generation-without-reassigning-old-crash-receipts");
  for (const [index, task] of tasks.entries()) {
    let idle = await app.kernel.recoverHistory(sessionKey);
    const idleDeadline = Date.now() + 10_000;
    while (idle.sessionInfo?.hasActiveRun !== false && Date.now() < idleDeadline) {
      await new Promise((done) => setTimeout(done, 100));
      idle = await app.kernel.recoverHistory(sessionKey);
    }
    assert.equal(idle.sessionInfo?.hasActiveRun, false, "The prior native turn must finish settling");
    const continuationId = randomUUID();
    const send = app.kernel.send.bind(app.kernel);
    if (index === 1) {
      app.kernel.send = async (input) => {
        const result = await send(input);
        if (input.idempotencyKey === continuationId) throw new Error("Synthetic continuation acknowledgment lost");
        return result;
      };
    }
    try {
      if (index === 1) await assert.rejects(app.service.continueTask(task.id, continuationId), /acknowledgment lost/);
      else await app.service.continueTask(task.id, continuationId);
    } finally { app.kernel.send = send; }
    const outcome = await completed(task.id);
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    const calls: number = turns.length;
    if (index === 1) {
      await app.close();
      app = await launch();
      await app.service.reconcile();
      evidence.scenarios.push("lost-continuation-ack-reconciles-after-product-restart-without-another-model-call");
    }
    await app.service.continueTask(task.id, continuationId);
    assert.equal(turns.length, calls);
    const receipt: SubmissionRecord = app.store.get<SubmissionRecord>("submissions", continuationId)!;
    assert.equal(receipt.state, "accepted");
    assert.equal(receipt.continuationOf, inputs[index].submissionId);
    assert.equal(receipt.sessionId, history.sessionInfo?.sessionId);
    assert.ok(receipt.expectedLeafEntryId === null || typeof receipt.expectedLeafEntryId === "string");
    assert.equal(app.store.list<Task>("tasks").length, 4);
  }
  assert.deepEqual(turns, ["CONTINUE:0", ...inputs.map((input) => input.message)]);
  const messages = app.store.messages(conversation.id);
  const finals = messages.filter((message) => message.role === "assistant" && message.final &&
    message.blocks.some((block) => block.kind === "text" && block.text));
  assert.equal(finals.length, 4);
  for (const task of tasks) assert.equal(finals.filter((message) => message.taskId === task.id).length, 1);
  assert.equal(messages.filter((message) => message.role === "user").length, 8);
  evidence.scenarios.push("four-explicit-continuations-preserve-original-tasks-and-deliver-one-final-each");
  evidence.tasks = app.store.list<Task>("tasks");
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  evidence.tasks = app?.store.list<Task>("tasks");
  process.exitCode = 1;
} finally {
  for (const response of held) if (!response.destroyed) response.end();
  if (app) await app.close();
  await new Promise<void>((done) => model.close(() => done()));
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { flag: "wx", mode: 0o600 });
  console.log({ root, scenarios: evidence.scenarios, error: evidence.error });
}
