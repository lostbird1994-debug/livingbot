import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { launchWorkbench } from "./main.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import type { Message, Task } from "../../../packages/workbench/src/contracts.ts";

// Exercise a real, isolated native kernel and test Bot with an offline model/MCP.
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/interrupted-replies-"));
const seed = new WorkbenchStore(join(root, "workbench.sqlite"));
const bot = seed.createBot({ name: "Interruption Test Bot", agentId: "interruption-test" });
const conversation = seed.privateConversation(bot.id);
seed.close();
const releases: (() => void)[] = [];
const requests: { messages: { role: string; content: unknown }[] }[] = [];
const terminals: unknown[] = [];
let calls = 0;
const mcp = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (input.id === undefined) { response.writeHead(202); response.end(); return; }
  const result = input.method === "initialize" ? {
    protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "pause", version: "1" },
  } : input.method === "tools/list" ? { tools: [{
    name: "wait", description: "Wait for a deterministic test signal",
    inputSchema: { type: "object", properties: {} },
  }] } : input.method === "tools/call" ? await new Promise((done) => {
    releases.push(() => done({ content: [{ type: "text", text: "Released" }] }));
  }) : {};
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
});
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  const round = calls++;
  const text = ["BEFORE", "BETWEEN", "AFTER"][round];
  response.writeHead(200, { "content-type": "text/event-stream" });
  const delta = { role: "assistant", content: text, ...(round < 2 ? {
    tool_calls: [{ index: 0, id: randomUUID(), type: "function",
      function: { name: "dispatch_action", arguments: JSON.stringify({ id: "pause__wait", args: {} }) } }],
  } : {}) };
  for (const [part, finish] of [[delta, null], [{}, round < 2 ? "tool_calls" : "stop"]]) {
    response.write(`data: ${JSON.stringify({
      id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta: part, finish_reason: finish }],
    })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});
await Promise.all([model, mcp].map((server) => new Promise<void>((done) => server.listen(0, "127.0.0.1", done))));
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
async function until<T>(read: () => T | undefined, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Interruption test timed out");
}
const text = (message: Message) => message.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("");
try {
  app = await launchWorkbench({
    root, localEmbeddings: false, nodeExecutable: process.execPath,
    kernelEntry: resolve("packages/kernel-runtime/node_modules/openclaw/openclaw.mjs"),
    connection: { id: "synthetic", api: "openai-completions", apiKey: "synthetic",
      baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`, model: "synthetic", maxTokens: 1000, contextWindow: 32_000 },
  });
  app.kernel.on("observation", (observation) => {
    if (observation.type === "frame" && observation.frame.event === "chat" && observation.frame.payload?.state === "final") {
      terminals.push(observation.frame.payload);
    }
  });
  const { token } = JSON.parse(await readFile(app.authPath, "utf8"));
  const added = await fetch(`${app.url}/api/connections`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "pause", transport: "streamable-http", url: `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp` }),
  });
  assert.equal(added.status, 201);
  const input = { botId: bot.id, conversationId: conversation.id };
  const first = await app.service.submit({ ...input, submissionId: randomUUID(), message: "START" });
  await until(() => releases.length === 1 ? true : undefined);
  await until(() => app!.store.messages(conversation.id).some((message) => text(message) === "BEFORE") ? true : undefined);
  const second = await app.service.submit({ ...input, submissionId: randomUUID(), message: "INTERRUPT_ONE" });
  releases[0]();
  await until(() => releases.length === 2 ? true : undefined);
  await until(() => app!.store.messages(conversation.id).some((message) => text(message) === "BETWEEN") ? true : undefined);
  const third = await app.service.submit({ ...input, submissionId: randomUUID(), message: "INTERRUPT_TWO" });
  releases[1]();
  await until(() => app!.store.get<Task>("tasks", first.id)?.status === "completed" ? true : undefined);
  await app.service.reconcile();
  const expected = ["START", "BEFORE", "INTERRUPT_ONE", "BETWEEN", "INTERRUPT_TWO", "AFTER"];
  const messages = app.store.messages(conversation.id);
  assert.deepEqual(messages.map(text), expected);
  assert.equal(app.store.get<Task>("tasks", second.id)?.inputDisposition, "steered");
  assert.equal(app.store.get<Task>("tasks", third.id)?.inputDisposition, "steered");
  assert.equal(calls, 3, "Interruptions must not dispatch independent model turns");
  // Verify observable delivery to the model, not its natural-language interpretation.
  assert.ok(JSON.stringify(requests[1].messages).includes("INTERRUPT_ONE"));
  assert.ok(JSON.stringify(requests[2].messages).includes("INTERRUPT_TWO"));
  const parts = messages.filter((message) => message.role === "assistant");
  assert.equal(new Set(parts.map((message) => message.runId)).size, 1);
  await app.service.reconcile();
  assert.deepEqual(app.store.messages(conversation.id).map(text), expected);
  await app.close(); app = undefined;
  const reopened = new WorkbenchStore(join(root, "workbench.sqlite"));
  try {
    assert.deepEqual(reopened.messages(conversation.id).map(text), expected);
    assert.deepEqual(reopened.messages(conversation.id).map((message) => message.id), messages.map((message) => message.id));
  } finally { reopened.close(); }
  await mkdir("local/validation", { recursive: true });
  await writeFile("local/validation/interrupted-replies-native.json", JSON.stringify({
    passed: true, root, modelCalls: calls, interruptions: 2, nativeSteering: true,
    modelInputConfirmed: true, stableReplay: true, stableReopen: true,
  }, null, 2));
  console.log(JSON.stringify({ passed: true, modelCalls: calls, interruptions: 2, stableReopen: true }));
} catch (error) {
  await mkdir("local/validation", { recursive: true });
  await writeFile("local/validation/interrupted-replies-native-failure.json", JSON.stringify({
    root, error: String(error), calls, releaseCount: releases.length, terminals,
    tasks: app?.store.list<Task>("tasks").map((task) => ({ status: task.status, error: task.error, inputDisposition: task.inputDisposition })),
    messages: app?.store.messages(conversation.id).map((message) => ({ id: message.id, text: text(message), blocks: message.blocks })),
  }, null, 2));
  throw error;
} finally {
  for (const release of releases) release();
  await app?.close();
  await Promise.all([model, mcp].map((server) => new Promise<void>((done) => server.close(() => done()))));
}
