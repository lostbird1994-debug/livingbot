import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchWorkbench, freeLoopbackPort } from "./main.ts";
import { buildKernelConfig, newGatewayToken, writeKernelConfig } from "../../../packages/kernel-runtime/src/config.ts";
import { preparePaths, runtimePaths } from "../../../packages/kernel-runtime/src/paths.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import type { Run, Task } from "../../../packages/workbench/src/contracts.ts";
import type { RuntimeObservation } from "../../../packages/kernel-runtime/src/contracts.ts";

// Opt-in real-executor integration: the parent turn and the requested work are
// synthetic, but the delegated child is the vendor's own harness started through
// the pinned acpx plugin. Each executor authenticates with its own existing
// login; no credential is read, copied or printed.
const { values } = parseArgs({ options: {
  "kernel-entry": { type: "string" }, "acp-plugin": { type: "string" },
  "codex-adapter": { type: "string" }, "workbuddy-cli": { type: "string" },
  "codex-home": { type: "string" },
  executors: { type: "string" }, "skip-cancel": { type: "boolean" },
} });
if (!values["kernel-entry"] || !values["acp-plugin"]) {
  throw new Error("--kernel-entry and --acp-plugin are required");
}
const codexAdapter = resolve(values["codex-adapter"] ??
  "local/validation/acp-NEwuNm/node_modules/@agentclientprotocol/codex-acp/dist/index.js");
const workbuddyCli = values["workbuddy-cli"] ??
  "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy";
const executors = (values.executors ?? "codex").split(",").map((item) => item.trim()).filter(Boolean);
// The executor authenticates with its own existing login; we only tell it where
// that login lives. Nothing is read or copied by this fixture.
const codexHome = resolve(values["codex-home"] ?? join(process.env.HOME ?? "", ".codex"));
const quote = (value: string) => "'" + value.split("'").join("'\\''") + "'";
const firstExecutor = executors[0]!;
// One delegated child per run keeps the evidence unambiguous; a second executor
// is probed on its own (see local/validation/acp-NEwuNm/probe-workbuddy.ts).
if (executors.length !== 1) throw new Error("Pass exactly one --executors value per run");
const ARTIFACT = "livingbot-executor.txt";
const ARTIFACT_TEXT = "LIVINGBOT-EXECUTOR-OK";
const ARTIFACT_TASK = "Create a file named " + ARTIFACT +
  " in your working directory. Its exact content must be the single line " + ARTIFACT_TEXT +
  ". Then reply with only the absolute path of that file.";
