import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchWorkbench } from "./main.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import { Workspaces } from "../../../packages/workbench/src/workspaces.ts";
import type { Artifact, Message, Task } from "../../../packages/workbench/src/contracts.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-table-"));
const application = join(root, "application");
await mkdir(application);
const seed = new WorkbenchStore(join(application, "workbench.sqlite"));
const bot = seed.createBot({ name: "Atlas", agentId: "atlas" });
const conversation = seed.privateConversation(bot.id);
seed.close();

// Known input: two rows in 华东, plus 华南 and 华北; a leading-zero batch code and
// a quoted comma must survive both directions.
const rows = [
  ["华东", 3, 120.5, "000123", ""],
  ["华南", 2, 99.99, "000456", "含,逗号"],
  ["华东", 5, 120.5, "000789", ""],
  ["华北", 1, 1250, "000234", ""],
];
const quote = (value: string) => (/[",\n]/.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value);
const sourceCsv = ["区域,数量,单价,批次编号,备注",
  ...rows.map((row) => row.map((cell) => quote(String(cell))).join(","))].join("\n") + "\n";
const totals = new Map<string, { rows: number; quantity: number; amount: number }>();
for (const row of rows) {
  const region = String(row[0]);
  const current = totals.get(region) ?? { rows: 0, quantity: 0, amount: 0 };
  current.rows += 1;
  current.quantity += Number(row[1]);
  current.amount += Number(row[1]) * Number(row[2]);
  totals.set(region, current);
}
const expectedCsv = ["区域,行数,数量合计,金额合计",
  ...[...totals.keys()].sort().map((region) => {
    const total = totals.get(region)!;
    return [region, String(total.rows), String(total.quantity), total.amount.toFixed(2)].join(",");
  })].join("\n") + "\n";

// The transform the Bot runs is an ordinary script, not a spreadsheet engine.
const transform = `import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const [input, output] = process.argv.slice(2);
const text = await readFile(input, "utf8");
const lines = text.trim().split(/\\r?\\n/).slice(1);
const parse = (line) => {
  const cells = []; let cell = ""; let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted && char === '"' && line[index + 1] === '"') { cell += '"'; index++; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === "," && !quoted) { cells.push(cell); cell = ""; continue; }
    cell += char;
  }
  cells.push(cell);
  return cells;
};
const totals = new Map();
for (const line of lines) {
  const [region, quantity, price] = parse(line);
  const current = totals.get(region) ?? { rows: 0, quantity: 0, amount: 0 };
  current.rows += 1; current.quantity += Number(quantity);
  current.amount += Number(quantity) * Number(price);
  totals.set(region, current);
}
const body = [...totals.keys()].sort().map((region) => {
  const total = totals.get(region);
  return [region, total.rows, total.quantity, total.amount.toFixed(2)].join(",");
});
await mkdir(dirname(output), { recursive: true });
await writeFile(output, ["区域,行数,数量合计,金额合计", ...body].join("\\n") + "\\n", "utf8");
console.log(JSON.stringify({ rows: lines.length, regions: totals.size }));`;
await writeFile(join(root, "transform.mjs"), transform, { mode: 0o600 });

const requests: unknown[] = [];
const sourceRelative = "inbox/sales-2026Q3.csv";
const resultRelative = "tasks/table-review/summary.csv";
let workspaceRoot = "";
const command = () => [process.execPath, join(root, "transform.mjs"),
  join(workspaceRoot, bot.agentId, sourceRelative), join(workspaceRoot, bot.agentId, resultRelative)]
  .map((part) => `"${part}"`).join(" ");
const steps = [
  { name: "read", args: { path: sourceRelative } },
  { name: "exec", args: { command: "", host: "gateway", yieldMs: 30_000, timeoutSeconds: 60 } },
  { name: "dispatch_action", args: { id: "livingbot_deliver_file", args: {
    relativePath: resultRelative, name: "summary.csv", mediaType: "text/csv" } } },
];
async function answer(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  const turn = requests[requests.length - 1] as { messages: { role: string; tool_calls?: unknown[] }[] };
  let start = 0;
  for (const [index, message] of turn.messages.entries()) if (message.role === "user") start = index;
  let calls = 0;
  for (const message of turn.messages.slice(start)) if (message.tool_calls?.length) calls++;
  const step = steps[calls];
  const call = step ? { name: step.name, args: step.name === "exec" ? { ...step.args, command: command() } : step.args } : undefined;
  response.writeHead(200, { "content-type": "text/event-stream" });
  const delta = call
    ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
    : { role: "assistant", content: "已按区域汇总数量与金额，原件保留，结果已交付。" };
  const frame = JSON.stringify({ id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
    choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] });
  response.write(`data: ${frame}\n\n`);
  response.end("data\n\n");
}
const model = createServer(function route(request, response) {
  void answer(request, response).catch(function failed(error) {
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
const scenarios: string[] = [];
let failure: string | undefined;
try {
  await new Workspaces(workspaceRoot).write(bot.agentId, "inbox", "sales-2026Q3.csv", sourceCsv);
  const task = await app.service.submit({
    submissionId: randomUUID(), botId: bot.id, conversationId: conversation.id,
    message: "把这份销量表按区域汇总数量和金额，保留原件并交付结果表。",
  });
  await new Promise<void>(function settling(done, reject) {
    const timer = setTimeout(function late() { app.store.off("event", changed); reject(new Error("Table deadline exceeded")); }, 120_000);
    function changed() {
      const state = app.store.get<Task>("tasks", task.id)?.status;
      if (state !== "completed" && state !== "failed") return;
      clearTimeout(timer); app.store.off("event", changed);
      if (state === "completed") done(); else reject(new Error(`Table task ${state}`));
    }
    app.store.on("event", changed); changed();
  });
  const artifact = app.store.find<Artifact>("artifacts", "taskId", task.id)[0];
  assert.ok(artifact, "the batch result must be delivered as an artifact");
  assert.equal(artifact.name, "summary.csv");
  assert.equal(artifact.mediaType, "text/csv");
  const delivered = (await app.service.files!.read(artifact.id)).bytes.toString("utf8");
  // Expected bytes come from the fixture's own totals, not from the Bot's output.
  assert.equal(delivered, expectedCsv);
  assert.equal(delivered.split("\n").filter(Boolean).length, 4, "header plus three regions");
  const written = await readFile(join(workspaceRoot, bot.agentId, resultRelative), "utf8");
  assert.equal(written, expectedCsv);
  const original = await readFile(join(workspaceRoot, bot.agentId, sourceRelative), "utf8");
  assert.equal(original, sourceCsv, "the input table is retained byte for byte");
  scenarios.push("native-turn-computes-a-known-csv-summary-with-real-bytes-and-keeps-the-source");
  const cards = app.store.messages(conversation.id).filter((message: Message) =>
    message.blocks.some((block) => block.kind === "file" && block.artifactId === artifact.id));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].taskId, task.id);
  scenarios.push("the-produced-table-is-delivered-as-a-real-downloadable-file-card");
  // Tool results are read as the model saw them, not through a JSON escape layer.
  const transcript = requests.flatMap((entry) => (entry as { messages: { role: string; content: unknown }[] }).messages
    .filter((message) => message.role === "tool").map((message) => String(message.content))).join("\n");
  assert.ok(transcript.includes("\"rows\":4") && transcript.includes("\"regions\":3"), "the script reported the rows it read");
  assert.ok(transcript.includes("批次编号") && transcript.includes("000123"), "the turn read the actual input table");
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await app.close();
  model.closeAllConnections();
  await new Promise<void>(function closed(done) { model.close(function stop() { done(); }); });
  await writeFile(join(root, "evidence.json"), JSON.stringify({
    scenarios, failure, expectedCsv, requests,
  }, null, 2), { mode: 0o600, flag: "wx" });
  console.log({ root, scenarios, failure });
}
