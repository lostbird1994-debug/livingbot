import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { launchWorkbench } from "./main.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import type { Interaction, Task } from "../../../packages/workbench/src/contracts.ts";
import { SUPER_ADMIN_AGENT_ID } from "../../../packages/workbench/src/system-policy.ts";

// All credentials, servers and model responses in this check are synthetic.
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/connection-credentials-"));
const seed = new WorkbenchStore(join(root, "workbench.sqlite"));
const admin = seed.createBot({ name: "Administrator", agentId: SUPER_ADMIN_AGENT_ID });
seed.close();
const requests: unknown[] = [];
let mcpCalls = 0;
let phase: "configure" | "verify" | "native" = "configure";
let round = 0;
const mcp = createServer(async (request, response) => {
  if (request.headers["x-example-key"] !== "fake-sensitive-value") {
    response.writeHead(401); response.end(); return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (input.id === undefined) { response.writeHead(202); response.end(); return; }
  const result = input.method === "initialize" ? {
    protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-notes", version: "1" },
  } : input.method === "tools/list" ? { tools: [{
    name: "check", description: "Synthetic credential verification",
    inputSchema: { type: "object", properties: {} },
  }] } : input.method === "tools/call" ? (mcpCalls++, { content: [{ type: "text", text: "Synthetic connection verified." }] })
    : {};
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
});
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(input);
  const hasResult = round++ > 0;
  const args = phase === "verify" ? { id: "notes__check", args: {} } : phase === "native" ? {
    id: "secrets", args: { action: "request", name: "EXAMPLE_NATIVE_KEY", kind: "secret", allowedHosts: ["api.example.test"] },
  } : {
    id: "livingbot_configure_credentials", args: { connection: "notes", target: "headers", fields: [{ key: "X-Example-Key", label: "API Key" }] },
  };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish] of [[{
    role: "assistant", ...(hasResult ? { content: "Synthetic configuration complete." } : {
      tool_calls: [{ index: 0, id: randomUUID(), type: "function",
        function: { name: "dispatch_action", arguments: JSON.stringify(args) } }],
    }),
  }, null], [{}, hasResult ? "stop" : "tool_calls"]]) {
    response.write(`data: ${JSON.stringify({
      id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta, finish_reason: finish }],
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
  throw new Error("Synthetic credential check timed out");
}
try {
  app = await launchWorkbench({
    root, localEmbeddings: false, nodeExecutable: process.execPath,
    kernelEntry: resolve("packages/kernel-runtime/node_modules/openclaw/openclaw.mjs"),
    connection: { id: "synthetic", api: "openai-completions", apiKey: "synthetic",
      baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`, model: "synthetic", maxTokens: 1000, contextWindow: 32_000 },
  });
  const token = JSON.parse(await readFile(app.authPath, "utf8")).token;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = (path: string, body: unknown) => fetch(`${app!.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const added = await post("/api/connections", {
    name: "notes", transport: "streamable-http", url: `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`,
  });
  assert.equal(added.status, 201);
  const conversation = app.store.privateConversation(admin.id);
  const task = await app.service.submit({ submissionId: randomUUID(), botId: admin.id, conversationId: conversation.id, message: "Configure connection" });
  const prompt = await until(() => {
    const found = app!.store.list<Interaction>("interactions").find((item) => item.taskId === task.id && item.secureInput?.connection);
    if (!found && ["completed", "failed", "cancelled"].includes(app!.store.get<Task>("tasks", task.id)!.status)) {
      throw new Error("Credential tool ended before presenting its input card");
    }
    return found;
  });
  assert.equal(prompt.status, "pending");
  const route = `/api/tasks/${encodeURIComponent(task.id)}/interactions/${encodeURIComponent(prompt.id)}/credential`;
  const denied = await fetch(`${app.url}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: { "X-Example-Key": "fake-sensitive-value" } }) });
  assert.equal(denied.status, 401);
  const saved = await post(route, { values: { "X-Example-Key": "fake-sensitive-value" } });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).status, "answered");
  await until(() => app!.store.get<Task>("tasks", task.id)?.status === "completed" ? true : undefined);
  phase = "verify"; round = 0;
  const verification = await app.service.submit({ submissionId: randomUUID(), botId: admin.id, conversationId: conversation.id, message: "Verify connection" });
  await until(() => app!.store.get<Task>("tasks", verification.id)?.status === "completed" ? true : undefined);
  assert.equal(mcpCalls, 1, "Saved credential must authenticate a real native MCP call");
  phase = "native"; round = 0;
  const native = await app.service.submit({ submissionId: randomUUID(), botId: admin.id, conversationId: conversation.id, message: "Collect native credential" });
  const nativePrompt = await until(() => app!.store.list<Interaction>("interactions").find((item) =>
    item.taskId === native.id && item.secureInput && !item.secureInput.connection));
  const nativeSaved = await post(`/api/tasks/${encodeURIComponent(native.id)}/interactions/${encodeURIComponent(nativePrompt.id)}/credential`,
    { resolutionId: "native-test", value: "fake-native-sensitive-value" });
  assert.equal(nativeSaved.status, 200);
  await until(() => app!.store.get<Task>("tasks", native.id)?.status === "completed" ? true : undefined);
  const metadata = await app.kernel.request<{ entries: { name: string }[] }>("secrets.store.list", {});
  assert.ok(metadata.entries.some((entry) => entry.name === "EXAMPLE_NATIVE_KEY"));
  assert.ok(!JSON.stringify(requests).includes("fake-sensitive-value"), "Credential must never enter model requests");
  assert.ok(!JSON.stringify(requests).includes("fake-native-sensitive-value"), "Native credential must never enter model requests");
  assert.ok(!JSON.stringify(app.store.snapshot()).includes("fake-sensitive-value"), "Credential must never enter product state");
  const db = await readFile(join(root, "workbench.sqlite"));
  assert.ok(!db.includes(Buffer.from("fake-sensitive-value")), "Product database must not contain credential input");
  const evidence = { passed: true, nativeTool: true, card: true, unauthorizedRejected: true,
    realNativeMcpAuthenticated: true, nativeSecretStorePersistence: true, modelRequestsRedacted: true, root };
  await mkdir("local/validation", { recursive: true });
  await writeFile("local/validation/connection-credentials-native.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, modelRequests: requests.length, mcpCalls }));
} catch (error) {
  await mkdir("local/validation", { recursive: true });
  await writeFile("local/validation/connection-credentials-native-failure.json", JSON.stringify({ root, error: String(error), requests }, null, 2));
  throw error;
} finally {
  await app?.close();
  await Promise.all([model, mcp].map((server) => new Promise<void>((done) => server.close(() => done()))));
}
