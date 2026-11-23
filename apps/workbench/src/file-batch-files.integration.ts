import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchWorkbench } from "./main.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import { Workspaces } from "../../../packages/workbench/src/workspaces.ts";
import type { Artifact, FileBatchReceipt, Task } from "../../../packages/workbench/src/contracts.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-batch-files-"));
const application = join(root, "application");
await mkdir(application);
const seed = new WorkbenchStore(join(application, "workbench.sqlite"));
const bot = seed.createBot({ name: "Atlas", agentId: "atlas" });
const conversation = seed.privateConversation(bot.id);
seed.close();

// Two real files with different content, so each result can only come from its
// own input.
const sources = [
  { name: "门店A-明细.csv", rows: [["华东", 3, 120.5], ["华南", 2, 99.99], ["华东", 5, 120.5]] },
  { name: "门店B-明细.csv", rows: [["华北", 1, 1250], ["华南", 4, 55.25]] },
].map(({ name, rows }) => {
  const text = ["区域,数量,单价", ...rows.map((row) => row.join(","))].join("\n") + "\n";
  const total = rows.reduce((sum, row) => sum + Number(row[1]) * Number(row[2]), 0);
  return { name, text, expected: `# ${name}\n行数：${rows.length}\n金额合计：${total.toFixed(2)}\n` };
});

// The script the Bot runs finds the attachment the runtime materialized for its
// own item and computes from those bytes, not from the chat copy.
const driver = `import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const [workspace, name, output] = process.argv.slice(2);
async function find(directory, wanted) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { const found = await find(path, wanted); if (found) return found; }
    else if (entry.name === wanted) return path;
  }
  return undefined;
}
const source = await find(join(workspace, "inbox"), name);
if (!source) { console.log(JSON.stringify({ missing: name })); process.exit(1); }
const lines = (await readFile(source, "utf8")).trim().split(/\\r?\\n/).slice(1);
const total = lines.reduce((sum, line) => {
  const [, quantity, price] = line.split(",");
  return sum + Number(quantity) * Number(price);
}, 0);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, "# " + name + "\\n行数：" + lines.length + "\\n金额合计：" + total.toFixed(2) + "\\n", "utf8");
console.log(JSON.stringify({ file: name, rows: lines.length, total: total.toFixed(2) }));`;
await writeFile(join(root, "summarize.mjs"), driver, { mode: 0o600 });

const requests: unknown[] = [];
// The second file is refused until the retry action is taken, so its first
// attempt fails while the first file's result already exists.
let secondFileAllowed = false;
let workspaceRoot = "";
function stepsFor(name: string) {
  const output = `tasks/file-batch/${name.replace(/\.csv$/, "")}.md`;
  return [
    { name: "exec", args: {
      command: [process.execPath, join(root, "summarize.mjs"), join(workspaceRoot, bot.agentId), name,
        join(workspaceRoot, bot.agentId, output)].map((part) => `"${part}"`).join(" "),
      host: "gateway", yieldMs: 30_000, timeoutSeconds: 60 } },
    { name: "dispatch_action", args: { id: "livingbot_deliver_file", args: {
      relativePath: output, name: output.split("/").pop(), mediaType: "text/markdown" } } },
  ];
}
async function answer(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const turn = JSON.parse(Buffer.concat(chunks).toString()) as {
    messages: { role: string; content: unknown; tool_calls?: unknown[] }[] };
  requests.push(turn);
  let start = 0;
  for (const [index, message] of turn.messages.entries()) if (message.role === "user") start = index;
  const brief = JSON.stringify(turn.messages);
  // Both items share one conversation, so the item's own brief is the last
  // mention of its name, not the first one from an earlier item.
  const matches = sources
    .map((item) => ({ item, at: brief.lastIndexOf(`本项文件：${item.name}`) }))
    .filter((match) => match.at >= 0)
    .sort((left, right) => right.at - left.at);
  const source = matches[0]?.item;
  assert.ok(source, "each turn names the file it was given");
  // One provider rejection for the second file proves a partial failure; the
  // retry must run only that item.
  if (source.name === sources[1].name && !secondFileAllowed) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Synthetic one-time rejection", type: "invalid_request_error" } }));
    return;
  }
  let calls = 0;
  for (const message of turn.messages.slice(start)) if (message.tool_calls?.length) calls++;
  const call = stepsFor(source.name)[calls];
  response.writeHead(200, { "content-type": "text/event-stream" });
  const delta = call
    ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
    : { role: "assistant", content: `${source.name} 已单独处理并交付。` };
  const frame = JSON.stringify({ id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
    choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] });
  response.write(`data: ${frame}\n\n`);
  response.end("data\n\n");
}
const model = createServer(function route(request, response) {
  void answer(request, response).catch(function failed(error) {
    console.error("model step failed", error);
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: String(error) } }));
  });
});
await new Promise<void>(function listening(done) { model.listen(0, "127.0.0.1", function ready() { done(); }); });

const app = await launchWorkbench({
  root: application, nodeExecutable: process.execPath, kernelEntry: resolve(values["kernel-entry"]!),
  connection: { id: "synthetic", api: "openai-completions", apiKey: "synthetic",
    baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    model: "synthetic", contextWindow: 64_000, maxTokens: 1000 },
});
workspaceRoot = app.paths.workspaces;

