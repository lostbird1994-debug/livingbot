import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Artifact, Message, Task } from "../../../packages/workbench/src/contracts.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import { launchWorkbench } from "./main.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-scheduled-groups-"));
const applicationRoot = join(root, "application");
await mkdir(applicationRoot, { recursive: true });
const seed = new WorkbenchStore(join(applicationRoot, "workbench.sqlite"));
const bots = ["Atlas", "Moss", "Fern"].map((name) => seed.createBot({ name, agentId: name.toLowerCase() }));
const group = seed.createConversation("group", bots.map((bot) => bot.id), "Synthetic scheduled project");
seed.close();
const requests: unknown[] = [];
const scenarios: string[] = [];
const bytes = "Synthetic teammate file.\n中文交付验证。\n";
const model = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(input);
    const messages = input.messages as { role: string; content: unknown }[];
    const index = messages.findLastIndex((message) => message.role === "user" &&
      JSON.stringify(message.content).includes("SCHEDULED_GROUP_"));
    assert.notEqual(index, -1, "The native request must contain its synthetic task");
    const task = JSON.stringify(messages[index].content);
    if (task.includes("SCHEDULED_GROUP_FAILURE")) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: {
        message: "Synthetic request rejected for this assigned task", type: "invalid_request_error",
      } }));
      return;
    }
    const returned = messages.slice(index + 1).filter((message) => message.role === "tool").length;
    const steps = task.includes("SCHEDULED_GROUP_COORDINATE") ? [{
      name: "dispatch_action", args: { id: "livingbot_assign_group", args: { assignments: [
        { botId: bots[1].id, message: "SCHEDULED_GROUP_SUCCESS Create and deliver the synthetic teammate file.", report: "private" },
        { botId: bots[2].id, message: "SCHEDULED_GROUP_FAILURE Exercise a synthetic provider failure.", report: "private" },
      ] } },
    }] : [
      { name: "write", args: { path: "tasks/group-evidence/result.md", content: bytes } },
      { name: "dispatch_action", args: { id: "livingbot_deliver_file", args: {
        relativePath: "tasks/group-evidence/result.md", mediaType: "text/markdown",
      } } },
    ];
    const call = steps[returned];
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = call ? { role: "assistant", tool_calls: [{
      index: 0, id: randomUUID(), type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) },
    }] } : { role: "assistant", content: task.includes("SCHEDULED_GROUP_COORDINATE") ?
      "Synthetic assignment receipt; individual outcomes belong to the child tasks." : "Synthetic teammate result." };
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
async function launch() {
  return launchWorkbench({
    root: applicationRoot, nodeExecutable: process.execPath, kernelEntry: resolve(values["kernel-entry"]!),
    connection: {
      id: "synthetic", baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      api: "openai-completions", apiKey: "synthetic", model: "synthetic", contextWindow: 64_000, maxTokens: 1000,
    },
  });
}
function until(predicate: () => boolean, label: string): Promise<void> {
  return new Promise((done, reject) => {
    const store = app!.store;
    const timer = setTimeout(() => { store.off("event", changed); reject(new Error(label)); }, 90_000);
    function changed() {
      if (!predicate()) return;
      clearTimeout(timer); store.off("event", changed); done();
    }
    store.on("event", changed); changed();
  });
}
let failure: string | undefined;
let retained: unknown;
try {
  app = await launch();
  const routine = await app.service.routines!.create({
    id: randomUUID(), botId: bots[0].id, conversationId: group.id, name: "Synthetic scheduled group assignment",
    message: "SCHEDULED_GROUP_COORDINATE Assign both teammates their separate work and private reporting.",
    schedule: { kind: "at", at: new Date(Date.now() + 5000).toISOString() },
  });
  console.log({ root, waitingFor: "native scheduled group and separate child outcomes" });
  let coordinator: Task | undefined;
  let children: Task[] = [];
  await until(() => {
    coordinator = app!.store.list<Task>("tasks").find((task) => task.routine?.id === routine.id);
    children = coordinator ? app!.store.find<Task>("tasks", "parentTaskId", coordinator.id) : [];
    return coordinator?.status === "completed" && children.length === 2 &&
      children.every((task) => ["completed", "failed", "cancelled"].includes(task.status)) &&
      app!.service.routines!.receipts(routine.id).length === 1;
  }, "Scheduled coordinator and both child outcomes did not finish");
  assert.ok(coordinator);
  const success = children.find((task) => task.botId === bots[1].id)!;
  const failed = children.find((task) => task.botId === bots[2].id)!;
  assert.equal(success.status, "completed");
  assert.equal(failed.status, "failed");
  assert.equal(success.conversationId, group.id);
  assert.equal(failed.conversationId, group.id);
  for (const child of children) {
    assert.equal(child.reportConversationId, app.store.privateConversation(child.botId).id);
    const report: Message | undefined = app.store.get<Message>("messages", `report:${child.id}`);
    assert.equal(report?.conversationId, child.reportConversationId);
    assert.equal(report?.botId, child.botId);
    assert.equal(report?.final, true);
    assert.ok(app.store.snapshot().notifications.some((notice) =>
      notice.taskId === child.id && notice.messageId === report!.id &&
      notice.conversationId === child.reportConversationId && notice.outcome === child.status));
  }
  scenarios.push("native-scheduled-group-coordinator-assigns-two-owned-children-with-independent-success-and-provider-failure");
  const artifacts = app.store.find<Artifact>("artifacts", "taskId", success.id);
  const successReport = app.store.get<Message>("messages", `report:${success.id}`)!;
  const privateDelivery = app.store.messages(success.reportConversationId).find((message) =>
    message.taskId === success.id && message.runId === successReport.runId &&
    message.blocks.some((block) => block.kind === "file"));
  assert.ok(privateDelivery);
  const privateBlock = privateDelivery.blocks.find((block) => block.kind === "file");
  assert.ok(privateBlock?.kind === "file");
  const privateFile = artifacts.find((artifact) => artifact.id === privateBlock.artifactId);
  assert.ok(privateFile);
  assert.equal((await app.service.files!.read(privateFile.id)).bytes.toString(), bytes);
  assert.equal(app.store.find<Artifact>("artifacts", "taskId", failed.id).length, 0);
  assert.ok(app.store.snapshot().notifications.some((notice) =>
    notice.taskId === coordinator!.id && notice.conversationId === group.id));
  scenarios.push("successful-child-delivers-exact-private-file-and-both-child-outcomes-link-to-their-own-private-reports");
  const taskIds = [coordinator.id, ...children.map((task) => task.id)];
  const before = requests.length;
  const notices = app.store.snapshot().notifications.filter((notice) => taskIds.includes(notice.taskId));
  assert.equal(notices.length, 3);
  await app.close();
  app = await launch();
  await app.service.routines!.reconcile();
  await app.service.reconcile();
  assert.equal(requests.length, before);
  assert.deepEqual(app.store.snapshot().notifications.filter((notice) => taskIds.includes(notice.taskId)), notices);
  assert.equal(app.store.get<Task>("tasks", success.id)?.status, "completed");
  assert.equal(app.store.get<Task>("tasks", failed.id)?.status, "failed");
  assert.deepEqual(app.store.get<Message>("messages", privateDelivery.id), privateDelivery);
  assert.equal((await app.service.files!.read(privateFile.id)).bytes.toString(), bytes);
  assert.equal(app.service.routines!.receipts(routine.id).length, 1);
  scenarios.push("scheduled-group-parent-children-private-results-notices-and-file-survive-restart-without-reexecution");
  retained = { coordinator: app.store.get("tasks", coordinator.id), children: children.map((task) => app!.store.get("tasks", task.id)), notices, artifacts };
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  model.closeAllConnections();
  await new Promise<void>((done) => model.close(() => done()));
  await writeFile(join(root, "evidence.json"), JSON.stringify({ scenarios, failure, requests, retained }, null, 2), { mode: 0o600, flag: "wx" });
  console.log({ root, scenarios, failure });
}
