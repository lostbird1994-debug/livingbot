import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { freeLoopbackPort, launchWorkbench } from "./main.ts";
import { buildKernelConfig, newGatewayToken, writeKernelConfig } from "../../../packages/kernel-runtime/src/config.ts";
import { preparePaths, runtimePaths } from "../../../packages/kernel-runtime/src/paths.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import type { NativeScheduledRun, RoutineReceipt } from "../../../packages/workbench/src/routines.ts";
import type { Artifact, Task } from "../../../packages/workbench/src/contracts.ts";
import type { RuntimeObservation } from "../../../packages/kernel-runtime/src/contracts.ts";
import { OpenClawRoutines } from "../../../packages/kernel-runtime/src/routines.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
const kernelEntry = resolve(values["kernel-entry"]);
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-routines-"));
const paths = runtimePaths(join(root, "application"));
await preparePaths(paths);
const seed = new WorkbenchStore(join(paths.root, "workbench.sqlite"));
const bot = seed.createBot({ name: "Atlas", agentId: "atlas" });
const conversation = seed.privateConversation(bot.id);
seed.close();
const modelRequests: unknown[] = [];
const nativeScheduledRuns: NativeScheduledRun[] = [];
let activeStarted!: () => void;
const activeModel = new Promise<void>((done) => { activeStarted = done; });
let activeClosed!: () => void;
const activeTransportClosed = new Promise<void>((done) => { activeClosed = done; });
const mcpRequests: { method: string; params?: unknown }[] = [];
const mcp = createServer(async (request, response) => {
  if (request.method === "DELETE") { response.writeHead(200); response.end(); return; }
  if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString());
  mcpRequests.push(input);
  if (input.id === undefined) { response.writeHead(202); response.end(); return; }
  const result = input.method === "initialize" ? {
    protocolVersion: input.params.protocolVersion, capabilities: { tools: {} },
    serverInfo: { name: "synthetic-routine-evidence", version: "1.0.0" },
  } : input.method === "tools/list" ? { tools: [{
    name: "lookup", description: "Read synthetic evidence",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }] } : input.method === "tools/call" ? { content: [{ type: "text", text: "Synthetic permitted evidence" }] } : {};
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
});
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString());
  modelRequests.push(input);
  const messages = input.messages as { role: string; content: unknown }[];
  // Native runtime context is a separate user-role message after the task.
  // Select this fixture's actual task, never that injected context block.
  const lastUser = messages.findLastIndex((message) => message.role === "user" &&
    JSON.stringify(message.content).includes("ROUTINE:"));
  assert.notEqual(lastUser, -1, "The native request must contain the synthetic task");
  const checkAccess = JSON.stringify(messages[lastUser]).includes("ROUTINE:denied-service");
  const checkProvenance = JSON.stringify(messages[lastUser]).includes("ROUTINE:provenance-probe");
  const toolReturned = messages.slice(lastUser + 1).some((message) => message.role === "tool");
  if (JSON.stringify(messages[lastUser]).includes("ROUTINE:cancel-active")) {
    response.once("close", activeClosed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    })}\n\n`);
    activeStarted();
    return;
  }
  const probeSteps = [
    { name: "dispatch_action", args: { id: "livingbot_conversations", args: { operation: "list" } } },
    { name: "write", args: { path: "tasks/scheduled-evidence.md", content: "Synthetic scheduled file." } },
    { name: "dispatch_action", args: { id: "livingbot_deliver_file", args: { relativePath: "tasks/scheduled-evidence.md", mediaType: "text/markdown" } } },
  ];
  const probeStep = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
  const invoke = checkProvenance ? probeStep < probeSteps.length : checkAccess && !toolReturned;
  const call = checkProvenance ? probeSteps[probeStep] :
    { name: "dispatch_action", args: { id: "evidence__lookup", args: {} } };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish_reason] of [[{
    role: "assistant", ...(invoke ? { tool_calls: [{
      index: 0, id: randomUUID(), type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }] } : { content: "Synthetic scheduled delivery." }),
  }, null], [{}, invoke ? "tool_calls" : "stop"]]) {
    response.write(`data: ${JSON.stringify({
      id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});
await Promise.all([model, mcp].map((server) => new Promise<void>((done) => server.listen(0, "127.0.0.1", done))));
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
const evidence: {
  scenarios: string[]; observations: RuntimeObservation[]; modelRequests: unknown[];
  mcpRequests: unknown[]; nativeScheduledRuns: NativeScheduledRun[]; error?: string;
} = {
  scenarios: [], observations: [], modelRequests, mcpRequests, nativeScheduledRuns,
};
async function launch() {
  const next = await launchWorkbench({ root: paths.root, kernelEntry, nodeExecutable: process.execPath });
  const adopt = next.service.adoptScheduledRun.bind(next.service);
  next.service.adoptScheduledRun = async (input) => {
    nativeScheduledRuns.push(input);
    return adopt(input);
  };
  next.kernel.on("observation", (event) => evidence.observations.push(event));
  return next;
}
function receipt(id: string, count = 1): Promise<RoutineReceipt> {
  return new Promise((done, reject) => {
    const store = app!.store;
    const startedAt = Date.now();
    let deadlineAt = startedAt + 90_000;
    let timer: ReturnType<typeof setTimeout>;
    function changed() {
      const entries = app!.service.routines!.receipts(id);
      const result = entries.length >= count ? entries[count - 1] : undefined;
      clearTimeout(timer);
      if (result) { store.off("event", changed); done(result); return; }
      // Startup catch-up can publish its new slot after Gateway readiness.
      // Follow that event's deadline, with one fixed overall test bound.
      const scheduledAt = app!.service.routines!.get(id).nextRunAt ?? startedAt;
      deadlineAt = Math.min(startedAt + 10 * 60_000, Math.max(deadlineAt, scheduledAt + 90_000));
      timer = setTimeout(() => { store.off("event", changed); reject(new Error("Scheduled occurrence deadline exceeded")); },
        Math.max(1, deadlineAt - Date.now()));
    }
    store.on("event", changed); changed();
  });
}
async function bounded(promise: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_done, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 45_000);
    })]);
  } finally { clearTimeout(timer); }
}
try {
  const config = buildKernelConfig(paths, await freeLoopbackPort(), newGatewayToken(), [{ id: bot.agentId }], {
    id: "synthetic", baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    api: "openai-completions", apiKey: "synthetic", model: "synthetic", contextWindow: 64_000, maxTokens: 1000,
  });
  config.mcp = { servers: { evidence: { transport: "streamable-http", url: `http://127.0.0.1:${(mcp.address() as AddressInfo).port}` } } };
  await writeKernelConfig(paths, config);
  app = await launch();
  const input = {
    id: randomUUID(), botId: bot.id, conversationId: conversation.id, name: "Synthetic scheduled work",
    message: "ROUTINE:once", schedule: { kind: "at" as const, at: new Date(Date.now() + 10_000).toISOString() },
  };
  const request = app.kernel.request.bind(app.kernel);
  let lost = false;
  app.kernel.request = async <T>(method: string, params: unknown, timeout?: number): Promise<T> => {
    const result = await request<T>(method, params, timeout);
    if (method === "cron.add" && !lost) { lost = true; throw new Error("Synthetic schedule acknowledgment lost"); }
    return result;
  };
  await assert.rejects(app.service.routines!.create(input), /acknowledgment lost/);
  app.kernel.request = request;
  assert.equal(app.service.routines!.get(input.id).state, "pending");
  await app.close();
  // Deliberately miss the slot with the entire product stopped; native startup
  // owns catch-up. This test deadline is not an application dispatch timer.
  await new Promise<void>((done) => setTimeout(done, Math.max(0, Date.parse(input.schedule.at) + 500 - Date.now())));
  app = await launch();
  await app.service.routines!.reconcile();
  const recovered = app.service.routines!.get(input.id);
  assert.equal(recovered.state, "ready");
  const native = await app.kernel.request<{ jobs: { id: string; declarationKey?: string }[] }>("cron.list", { includeDisabled: true });
  const current = await new OpenClawRoutines(app.kernel).get(recovered.nativeId!);
  assert.equal(native.jobs.filter((job) => job.declarationKey === current.declarationKey).length, 1);
  evidence.scenarios.push("lost-native-create-ack-recovers-one-schedule-after-full-product-restart");
  console.log({ root, waitingFor: "native scheduled occurrence", nativeId: recovered.nativeId, nextRunAt: recovered.nextRunAt });
  const outcome = await receipt(input.id);
  assert.equal(outcome.status, "ok", JSON.stringify(outcome));
  assert.equal(outcome.completion, "succeeded", JSON.stringify(outcome));
  assert.equal(outcome.delivery, "not-requested", JSON.stringify(outcome));
  await app.service.reconcileSession(app.store.engineSessionKey(conversation.id, bot.id));
  const delivered = app.store.messages(conversation.id).filter((message) =>
    message.role === "assistant" && message.blocks.some((block) => block.kind === "text" && block.text.includes("Synthetic scheduled delivery.")));
  assert.equal(delivered.length, 1);
  const firstNotice = app.store.snapshot().notifications.find((notice) => notice.messageId === delivered[0].id);
  assert.ok(firstNotice, "The native result must retain a notification linking to its actual final reply");
  assert.equal(firstNotice.outcome, "completed");
  const readNotice = app.store.readNotification(firstNotice.id);
  assert.equal(modelRequests.length, 1);
  assert.deepEqual(app.store.snapshot().notifications.filter((notice) => notice.id === firstNotice.id), [readNotice]);
  evidence.scenarios.push("native-timer-commits-one-result-in-its-execution-conversation-without-external-delivery");
  evidence.scenarios.push("a-missed-slot-is-caught-up-by-native-startup-without-product-dispatch");
  await app.close();
  app = await launch();
  await app.service.routines!.reconcile();
  await app.service.reconcile();
  assert.equal(app.service.routines!.receipts(input.id).length, 1);
  assert.equal(modelRequests.length, 1);
  assert.equal(app.store.messages(conversation.id).filter((message) =>
    message.role === "assistant" && message.blocks.some((block) => block.kind === "text" && block.text.includes("Synthetic scheduled delivery."))).length, 1);
  evidence.scenarios.push("completed-occurrence-and-its-delivery-survive-reopen-without-replay");
  const cancel = await app.service.routines!.create({
    ...input, id: randomUUID(), name: "Synthetic cancelled work",
    schedule: { kind: "at", at: new Date(Date.now() + 86_400_000).toISOString() },
  });
  const disabled = await app.service.routines!.setEnabled(cancel.id, false, cancel.revision!);
  assert.equal(disabled.enabled, false);
  const saved = await new OpenClawRoutines(app.kernel).get(disabled.nativeId!);
  assert.equal(saved.enabled, false);
  assert.equal(app.service.routines!.receipts(cancel.id).length, 0);
  evidence.scenarios.push("cancelling-future-work-disables-native-schedule-without-deleting-history");
  const abilities = await app.service.abilities!.refresh(bot.id);
  const service = abilities.find((ability) => ability.configuration?.native &&
    (ability.configuration.native as { nativeKind?: string; nativeName?: string }).nativeKind === "service" &&
    (ability.configuration.native as { nativeName?: string }).nativeName === "evidence");
  assert.ok(service, "Synthetic service must be manageable before testing its scheduled denial");
  await app.service.abilities!.setEnabled(service.id, bot.id, false);
  const beforeCalls = mcpRequests.filter((entry) => entry.method === "tools/call").length;
  const restricted = await app.service.routines!.create({
    ...input, id: randomUUID(), name: "Synthetic restricted work", message: "ROUTINE:denied-service",
    schedule: { kind: "at", at: new Date(Date.now() + 5_000).toISOString() },
  });
  await receipt(restricted.id);
  assert.ok(modelRequests.some((request) => {
    const messages = (request as { messages: { role: string; content: unknown }[] }).messages;
    return messages.some((message) => message.role === "tool");
  }), "Service denial must be exercised by a real attempted tool call");
  assert.equal(mcpRequests.filter((entry) => entry.method === "tools/call").length, beforeCalls,
    "Scheduled execution must not bypass this Bot's disabled service");
  evidence.scenarios.push("native-scheduled-work-cannot-invoke-a-service-disabled-for-its-bot");
  const active = await app.service.routines!.create({
    ...input, id: randomUUID(), name: "Synthetic active cancellation", message: "ROUTINE:cancel-active",
    schedule: { kind: "at", at: new Date(Date.now() + 5_000).toISOString() },
  });
  await bounded(activeModel, "Native schedule did not enter its model call");
  const cancelled = await app.service.routines!.setEnabled(active.id, false, active.revision!);
  assert.equal(cancelled.enabled, false);
  await bounded(activeTransportClosed, "Disabling a running native schedule did not close its model transport");
  const stopped = await receipt(active.id);
  assert.notEqual(stopped.completion, "succeeded");
  assert.notEqual(stopped.delivery, "delivered");
  evidence.scenarios.push("disabling-active-work-stops-the-native-model-transport-and-retains-a-nonsuccess-receipt");
  const probe = await app.service.routines!.create({
    ...input, id: randomUUID(), name: "Synthetic cron authority probe",
    message: "ROUTINE:provenance-probe",
    schedule: { kind: "at", at: new Date(Date.now() + 5_000).toISOString() },
  });
  await receipt(probe.id);
  const observed = nativeScheduledRuns.find((run) => run.jobId === probe.nativeId);
  assert.ok(observed, "Native scheduled run identity must reach the protected product boundary");
  assert.equal(observed.agentId, bot.agentId);
  assert.equal(observed.trigger, "cron");
  assert.equal(observed.sessionKey, app.store.engineSessionKey(conversation.id, bot.id));
  const tasks = app.store.list<Task>("tasks").filter((task) => task.routine?.id === probe.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].routine?.sessionId, observed.sessionId);
  assert.equal(tasks[0].status, "completed");
  const artifacts = app.store.list<Artifact>("artifacts").filter((artifact) => artifact.taskId === tasks[0].id);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].conversationId, conversation.id);
  assert.equal((await app.service.files!.read(artifacts[0].id)).bytes.toString(), "Synthetic scheduled file.");
  assert.ok(modelRequests.some((request) => {
    const messages = (request as { messages: { role: string; content: unknown }[] }).messages;
    const taskIndex = messages.findLastIndex((message) => message.role === "user" &&
      JSON.stringify(message.content).includes("ROUTINE:provenance-probe"));
    return taskIndex !== -1 && messages.slice(taskIndex + 1).some((message) =>
      message.role === "tool" && JSON.stringify(message.content).includes(conversation.id) &&
      !JSON.stringify(message.content).includes("No active native conversation authority"));
  }), "Only an exactly bound product task may use LivingBot conversation tools");
  evidence.scenarios.push("native-prompt-hook-binds-exact-scheduled-task-and-authorizes-conversation-tools");
  evidence.scenarios.push("scheduled-file-delivery-retains-task-ownership-and-exact-bytes");
  const requestsBeforeReopen = modelRequests.length;
  await app.close();
  app = await launch();
  await app.service.routines!.reconcile();
  await app.service.reconcile();
  assert.equal(app.store.get<Task>("tasks", tasks[0].id)?.status, "completed");
  assert.equal(app.store.list<Artifact>("artifacts").filter((artifact) => artifact.taskId === tasks[0].id).length, 1);
  assert.equal((await app.service.files!.read(artifacts[0].id)).bytes.toString(), "Synthetic scheduled file.");
  assert.equal(modelRequests.length, requestsBeforeReopen);
  evidence.scenarios.push("scheduled-task-and-immutable-file-survive-product-restart-without-reexecution");
  const recurring = await app.service.routines!.create({
    ...input, id: randomUUID(), name: "Synthetic recurring work", message: "ROUTINE:recurring",
    schedule: { kind: "every", everyMs: 60_000 },
  });
  await receipt(recurring.id);
  const userTask = await app.service.submit({
    submissionId: randomUUID(), botId: bot.id, conversationId: conversation.id,
    message: "ROUTINE:user-between-occurrences",
  });
  await bounded(new Promise<void>((done) => {
    const store = app!.store;
    const changed = () => {
      if (app!.service.task(userTask.id).status !== "completed") return;
      store.off("event", changed); done();
    };
    store.on("event", changed); changed();
  }), "User turn between scheduled occurrences did not complete");
  await receipt(recurring.id, 2);
  const paused = await app.service.routines!.setEnabled(
    recurring.id, false, app.service.routines!.get(recurring.id).revision!,
  );
  assert.equal(paused.enabled, false);
  const recurringTasks = app.store.list<Task>("tasks").filter((task) => task.routine?.id === recurring.id);
  assert.equal(recurringTasks.length, 2);
  assert.ok(recurringTasks.every((task) => task.status === "completed" && task.id !== userTask.id));
  assert.equal(app.service.task(userTask.id).routine, undefined);
  assert.equal(app.service.task(userTask.id).status, "completed");
  assert.equal(app.service.routines!.receipts(recurring.id).length, 2);
  const recurringNotices = app.store.snapshot().notifications.filter((notice) => recurringTasks.some((task) => task.id === notice.taskId));
  assert.equal(recurringNotices.length, 2);
  assert.equal(new Set(recurringNotices.map((notice) => notice.messageId)).size, 2);
  evidence.scenarios.push("two-native-recurrences-remain-distinct-from-an-interleaved-user-turn-and-can-be-paused");
  const editedContent = {
    name: "Revised recurring work", message: "ROUTINE:revised-recurring",
    schedule: { kind: "every" as const, everyMs: 120_000 },
  };
  const beforeEdit = app.service.routines!.get(recurring.id);
  const editRequest = app.kernel.request.bind(app.kernel);
  let editAcknowledgmentLost = false;
  let nativeEdits = 0;
  app.kernel.request = async <T>(method: string, params: unknown, timeout?: number): Promise<T> => {
    const result = await editRequest<T>(method, params, timeout);
    if (method === "cron.update" && (params as { id?: string }).id === recurring.nativeId) {
      nativeEdits++;
      if (!editAcknowledgmentLost) { editAcknowledgmentLost = true; throw new Error("Synthetic edit acknowledgment lost"); }
    }
    return result;
  };
  await assert.rejects(app.service.routines!.update(recurring.id, beforeEdit.revision!, editedContent), /edit acknowledgment lost/);
  const edited = await app.service.routines!.update(recurring.id, beforeEdit.revision!, editedContent);
  app.kernel.request = editRequest;
  assert.equal(nativeEdits, 1);
  assert.equal(edited.nativeId, recurring.nativeId);
  assert.equal(edited.enabled, false);
  assert.deepEqual(edited.schedule, editedContent.schedule);
  assert.equal(app.service.routines!.receipts(recurring.id).length, 2);
  await app.close();
  app = await launch();
  await app.service.routines!.reconcile();
  const reopened = app.service.routines!.get(recurring.id);
  assert.equal(reopened.message, editedContent.message);
  assert.equal(reopened.enabled, false);
  assert.deepEqual(reopened.schedule, editedContent.schedule);
  assert.equal(app.service.routines!.receipts(recurring.id).length, 2);
  evidence.scenarios.push("native-schedule-edit-recovers-a-lost-ack-and-reopens-with-its-original-two-receipts");
  assert.deepEqual(app.store.snapshot().notifications.filter((notice) => notice.id === firstNotice.id), [readNotice]);
  assert.deepEqual(app.store.snapshot().notifications.filter((notice) =>
    recurringTasks.some((task) => task.id === notice.taskId)), recurringNotices);
  evidence.scenarios.push("native-result-notifications-link-each-occurrence-and-retain-exact-read-receipts-across-restarts");
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  model.closeAllConnections();
  await Promise.all([model, mcp].map((server) => new Promise<void>((done) => server.close(() => done()))));
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
  console.log({ root, scenarios: evidence.scenarios, error: evidence.error });
}
