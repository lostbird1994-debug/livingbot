import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { launchWorkbench, freeLoopbackPort } from "./main.ts";
import { buildKernelConfig, newGatewayToken, writeKernelConfig } from "../../../packages/kernel-runtime/src/config.ts";
import { preparePaths, runtimePaths } from "../../../packages/kernel-runtime/src/paths.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import type { Run, Task } from "../../../packages/workbench/src/contracts.ts";
import type { RuntimeObservation } from "../../../packages/kernel-runtime/src/contracts.ts";

// Opt-in real Gateway/plugin integration. All prompts, files and executor work
// are synthetic; passing this does not establish real executor task quality.
const { values } = parseArgs({ options: {
  "kernel-entry": { type: "string" }, "acp-plugin": { type: "string" },
} });
if (!values["kernel-entry"] || !values["acp-plugin"]) {
  throw new Error("--kernel-entry and --acp-plugin are required");
}
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-delegations-"));
const paths = runtimePaths(join(root, "application"));
await preparePaths(paths);
const seed = new WorkbenchStore(join(paths.root, "workbench.sqlite"));
const bot = seed.createBot({ name: "Atlas", agentId: "atlas" });
seed.close();
await mkdir(join(paths.workspaces, bot.agentId), { recursive: true });
const frames: unknown[] = [];
let reported!: () => void;
const childReported = new Promise<void>((done) => { reported = done; });
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const messages = body.messages as { role: string; content: unknown }[];
  if (messages.some((message) => JSON.stringify(message.content).includes("SYNTHETIC-ACP-RESULT-4382"))) reported();
  const trigger = messages.findLastIndex((message) => message.role === "user" &&
    JSON.stringify(message.content).includes("NATIVE-ACP-PROBE"));
  const received = messages.slice(trigger + 1).some((message) => message.role === "tool");
  const spawn = trigger >= 0 && !received;
  response.writeHead(200, { "content-type": "text/event-stream" });
  const delta = spawn ? { role: "assistant", tool_calls: [{
    index: 0, id: randomUUID(), type: "function", function: {
      name: "dispatch_action", arguments: JSON.stringify({
        id: "sessions_spawn", args: {
          runtime: "acp", agentId: "synthetic", mode: "run",
          task: JSON.stringify(messages[trigger]?.content).includes("WAIT-FOR-CANCEL") ? "WAIT-FOR-CANCEL" : "NATIVE-CHILD-4382",
        },
      }),
    },
  }] } : { role: "assistant", content: "Synthetic parent protocol result." };
  for (const [chunk, finish] of [[delta, null], [{}, spawn ? "tool_calls" : "stop"]]) {
    response.write(`data: ${JSON.stringify({
      id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta: chunk, finish_reason: finish }],
    })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
const evidence: Record<string, unknown> = { frames };
function untilTask(id: string, status: Task["status"], timeout = 30_000): Promise<void> {
  return new Promise((done, reject) => {
    const store = app!.store;
    const timer = setTimeout(() => { store.off("event", changed); reject(new Error(`Task did not become ${status}`)); }, timeout);
    function changed() {
      const current = app!.service.task(id).status;
      if (current !== status && !["failed", "cancelled"].includes(current)) return;
      clearTimeout(timer); store.off("event", changed);
      if (current === status) done();
      else reject(new Error(`Task unexpectedly became ${current}`));
    }
    store.on("event", changed); changed();
  });
}
try {
  const config = buildKernelConfig(paths, await freeLoopbackPort(), newGatewayToken(), [{ id: bot.agentId }], {
    id: "synthetic", baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    api: "openai-completions", apiKey: "synthetic", model: "synthetic", contextWindow: 64_000, maxTokens: 1000,
  });
  const plugins = config.plugins as { load?: unknown; entries: Record<string, unknown> };
  plugins.load = { paths: [resolve(values["acp-plugin"])] };
  plugins.entries.acpx = { enabled: true, config: {
    agents: { synthetic: { command: process.execPath, args: [
      fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url)), join(root, "acp-requests.jsonl"),
    ] } },
    probeAgent: "synthetic", timeoutSeconds: 15,
    nativeAgents: { opencode: false, qwen: false, pi: false, kilocode: false, copilot: false },
    piSessionCatalog: { enabled: false }, agentProcessEnvAllow: [],
  } };
  config.acp = { enabled: true, dispatch: { enabled: true }, backend: "acpx", allowedAgents: ["synthetic"] };
  await writeKernelConfig(paths, config);
  const launch = () => launchWorkbench({
    root: paths.root, kernelEntry: resolve(values["kernel-entry"]!), nodeExecutable: process.execPath,
  });
  app = await launch();
  app.kernel.on("observation", (event) => { frames.push(event); });
  const task = await app.service.submit({
    submissionId: randomUUID(), conversationId: app.store.privateConversation(bot.id).id, botId: bot.id,
    message: "NATIVE-ACP-PROBE",
  });
  await untilTask(task.id, "completed");
  let reportTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([childReported, new Promise<never>((_done, reject) => {
      reportTimer = setTimeout(() => reject(new Error("Native child did not report to its parent")), 25_000);
    })]);
  } finally { clearTimeout(reportTimer); }
  const childTask = app.store.list<Task>("tasks").find((entry) => entry.parentTaskId === task.id);
  assert.ok(childTask?.delegation, "Product must adopt the exact native delegated child");
  await untilTask(childTask.id, "completed");
  assert.equal(childTask.delegation.executor, "synthetic");
  assert.ok(app.store.messages(task.conversationId).some((entry) => entry.taskId === childTask.id && entry.final));
  const started = new Promise<string>((done, reject) => {
    const kernel = app!.kernel;
    const timer = setTimeout(() => { kernel.off("observation", observe); reject(new Error("Cancelable ACP child did not start")); }, 25_000);
    function observe(event: RuntimeObservation) {
      if (event.type !== "frame" || event.frame.event !== "agent" || event.frame.payload?.stream !== "acp" ||
        (event.frame.payload?.data as { phase?: string } | undefined)?.phase !== "prompt_submitted" ||
        typeof event.frame.payload.runId !== "string") return;
      clearTimeout(timer); kernel.off("observation", observe); done(event.frame.payload.runId);
    }
    kernel.on("observation", observe);
  });
  const cancelParent = await app.service.submit({
    submissionId: randomUUID(), botId: bot.id, conversationId: task.conversationId,
    message: "NATIVE-ACP-PROBE WAIT-FOR-CANCEL",
  });
  const cancelRun = app.store.get<Run>("runs", await started)!;
  const cancelChild = app.store.get<Task>("tasks", cancelRun.taskId)!;
  assert.equal(cancelChild.parentTaskId, cancelParent.id);
  await app.service.cancel(cancelParent.id);
  await untilTask(cancelChild.id, "cancelled", 15_000);
  const nativeRequests = (await readFile(join(root, "acp-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(nativeRequests.some((entry) => entry.method === "session/prompt"));
  assert.ok(nativeRequests.some((entry) => entry.method === "session/cancel"));
  await app.close();
  app = undefined;
  app = await launch();
  assert.equal(app.service.task(childTask.id).status, "completed");
  assert.equal(app.service.task(cancelChild.id).status, "cancelled");
  assert.equal(app.service.task(childTask.id).delegation?.parentRunId, childTask.delegation.parentRunId);
  assert.ok(app.store.messages(task.conversationId).some((entry) => entry.taskId === childTask.id && entry.final));
  evidence.tasks = app.store.list<Task>("tasks");
  evidence.nativeRequests = nativeRequests;
  evidence.status = "native-dispatch-result-cancel-and-restart-passed";
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  try { await app?.close(); }
  finally {
    await new Promise<void>((done) => model.close(() => done()));
    await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
    console.log({ root, status: evidence.status, error: evidence.error });
  }
}