const CANCEL_TASK = "Run the shell command sleep 90 in your working directory, then reply done.";
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-real-executors-"));
const paths = runtimePaths(join(root, "application"));
await preparePaths(paths);
const seed = new WorkbenchStore(join(paths.root, "workbench.sqlite"));
const bot = seed.createBot({ name: "Atlas", agentId: "atlas" });
seed.close();
await mkdir(join(paths.workspaces, bot.agentId), { recursive: true });
const frames: unknown[] = [];
const observations: RuntimeObservation[] = [];
const requests: unknown[] = [];
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const messages = body.messages as { role: string; content: unknown }[];
  const trigger = messages.findLastIndex((message) => message.role === "user" &&
    JSON.stringify(message.content).includes("NATIVE-ACP-PROBE"));
  const received = messages.slice(trigger + 1).some((message) => message.role === "tool");
  requests.push({
    roles: messages.map((message) => message.role).join(","),
    trigger,
    tail: JSON.stringify(messages.at(-1)?.content ?? null).slice(0, 120),
    text: JSON.stringify(messages[trigger]?.content ?? null).slice(0, 120),
  });
  const prompt = JSON.stringify(messages[trigger]?.content ?? "");
  const executor = executors.find((name) => prompt.includes("FOR-" + name)) ?? firstExecutor;
  const cancelRun = prompt.includes("WAIT-FOR-CANCEL");
  const spawn = trigger >= 0 && !received;
  response.writeHead(200, { "content-type": "text/event-stream" });
  const delta = spawn ? { role: "assistant", tool_calls: [{
    index: 0, id: randomUUID(), type: "function", function: {
      name: "dispatch_action", arguments: JSON.stringify({
        id: "sessions_spawn", args: {
          runtime: "acp", agentId: executor, mode: "run",
          task: cancelRun ? CANCEL_TASK : ARTIFACT_TASK,
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
const evidence: Record<string, unknown> = {
  frames,
  requests,
  codexHome,
  executors,
  commands: {
    kernel: "node <openclaw>/openclaw.mjs gateway <port>",
    codex: "CODEX_HOME=<executor home> node " + codexAdapter + " (ACP adapter shipped with the pinned acpx plugin; Codex keeps its own login)",
    workbuddy: workbuddyCli + " --serve --acp (own login required; see delegation-delivery.md)",
  },
  prompt: ARTIFACT_TASK,
};
// Exactly what the product returns; messages are read per conversation.
type Snapshot = {
  tasks: Task[];
  notifications: { id: string; taskId: string; runId: string; conversationId: string; messageId: string; outcome: string }[];
};
type ProductMessage = { id: string; taskId?: string; conversationId: string; final?: boolean; blocks: unknown[] };
let token = "";
const productEvents: { cursor: number; type: string; entityId: string; data: unknown }[] = [];
let eventsAbort: AbortController | undefined;

/** The UI's own read path, authenticated exactly like the browser client. */
async function productGet<T>(path: string): Promise<T> {
  const response = await fetch(app!.url + path, { headers: { authorization: "Bearer " + token } });
  if (!response.ok) throw new Error(`Product API ${path} answered ${response.status}`);
  return await response.json() as T;
}

/** The UI's progress stream. Events are what a user sees while a child runs. */
async function openProductEvents(): Promise<void> {
  eventsAbort = new AbortController();
  const response = await fetch(app!.url + "/api/events", {
    headers: { authorization: "Bearer " + token, accept: "text/event-stream" },
    signal: eventsAbort.signal,
  });
  if (!response.ok || !response.body) throw new Error("Product event stream refused: " + response.status);
  void (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let index = buffer.indexOf("\n\n"); index >= 0; index = buffer.indexOf("\n\n")) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const line = chunk.split("\n").find((item) => item.startsWith("data: "));
          if (line) productEvents.push(JSON.parse(line.slice(6)));
        }
      }
    } catch { /* the stream is aborted when the workbench closes */ }
  })();
}

async function productPost<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(app!.url + path, {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Product API ${path} answered ${response.status}`);
  return await response.json() as T;
}

async function productMessages(conversationId: string): Promise<ProductMessage[]> {
  const result = await productGet<{ messages: ProductMessage[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
  );
  return result.messages;
}

async function waitForProduct<T>(read: (snapshot: Snapshot) => T | undefined, label: string, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = read(await productGet<Snapshot>("/api/snapshot"));
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Product API never showed " + label);
    await new Promise((done) => setTimeout(done, 250));
  }
}

/** Re-read the token after each launch: the desktop bridge issues a new one. */
async function adoptToken(): Promise<void> {
  token = JSON.parse(await readFile(app!.authPath, "utf8")).token as string;
}

/** ACP values that describe how a delegated run ended, from the executor itself. */
function cancelSignalValues(): string[] {
  return observations.flatMap((event) => {
    if (event.type !== "frame" || event.frame.event !== "agent" || event.frame.payload?.stream !== "acp") return [];
    const data = event.frame.payload.data as
      { phase?: string; eventType?: string; status?: string; stopReason?: string } | undefined;
    return [data?.phase, data?.eventType, data?.status, data?.stopReason]
      .filter((value): value is string => Boolean(value));
  });
}

async function waitForCancelSignal(timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const values = cancelSignalValues();
    if (values.some((value) => value.toLowerCase().includes("cancel")) || Date.now() > deadline) return values;
    await new Promise((done) => setTimeout(done, 250));
  }
}

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
  // The adapter is the ACP wrapper the pinned plugin already depends on; each
  // executor keeps its own credentials and its own login.
  plugins.entries.acpx = { enabled: true, config: {
    agents: {
      // acpx agent entries take command + args only, so the login location is set
      // by a launcher rather than copied into the process environment.
      codex: { command: "/bin/sh", args: ["-c",
        "CODEX_HOME=" + quote(codexHome) + " exec " + quote(process.execPath) + " " + quote(codexAdapter)] },
      workbuddy: { command: workbuddyCli, args: ["--serve", "--acp"] },
    },
    probeAgent: firstExecutor, timeoutSeconds: 240,
    nativeAgents: { opencode: false, qwen: false, pi: false, kilocode: false, copilot: false },
    piSessionCatalog: { enabled: false }, agentProcessEnvAllow: [],
  } };
  config.acp = { enabled: true, dispatch: { enabled: true }, backend: "acpx", allowedAgents: executors };
  await writeKernelConfig(paths, config);
  const launch = () => launchWorkbench({
    root: paths.root, kernelEntry: resolve(values["kernel-entry"]!), nodeExecutable: process.execPath,
  });
  app = await launch();
  await adoptToken();
  await openProductEvents();
  app.kernel.on("observation", (event) => { frames.push(event); observations.push(event); });
  // Submitted through the same route the composer uses.
  const task = await productPost<Task>("/api/submissions", {
    submissionId: randomUUID(), conversationId: app.store.privateConversation(bot.id).id, botId: bot.id,
    message: "NATIVE-ACP-PROBE",
  });
  const childTask = await waitForProduct(
    (snapshot) => snapshot.tasks.find((entry) => entry.parentTaskId === task.id), "the delegated child", 90_000,
  );
  assert.ok(childTask.delegation, "Product must adopt the exact native delegated child");
  await untilTask(task.id, "completed");
  // The product shows the adopted child while it runs, not only after it ends.
  const seenStatuses = new Set<string>([childTask.status]);
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const snapshot = await productGet<Snapshot>("/api/snapshot").catch(() => undefined);
      const entry = snapshot?.tasks.find((candidate) => candidate.id === childTask.id);
      if (entry) seenStatuses.add(entry.status);
      await new Promise((done) => setTimeout(done, 300));
    }
  })();
  await untilTask(childTask.id, "completed", 240_000);
  polling = false;
  await poller;
  assert.ok(seenStatuses.has("running"),
    "The child was visible as running through the product: " + [...seenStatuses].join(","));
  assert.equal(childTask.delegation.executor, firstExecutor);
  assert.ok(app.store.messages(task.conversationId).some((entry) => entry.taskId === childTask.id && entry.final));
  const childText = app.store.messages(task.conversationId)
    .filter((entry) => entry.taskId === childTask.id).map((entry) => JSON.stringify(entry.blocks)).join(" ");
  const artifactPath = /\/[^\s"'\\]+livingbot-executor\.txt/.exec(childText)?.[0];
  assert.ok(artifactPath, "The real executor reported its artifact path: " + childText.slice(0, 400));
  const produced = await readFile(artifactPath, "utf8").catch(() => undefined);
  assert.equal(produced?.trim(), ARTIFACT_TEXT, "The real executor wrote the requested artifact");
  evidence.artifact = { path: artifactPath, content: produced, insideFixture: artifactPath.startsWith(paths.root) };
  // Delivery chain: the child's own result notification, created by the product,
  // points at the final message in the parent's conversation.
  const childRun = app.store.find<Run>("runs", "taskId", childTask.id)[0];
  assert.ok(childRun, "The delegated child has its own run");
  const notification = await waitForProduct(
    (snapshot) => snapshot.notifications.find((entry) => entry.runId === childRun.id), "the child result notification", 30_000,
  );
  assert.equal(notification.outcome, "completed");
  assert.equal(notification.taskId, childTask.id);
  assert.equal(notification.conversationId, task.conversationId);
  const delivered = (await productMessages(task.conversationId))
    .find((entry) => entry.id === notification.messageId);
  assert.ok(delivered?.final, "The notification points at a final message");
  const deliveredText = JSON.stringify(delivered.blocks);
  assert.ok(deliveredText.includes(ARTIFACT), "The delivered message carries the executor's result");
  const childEvents = productEvents.filter((event) => event.entityId === childTask.id ||
    event.entityId === childRun.id || JSON.stringify(event.data).includes(childTask.id));
  assert.ok(childEvents.length > 0, "The product stream carried the child's progress");
  evidence.delivery = {
    notification,
    messageId: notification.messageId,
    messageText: deliveredText.slice(0, 400),
    eventCount: childEvents.length,
    eventTypes: [...new Set(childEvents.map((event) => event.type))],
    statusesSeen: [...seenStatuses],
  };
  evidence.phases = [...new Set(observations.flatMap((event) => event.type !== "frame" ? [] :
    event.frame.event !== "agent" || event.frame.payload?.stream !== "acp" ? [] :
    [(event.frame.payload.data as { phase?: string } | undefined)?.phase].filter(Boolean)))];
  assert.ok((evidence.phases as string[]).length > 0, "ACP progress was observed");
  const started = new Promise<string>((done, reject) => {
    const kernel = app!.kernel;
    // A real harness needs its own startup time before the prompt is accepted.
    const timer = setTimeout(() => { kernel.off("observation", observe); reject(new Error("Cancelable ACP child did not start")); }, 240_000);
    function observe(event: RuntimeObservation) {
      if (event.type !== "frame" || event.frame.event !== "agent" || event.frame.payload?.stream !== "acp" ||
        (event.frame.payload?.data as { phase?: string } | undefined)?.phase !== "prompt_submitted" ||
        typeof event.frame.payload.runId !== "string") return;
      clearTimeout(timer); kernel.off("observation", observe); done(event.frame.payload.runId);
    }
    kernel.on("observation", observe);
  });
  // A fresh conversation: after a delegated result the parent turn that reports it
  // cannot spawn again ("dispatch_action is not available in this turn").
  const cancelConversation = app.store.createConversation("private", [bot.id], "Cancel probe");
  const cancelParent = await productPost<Task>("/api/submissions", {
    submissionId: randomUUID(), botId: bot.id, conversationId: cancelConversation.id,
    message: "NATIVE-ACP-PROBE WAIT-FOR-CANCEL",
  });
  const cancelChild = await waitForProduct(
    (snapshot) => snapshot.tasks.find((entry) => entry.parentTaskId === cancelParent.id), "the cancelable child", 120_000,
  );
  await started;
  // Stop is the UI's own request, not a service call from inside the process.
  await productPost<Task>(`/api/tasks/${encodeURIComponent(cancelParent.id)}/cancel`, {});
  await waitForProduct(
    (snapshot) => snapshot.tasks.find((entry) => entry.id === cancelChild.id && entry.status === "cancelled"),
    "the cancelled child", 90_000,
  );
  // The product marks the child cancelled first; the executor then reports its own
  // stop reason, which is what proves the vendor harness was actually stopped.
  const cancelSignals = await waitForCancelSignal(60_000);
  assert.ok(cancelSignals.some((value) => value.toLowerCase().includes("cancel")),
    "The executor reported its own cancellation: " + String(cancelSignals));
  const stoppedSnapshot = await productGet<Snapshot>("/api/snapshot");
  const stoppedChild = stoppedSnapshot.tasks.find((entry) => entry.id === cancelChild.id);
  assert.equal(stoppedChild?.status, "cancelled");
  const stopMessage = (await productMessages(cancelConversation.id))
    .find((entry) => entry.taskId === cancelChild.id && entry.final);
  assert.ok(JSON.stringify(stopMessage?.blocks ?? "").includes("工作已停止"),
    "The product tells the user the delegated work stopped");
  eventsAbort?.abort();
  await app.close();
  app = undefined;
  app = await launch();
  await adoptToken();
  const restarted = await productGet<Snapshot>("/api/snapshot");
  const restartedChild = restarted.tasks.find((entry) => entry.id === childTask.id);
  const restartedCancelled = restarted.tasks.find((entry) => entry.id === cancelChild.id);
  assert.equal(restartedChild?.status, "completed");
  assert.equal(restartedCancelled?.status, "cancelled");
  assert.equal(restartedChild?.delegation?.parentRunId, childTask.delegation.parentRunId);
  assert.equal(restartedChild?.delegation?.executor, firstExecutor);
  assert.ok(restarted.notifications.some((entry) => entry.runId === childRun.id && entry.outcome === "completed"),
    "The delivered result notification survives a restart");
  const restoredMessages = await productMessages(task.conversationId);
  assert.ok(restoredMessages.some((entry) => entry.taskId === childTask.id && entry.final));
  evidence.restart = {
    statuses: { child: restartedChild?.status, cancelled: restartedCancelled?.status },
    notification: restarted.notifications.find((entry) => entry.runId === childRun.id),
    deliveredMessageFinal: restoredMessages.some((entry) => entry.taskId === childTask.id && entry.final),
  };
  evidence.tasks = app.store.list<Task>("tasks");
  evidence.cancelSignals = cancelSignals;
  evidence.status = "real-executor-delegation-passed";
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
