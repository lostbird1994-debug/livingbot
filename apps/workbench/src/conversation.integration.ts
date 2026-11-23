import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { freeLoopbackPort, launchWorkbench } from "./main.ts";
import { buildKernelConfig, newGatewayToken, writeKernelConfig } from "../../../packages/kernel-runtime/src/config.ts";
import { preparePaths, runtimePaths } from "../../../packages/kernel-runtime/src/paths.ts";
import type { RuntimeObservation } from "../../../packages/kernel-runtime/src/contracts.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import type { Artifact, Block, Message, ResultNotification, Run, Task } from "../../../packages/workbench/src/contracts.ts";

// One Bot's ordered document must survive a hard kernel death and a full
// product restart exactly as the reader left it, without inventing a result,
// while another Bot keeps working in its own conversation.
//
//   node apps/workbench/src/conversation.integration.ts --kernel-entry <openclaw.mjs>

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
const kernelEntry = resolve(values["kernel-entry"]);
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-conversation-"));
const paths = runtimePaths(join(root, "application"));
await preparePaths(paths);
const seed = new WorkbenchStore(join(paths.root, "workbench.sqlite"));
const atlas = seed.createBot({ name: "Atlas", agentId: "atlas" });
const moss = seed.createBot({ name: "Moss", agentId: "moss" });
seed.close();

const longTask = "SYNTHETIC-LONG-DOCUMENT 请检查合成任务。";
const backgroundTask = "SYNTHETIC-BACKGROUND-DELIVERY 请准备合成交付。";
const commentary = "先看合成任务的目标。";
const partial = "SYNTHETIC-LONG-PARTIAL 正在整理中间结论。";
const continuationFinal = "SYNTHETIC-LONG-FINAL 合成任务已完成。";
const backgroundResult = "SYNTHETIC-BACKGROUND-RESULT 交付如下。";
const delivered = "# 合成交付\n\n后台工作的真实文件内容。\n";
const secret = "synthetic-conversation-credential";
const requests: unknown[] = [];
let atlasCalls = 0;
const held: ServerResponse[] = [];

type ChatMessage = Record<string, unknown>;

// The kernel wraps each turn in its own runtime context, so routing reads the
// whole request rather than assuming which user message carries the task.
function requestText(history: ChatMessage[]): string {
  return JSON.stringify(history);
}

function toolRounds(history: ChatMessage[]): number {
  return history.filter((entry) => entry.role === "tool").length;
}

