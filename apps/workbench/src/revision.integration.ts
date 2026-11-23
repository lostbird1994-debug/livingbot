import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchWorkbench } from "./main.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import { Workspaces } from "../../../packages/workbench/src/workspaces.ts";
import type { Artifact, Message, Task } from "../../../packages/workbench/src/contracts.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-revision-"));
const application = join(root, "application");
await mkdir(application);
const seed = new WorkbenchStore(join(application, "workbench.sqlite"));
const bot = seed.createBot({ name: "Atlas", agentId: "atlas" });
const conversation = seed.privateConversation(bot.id);
seed.close();

// A synthetic contract with CRLF line endings and a phrase that appears twice,
// so the second turn can prove that an ambiguous anchor is refused.
const source = [
  "# 合成合同", "", "## 付款", "分三期支付，首期 30%。", "", "## 交付", "3 月 1 日交付，交付前需书面确认。",
  "", "## 违约", "按日计罚，首期 30% 为计算基准。", "", "## 附则", "本附则保持原样，不得改动。", "",
].join("\r\n");
const anchor = "3 月 1 日交付，交付前需书面确认。";
const replacement = "3 月 15 日交付，交付前需书面确认并经双方签字。";
const revised = source.replace(anchor, replacement);
const relativePath = "projects/revision/contract.md";
const finals: Record<string, string> = {
  revise: "已按批注修订交付段落并交付新版本，原件与其他章节保持不变。",
  ambiguous: "首期比例在合同中出现了两次，无法确定位置，因此没有改动任何内容。",
};

const requests: unknown[] = [];
let scenario = "revise";
type Step = { name: string; args: Record<string, unknown> };

function called(step: Step) {
  return { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function",
    function: { name: step.name, arguments: JSON.stringify(step.args) } }] };
}

function stream(response: ServerResponse, step: Step | undefined) {
  const delta = step ? called(step) : { role: "assistant", content: finals[scenario] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  const frames: [unknown, string | null][] = [[delta, null], [{}, step ? "tool_calls" : "stop"]];
  for (const [part, finish] of frames) {
    const chunk = { id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta: part, finish_reason: finish }] };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("done\n\n");
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    // Steps are counted per turn: a new user message starts the sequence again.
    const latest = requests[requests.length - 1] as { messages: { role: string; tool_calls?: unknown[] }[] };
    let turnStart = 0;
    for (const [index, message] of latest.messages.entries()) if (message.role === "user") turnStart = index;
    let returned = 0;
    for (const message of latest.messages.slice(turnStart)) if (message.tool_calls?.length) returned++;
    const revise = { id: "livingbot_revise_document", args: { relativePath, anchor, replacement } };
    const duplicate = { id: "livingbot_revise_document",
      args: { relativePath, anchor: "首期 30%", replacement: "首期 20%" } };
    const steps: Step[] = scenario === "revise"
      ? [{ name: "tool_search", args: { query: "revise one passage of a document", limit: 8 } },
        { name: "dispatch_action", args: revise }]
      : [{ name: "dispatch_action", args: duplicate }];
    stream(response, steps[returned]);
  } catch (error) {
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: String(error) } }));
  }
}

const model = createServer(handle);
await new Promise<void>((done) => model
  .listen(0, "127.0.0.1", function ready() { done(); }));

let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
const scenarios: string[] = [];
let failure: string | undefined;

async function launch() {
  return launchWorkbench({
    root: application, nodeExecutable: process.execPath, kernelEntry: resolve(values["kernel-entry"]!),
    connection: {
      id: "synthetic", api: "openai-completions", apiKey: "synthetic",
      baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      model: "synthetic", contextWindow: 64_000, maxTokens: 1000,
    },
  });
}