function settled(taskIds: string[]): Promise<void> {
  return new Promise<void>(function waiting(done, reject) {
    const timer = setTimeout(function late() { app.store.off("event", changed); reject(new Error("Batch deadline exceeded")); }, 180_000);
    function changed() {
      const states = taskIds.map((id) => app.store.get<Task>("tasks", id)?.status);
      if (states.some((state) => state !== "completed" && state !== "failed" && state !== "interrupted" && state !== "cancelled")) return;
      clearTimeout(timer); app.store.off("event", changed); done();
    }
    app.store.on("event", changed); changed();
  });
}

const scenarios: string[] = [];
let failure: string | undefined;
try {
  const files = app.service.files!;
  const attachments = [];
  for (const source of sources) {
    attachments.push(await files.attach({
      id: randomUUID(), botId: bot.id, conversationId: conversation.id, name: source.name,
      mediaType: "text/csv", bytes: Buffer.from(source.text, "utf8"),
    }));
  }
  const receipt: FileBatchReceipt = await app.service.submitFileBatch({
    id: randomUUID(), botId: bot.id, conversationId: conversation.id,
    instruction: "逐份统计每份文件的行数和金额合计，保留原件，单独交付结果。",
    attachmentIds: attachments.map((file) => file.id),
  });
  assert.equal(receipt.outcomes.length, 2);
  const byName = new Map(receipt.batch.items.map((item) => [item.name, item]));
  const taskOf = (name: string) => byName.get(name)!.taskId;
  await settled([taskOf(sources[0].name), taskOf(sources[1].name)]);

  const first = app.store.get<Task>("tasks", taskOf(sources[0].name))!;
  const second = app.store.get<Task>("tasks", taskOf(sources[1].name))!;
  assert.equal(first.status, "completed");
  assert.equal(second.status, "failed", "the rejected item must fail on its own");
  const firstArtifact = app.store.find<Artifact>("artifacts", "taskId", first.id)
    .find((item) => item.origin === "delivery")!;
  assert.ok(firstArtifact, "the completed item delivers its own file");
  const firstBytes = (await app.service.files!.read(firstArtifact.id)).bytes;
  assert.equal(firstBytes.toString("utf8"), sources[0].expected,
    "the finished file is computed from that item's own input");
  assert.equal(app.store.find<Artifact>("artifacts", "taskId", second.id)
    .filter((item) => item.origin === "delivery").length, 0, "the failed item has no delivery yet");
  const originalBytes = await readFile(join(workspaceRoot, bot.agentId,
    "inbox", attachments[0].id, sources[0].name));
  assert.equal(createHash("sha256").update(originalBytes).digest("hex"),
    createHash("sha256").update(sources[0].text).digest("hex"), "the input file keeps its bytes");
  scenarios.push("two-actual-input-files-produce-their-own-actual-output-files");

  secondFileAllowed = true;
  const retry = await app.service.retryFileBatch(receipt.batch.id, randomUUID());
  assert.deepEqual(retry.outcomes.map((outcome) => outcome.task.id), [second.id],
    "one retry action resumes only the failed item");
  await settled([second.id]);
  const retried = app.store.get<Task>("tasks", second.id)!;
  assert.equal(retried.status, "completed");
  const retriedBatch = app.store.get<NonNullable<typeof receipt.batch>>("fileBatches", receipt.batch.id)!;
  assert.equal(retriedBatch.items.find((item) => item.taskId === second.id)?.retries, 1);
  assert.equal(retriedBatch.items.find((item) => item.taskId === first.id)?.retries, undefined,
    "the item that already succeeded records no retry");
  scenarios.push("a-failed-item-retries-alone-and-records-one-attempt");

  const secondArtifact = app.store.find<Artifact>("artifacts", "taskId", second.id)
    .find((item) => item.origin === "delivery")!;
  const secondBytes = (await app.service.files!.read(secondArtifact.id)).bytes;
  assert.equal(secondBytes.toString("utf8"), sources[1].expected,
    "the retried item's own file is computed from its own input");
  assert.notEqual(createHash("sha256").update(secondBytes).digest("hex"),
    createHash("sha256").update(firstBytes).digest("hex"), "the two results are different files");
  const firstAfter = await app.service.files!.read(firstArtifact.id);
  assert.equal(createHash("sha256").update(firstAfter.bytes).digest("hex"),
    createHash("sha256").update(firstBytes).digest("hex"), "the finished item is not rewritten by the retry");
  assert.equal(app.store.find<Artifact>("artifacts", "taskId", first.id)
    .filter((item) => item.origin === "delivery").length, 1, "the finished item keeps one result");
  for (const [artifact, item] of [[firstArtifact, byName.get(sources[0].name)!],
    [secondArtifact, byName.get(sources[1].name)!]] as const) {
    assert.equal(artifact.taskId, item.taskId, "each delivery belongs to its own batch item task");
    assert.equal(artifact.conversationId, conversation.id);
    assert.ok(artifact.path.includes(item.taskId), "the delivered file lives in that item's task workspace");
  }
  scenarios.push("delivered-files-keep-their-own-task-ownership-and-the-first-result-is-unchanged");
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await app.close();
  model.closeAllConnections();
  await new Promise<void>(function closed(done) { model.close(function stop() { done(); }); });
  await writeFile(join(root, "evidence.json"), JSON.stringify({
    scenarios, failure, expected: sources.map((source) => source.expected), requests,
  }, null, 2), { mode: 0o600, flag: "wx" });
  console.log({ root, scenarios, failure });
}