function respond(response: ServerResponse, delta: unknown, finish = "stop") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [content, reason] of [[delta, null], [{}, finish]]) response.write(`data: ${JSON.stringify({
    id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
    choices: [{ index: 0, delta: content, finish_reason: reason }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function call(name: string, args: unknown) {

  return { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] };

}

const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: ChatMessage[] };
  requests.push(body);
  const text = requestText(body.messages);
  const round = toolRounds(body.messages);
  if (text.includes("SYNTHETIC-BACKGROUND-DELIVERY")) {
    if (round === 0) return respond(response, call("write", {
      path: "tasks/background-result.md", content: delivered,
    }), "tool_calls");
    if (round === 1) return respond(response, call("dispatch_action", {
      id: "livingbot_deliver_file", args: { relativePath: "tasks/background-result.md", mediaType: "text/markdown" },
    }), "tool_calls");
    return respond(response, { role: "assistant", content: backgroundResult });
  }
  if (text.includes("SYNTHETIC-LONG-DOCUMENT")) {
    atlasCalls += 1;
    if (atlasCalls === 1) return respond(response, call("read", { path: "projects/synthetic-contract.md" }), "tool_calls");
    if (atlasCalls === 2) return respond(response, call("exec", {
      command: "printf synthetic-conversation-tool", host: "gateway", env: { SYNTHETIC_API_TOKEN: secret },
    }), "tool_calls");
    // The third native turn is deliberately left unanswered, so the document
    // stays unfinished until the user explicitly continues it.
    if (atlasCalls === 3) {
      held.push(response);
      return undefined;
    }
    return respond(response, { role: "assistant", content: continuationFinal });
  }
  return respond(response, { role: "assistant", content: continuationFinal });
});
await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));

type App = Awaited<ReturnType<typeof launchWorkbench>>;
let app: App | undefined;
const scenarios: string[] = [];
const evidence: Record<string, unknown> = { requests, scenarios };

function launch(): Promise<App> {
  return launchWorkbench({ root: paths.root, kernelEntry, nodeExecutable: process.execPath });
}

function within<T>(work: Promise<T>, label: string, budget = 45_000): Promise<T> {
  return new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Deadline exceeded: " + label)), budget);
    work.then((value) => { clearTimeout(timer); done(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

let finished = false;

function until<T>(check: () => T | undefined, label: string, budget = 30_000): Promise<T> {
  return within(new Promise<T>((done, fail) => {
    const attempt = () => {
      if (finished) return;
      let value: T | undefined;
      try {
        value = check();
      } catch (error) {
        fail(error);
        return;
      }
      if (value === undefined) return void setTimeout(attempt, 100);
      done(value);
    };
    attempt();
  }), label, budget);
}

function completed(id: string): Promise<Task> {
  return until(() => {
    const task = app!.service.task(id);
    return ["completed", "failed", "cancelled", "interrupted"].includes(task.status) ? task : undefined;
  }, "task " + id + " terminal");
}

try {
  const connection = {
    id: "synthetic", baseUrl: "http://127.0.0.1:" + String((model.address() as AddressInfo).port) + "/v1",
    api: "openai-completions" as const, apiKey: "synthetic", model: "synthetic",
    contextWindow: 64_000, maxTokens: 1000,
  };
  const config = buildKernelConfig(paths, await freeLoopbackPort(), newGatewayToken(),
    [{ id: atlas.agentId }, { id: moss.agentId }], connection);
  config.tools = { exec: { mode: "full", notifyOnExit: false } };
  await writeKernelConfig(paths, config);
  app = await launch();
  const atlasChat = app.store.privateConversation(atlas.id).id;
  const mossChat = app.store.privateConversation(moss.id).id;

  const longTurn = await app.service.submit({
    submissionId: randomUUID(), botId: atlas.id, conversationId: atlasChat, message: longTask,
  });
  const documentId = await until(() => {
    const reply = app!.store.messages(atlasChat).find((message) => message.role === "assistant");
    const settled = reply?.blocks.filter((block) => block.kind === "tool" && block.phase === "result") ?? [];
    return settled.length >= 2 && reply ? reply.id : undefined;
  }, "the streamed document");
  const document = app!.store.get<Message>("messages", documentId)!;
  const order = document.blocks.map((block) => block.kind);
  assert.deepEqual(order, ["tool", "tool"], JSON.stringify(order));
  assert.equal(document.final, false, "The held turn must not produce a reply");

  const background = await app.service.submit({
    submissionId: randomUUID(), botId: moss.id, conversationId: mossChat, message: backgroundTask,
  });
  const outcome = await completed(background.id);
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const mossReply = app.store.messages(mossChat).find((message) => message.role === "assistant" && message.final);
  assert.ok(mossReply, "The second Bot must commit its own final reply");
  const artifact = app.store.list<Artifact>("artifacts").find((file) => file.origin === "delivery");
  assert.ok(artifact, "The second Bot must deliver a real file");
  assert.equal((await readFile(artifact.path)).toString(), delivered);
  const notices = app.store.list<ResultNotification>("notifications");
  assert.equal(notices.length, 1, "Only the finished turn is announced");
  assert.equal(notices[0].taskId, background.id);
  assert.equal(notices[0].messageId, mossReply.id);
  assert.equal(app.service.task(longTurn.id).status, "running");
  scenarios.push("held-work-does-not-block-another-bot-which-commits-its-own-final-file-and-notice");

  const generation = app.kernel.generation;
  const relaunched = new Promise<void>((done) => {
    const changed = (event: RuntimeObservation) => {
      if (event.type !== "ready" || event.generation <= generation) return;
      app!.kernel.off("observation", changed); done();
    };
    app!.kernel.on("observation", changed);
  });
  const pid = app.kernel.processId;
  assert.ok(pid);
  process.kill(pid, "SIGKILL");
  await within(relaunched, "owned native relaunch");
  await app.service.reconcile();
  assert.equal(app.service.task(longTurn.id).status, "interrupted");

  const crashed = app.store.get<Message>("messages", document!.id)!;
  assert.equal(crashed.final, false, "A crash must not invent a final reply");
  assert.equal(JSON.stringify(crashed.blocks).includes(secret), false, "A credential must never reach a document");
  assert.equal(app.store.list<ResultNotification>("notifications").some((notice) => notice.taskId === longTurn.id), false);
  scenarios.push("a-hard-crash-leaves-one-unfinished-document-with-no-invented-final-or-notice");
  const before = { id: crashed.id, runId: crashed.runId!, blocks: crashed.blocks };

  await app.close();
  app = await launch();
  await app.service.reconcile();
  const reopened = app.store.get<Message>("messages", before.id)!;
  assert.deepEqual(reopened.blocks, before.blocks, "The reopened document must match exactly");
  assert.equal(reopened.final, false);
  assert.equal(app.service.task(longTurn.id).status, "interrupted");
  assert.equal(app.store.get<Run>("runs", before.runId)?.state, "interrupted");
  const tool = reopened.blocks.find((block): block is Extract<Block, { kind: "tool" }> => block.kind === "tool")!;
  assert.equal(tool.phase, "result");
  assert.equal(tool.detail?.includes(secret), false);
  scenarios.push("a-full-product-restart-retains-the-exact-ordered-partial-document-unfinished");

  const key = app.store.engineSessionKey(atlasChat, atlas.id);
  const settleDeadline = Date.now() + 15_000;
  let history = await app.kernel.recoverHistory(key);
  while (history.sessionInfo?.hasActiveRun !== false && Date.now() < settleDeadline) {
    await new Promise((done) => setTimeout(done, 100));
    history = await app.kernel.recoverHistory(key);
  }
  assert.equal(history.sessionInfo?.hasActiveRun, false, "The crashed native turn must settle before continuing");
  await app.service.continueTask(longTurn.id, randomUUID());
  const continued = await completed(longTurn.id);
  assert.equal(continued.status, "completed", JSON.stringify(continued));

  const finals = app.store.messages(atlasChat).filter((message) => message.role === "assistant" && message.final);
  assert.equal(finals.length, 1);
  assert.equal(JSON.stringify(finals[0].blocks).includes("SYNTHETIC-LONG-FINAL"), true);
  assert.equal(app.store.get<Message>("messages", before.id)?.final, false, "The interrupted document stays unfinished");
  assert.equal(app.store.get<Run>("runs", before.runId)?.state, "interrupted");
  assert.equal(app.store.list<Task>("tasks").length, 2);
  scenarios.push("an-explicit-continuation-delivers-one-final-without-rewriting-the-interrupted-document");

  evidence.tasks = app.store.list<Task>("tasks");
  evidence.document = app.store.messages(atlasChat);
  evidence.notifications = app.store.list<ResultNotification>("notifications");
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  finished = true;
  for (const response of held) if (!response.destroyed) response.destroy();
  if (app) await app.close().catch(() => {});
  await new Promise<void>((done) => model.close(() => done()));
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
  console.log({ root, scenarios, error: evidence.error });
}