/** Wait for a task to end; a refused tool call may legitimately end either way. */
async function settle(task: Task): Promise<string> {
  return new Promise<string>((done, reject) => {
    const store = app!.store;
    const timer = setTimeout(() => { store.off("event", changed); reject(new Error("Revision task deadline exceeded")); }, 90_000);
    function changed() {
      const state = store.get<Task>("tasks", task.id)?.status;
      if (state !== "completed" && state !== "failed") return;
      clearTimeout(timer); store.off("event", changed);
      done(state);
    }
    store.on("event", changed); changed();
  });
}

function toolMessages(input: unknown) {
  const messages = (input as { messages: { role: string; content: unknown }[] }).messages;
  return JSON.stringify(messages.filter((message) => message.role === "tool"));
}

try {
  app = await launch();
  await new Workspaces(app.paths.workspaces).write(bot.agentId, "projects", "revision/contract.md", source);
  const first = await app.service.submit({
    submissionId: randomUUID(), botId: bot.id, conversationId: conversation.id,
    message: "按批注把合同的交付日期改为 3 月 15 日，其余章节不要动，原件请保留。",
  });
  assert.equal(await settle(first), "completed");
  const artifacts = app.store.find<Artifact>("artifacts", "taskId", first.id);
  assert.equal(artifacts.length, 1, JSON.stringify(artifacts));
  assert.equal(artifacts[0].mediaType, "text/markdown");
  assert.equal(artifacts[0].name, "contract.md");
  const delivered = (await app.service.files!.read(artifacts[0].id)).bytes.toString();
  // Only the anchored passage changed; every other byte, including CRLF, survives.
  assert.equal(delivered, revised);
  assert.ok(delivered.includes("## 违约\r\n按日计罚，首期 30% 为计算基准。"));
  assert.ok(delivered.includes("## 附则\r\n本附则保持原样，不得改动。"));
  // The user's original is still exactly as it was, inside the workspace.
  assert.equal(await readFile(join(app.paths.workspaces, bot.agentId, relativePath), "utf8"), source);
  const cards = app.store.messages(conversation.id).filter((message: Message) =>
    message.blocks.some((block) => block.kind === "file" && block.artifactId === artifacts[0].id));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].taskId, first.id);
  assert.ok(toolMessages(requests[1]).includes("livingbot_revise_document"), "tool_search must find the revision tool");
  assert.ok(JSON.stringify(requests).includes(artifacts[0].digest), "the tool result must name the new version digest");
  scenarios.push("native-tool-search-finds-livingbot-revise-document-and-the-call-changes-one-passage");

  scenario = "ambiguous";
  const second = await app.service.submit({
    submissionId: randomUUID(), botId: bot.id, conversationId: conversation.id, message: "把首期比例改成 20%。",
  });
  assert.equal(await settle(second), "completed");
  assert.equal(app.store.find<Artifact>("artifacts", "taskId", second.id).length, 0);
  assert.equal(app.store.list("artifacts").length, 1);
  // The refusal must be the anchored-revision error, not the tool description.
  assert.ok(toolMessages(requests[requests.length - 1]).includes("appears more than once; revise a unique passage"));
  assert.equal(await readFile(join(app.paths.workspaces, bot.agentId, relativePath), "utf8"), source);
  scenarios.push("native-ambiguous-anchor-is-refused-without-writing-or-delivering");

  const calls = requests.length;
  await app.close();
  app = await launch();
  assert.equal((await app.service.files!.read(artifacts[0].id)).bytes.toString(), revised);
  assert.equal(await readFile(join(app.paths.workspaces, bot.agentId, relativePath), "utf8"), source);
  assert.equal(app.store.get<Task>("tasks", first.id)?.status, "completed");
  assert.equal(requests.length, calls);
  scenarios.push("full-restart-retains-the-delivered-version-and-the-untouched-source");
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  model.closeAllConnections();
  await new Promise<void>((done) => model.close(function closed() { done(); }));
  await writeFile(join(root, "evidence.json"), JSON.stringify({ scenarios, failure, requests }, null, 2), { mode: 0o600, flag: "wx" });
  console.log({ root, scenarios, failure });
}
