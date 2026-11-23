import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchWorkbench } from "./main.ts";
import { preparePaths, runtimePaths } from "../../../packages/kernel-runtime/src/paths.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import type { Ability, Bot, Task } from "../../../packages/workbench/src/contracts.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-connections-"));
const paths = runtimePaths(join(root, "application"));
await preparePaths(paths);
const seed = new WorkbenchStore(join(paths.root, "workbench.sqlite"));
const first = seed.createBot({ name: "Atlas", agentId: "atlas" });
const second = seed.createBot({ name: "Moss", agentId: "moss" });
const existingGroup = seed.createConversation("group", [first.id, second.id], "Synthetic group");
seed.close();
const mcpRequests: { method: string; params?: unknown; path?: string }[] = [];
const modelRequests: unknown[] = [];
let modelToolId = "evidence__lookup";
const mcp = createServer(async (request, response) => {
  if (request.method === "DELETE") { response.writeHead(200); response.end(); return; }
  if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
  if (request.headers.authorization !== "Bearer synthetic-private-value") {
    response.writeHead(401); response.end(); return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString());
  mcpRequests.push({ ...input, path: request.url });
  if (input.id === undefined) { response.writeHead(202); response.end(); return; }
  let result: unknown;
  if (input.method === "initialize") result = {
    protocolVersion: input.params.protocolVersion, capabilities: { tools: {} },
    serverInfo: { name: "synthetic-evidence", version: "1.0.0" },
  };
  else if (input.method === "tools/list") result = { tools: [{
    name: "lookup", description: "Read synthetic evidence",
    inputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] },
  }] };
  else if (input.method === "tools/call") result = { content: [{ type: "text", text: "SYNTHETIC-EVIDENCE-7832" }] };
  else if (input.method === "resources/list") result = { resources: [] };
  else if (input.method === "prompts/list") result = { prompts: [] };
  else result = {};
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
});
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString());
  modelRequests.push(input);
  const messages = input.messages as { role: string; content: unknown }[];
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const resultReceived = messages.slice(lastUser + 1).some((message) => message.role === "tool");
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish] of [[{
    role: "assistant", ...(resultReceived ? { content: "Synthetic protocol check complete." } : {
      tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: {
        name: "dispatch_action", arguments: JSON.stringify({
          id: modelToolId, args: { marker: "NATIVE-CONNECTION-TEST" },
        }),
      } }],
    }),
  }, null], [{}, resultReceived ? "stop" : "tool_calls"]]) {
    response.write(`data: ${JSON.stringify({
      id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});
await Promise.all([mcp, model].map((server) => new Promise<void>((done) => server.listen(0, "127.0.0.1", done))));
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
const evidence: { scenarios: string[]; mcpRequests: unknown[]; error?: string } = { scenarios: [], mcpRequests };
async function turn(bot: Bot, target = "EVIDENCE", conversationId?: string) {
  modelToolId = target === "UNCHANGED" ? "unchanged__lookup" : "evidence__lookup";
  const conversation = conversationId ? { id: conversationId } : app!.store.privateConversation(bot.id);
  const task = await app!.service.submit({
    submissionId: randomUUID(), conversationId: conversation.id, botId: bot.id, message: `Check synthetic evidence ${target} ${randomUUID()}`,
  });
  return new Promise<Task>((done, reject) => {
    const timer = setTimeout(() => { app!.store.off("event", changed); reject(new Error("Connection task deadline exceeded")); }, 45_000);
    function changed() {
      const current = app!.service.task(task.id);
      if (!["completed", "failed", "cancelled"].includes(current.status)) return;
      clearTimeout(timer); app!.store.off("event", changed);
      if (current.status === "completed") done(current); else reject(new Error(`Connection task ${current.status}`));
    }
    app!.store.on("event", changed); changed();
  });
}
function tool(items: Ability[]) {
  const entry = items.find((item) =>
    (item.configuration?.native as { nativeName?: string } | undefined)?.nativeName === "evidence__lookup");
  assert.ok(entry, "Native MCP tool must be discovered");
  return entry;
}
try {
  app = await launchWorkbench({
    root: paths.root, kernelEntry: resolve(values["kernel-entry"]), nodeExecutable: process.execPath,
    connection: {
      id: "synthetic", baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      api: "openai-completions", apiKey: "synthetic", model: "synthetic", contextWindow: 32_000, maxTokens: 1000,
    },
  });
  const token = JSON.parse(await readFile(app.authPath, "utf8")).token;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const added = await fetch(`${app.url}/api/connections`, { method: "POST", headers, body: JSON.stringify({
    name: "evidence", transport: "streamable-http", url: `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`,
    headers: { Authorization: "Bearer synthetic-private-value" },
  }) });
  assert.equal(added.status, 201, await added.text());
  const cold = await app.service.abilities!.refresh(first.id);
  const configured = cold.find((ability) => ability.name === "evidence")!;
  assert.ok(configured);
  assert.equal(configured.access?.[first.id].ready, false);
  assert.equal(mcpRequests.length, 0);
  assert.equal(modelRequests.length, 0);
  assert.ok(!JSON.stringify(cold).includes("synthetic-private-value"));
  evidence.scenarios.push("native-configured-service-visible-without-model-turn-or-network-probe");

  await app.service.abilities!.setEnabled(configured.id, first.id, false);
  await turn(first);
  await turn(first, "EVIDENCE", existingGroup.id);
  assert.equal(mcpRequests.length, 0);
  const coldSessions = await app.kernel.request<{ sessions: { key: string; kind?: string; chatType?: string }[] }>("sessions.list", {});
  const coldGroup = coldSessions.sessions.find((session) => session.key === app!.store.engineSessionKey(existingGroup.id, first.id));
  assert.ok(coldGroup?.kind === "group" || coldGroup?.chatType === "group", "Service policy must preserve native group classification");
  const coldPrivate = coldSessions.sessions.find((session) =>
    session.key === app!.store.engineSessionKey(app!.store.privateConversation(first.id).id, first.id));
  assert.equal(coldPrivate?.chatType, "direct", "Service policy must preserve native private recall classification");
  await app.service.abilities!.setEnabled(configured.id, first.id, true);
  evidence.scenarios.push("cold-per-bot-service-denial-prevents-discovery-in-private-and-group-with-group-classification-preserved");

  await turn(first);
  assert.equal(mcpRequests.filter((request) => request.method === "tools/call").length, 1);
  const firstTool = tool(await app.service.abilities!.refresh(first.id));
  assert.equal(firstTool.access?.[first.id].ready, true);
  evidence.scenarios.push("native-first-turn-discovers-and-executes-configured-service-tool");

  await app.service.abilities!.setEnabled(firstTool.id, first.id, false);
  await turn(first);
  assert.equal(mcpRequests.filter((request) => request.method === "tools/call").length, 1);
  await turn(second);
  assert.equal(mcpRequests.filter((request) => request.method === "tools/call").length, 2);
  evidence.scenarios.push("per-bot-native-tool-denial-blocks-dispatch-without-denying-another-bot");

  const disabled = await fetch(`${app.url}/api/connections/evidence/access`, {
    method: "POST", headers, body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disabled.status, 200, await disabled.text());
  const inventory = await app.service.abilities!.refresh(second.id);
  assert.equal(inventory.find((ability) => ability.name === "evidence")?.access?.[second.id].enabled, false);
  await turn(second);
  assert.equal(mcpRequests.filter((request) => request.method === "tools/call").length, 2);
  evidence.scenarios.push("global-disable-retires-service-and-blocks-further-native-execution");

  await app.kernel.restart();
  const listed = await fetch(`${app.url}/api/connections`, { headers });
  assert.equal((await listed.json()).find((entry: { name: string }) => entry.name === "evidence").enabled, false);
  assert.equal((await app.service.abilities!.refresh(first.id)).find((ability) => ability.name === "evidence")?.access?.[first.id].ready, false);
  evidence.scenarios.push("native-service-configuration-and-disabled-state-survive-restart");
  const restoredTool = tool(await app.service.abilities!.refresh(first.id));
  assert.equal(restoredTool.access?.[first.id].enabled, false);
  const enabled = await fetch(`${app.url}/api/connections/evidence/access`, {
    method: "POST", headers, body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enabled.status, 200, await enabled.text());
  await app.service.abilities!.setEnabled(restoredTool.id, first.id, true);
  await turn(first);
  assert.equal(mcpRequests.filter((request) => request.method === "tools/call").length, 3);
  evidence.scenarios.push("retained-disabled-tool-can-be-reenabled-after-restart-and-connection-credentials-remain-valid");
  const baseUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}`;
  const unchanged = await fetch(`${app.url}/api/connections`, { method: "POST", headers, body: JSON.stringify({
    name: "unchanged", transport: "streamable-http", url: `${baseUrl}/other`,
    headers: { Authorization: "Bearer synthetic-private-value" },
  }) });
  assert.equal(unchanged.status, 201, await unchanged.text());
  await turn(first, "UNCHANGED");
  assert.equal(mcpRequests.filter((entry) => entry.path === "/other" && entry.method === "tools/call").length, 1);
  const unchangedInitializations = mcpRequests.filter((entry) => entry.path === "/other" && entry.method === "initialize").length;
  assert.ok(unchangedInitializations);
  const edited = await fetch(`${app.url}/api/connections/evidence/update`, {
    method: "POST", headers, body: JSON.stringify({ url: `${baseUrl}/updated` }),
  });
  assert.equal(edited.status, 200, await edited.text());
  const oldCalls = mcpRequests.filter((entry) => entry.path === "/mcp" && entry.method === "tools/call").length;
  await turn(first);
  assert.equal(mcpRequests.filter((entry) => entry.path === "/updated" && entry.method === "tools/call").length, 1);
  assert.equal(mcpRequests.filter((entry) => entry.path === "/mcp" && entry.method === "tools/call").length, oldCalls);
  await turn(first, "UNCHANGED");
  assert.equal(mcpRequests.filter((entry) => entry.path === "/other" && entry.method === "tools/call").length, 2);
  assert.equal(mcpRequests.filter((entry) => entry.path === "/other" && entry.method === "initialize").length, unchangedInitializations);
  evidence.scenarios.push("native-service-edit-uses-new-endpoint-preserves-credentials-and-keeps-unrelated-runtime");

  const local = await fetch(`${app.url}/api/connections`, { method: "POST", headers, body: JSON.stringify({
    name: "unused-local", transport: "stdio", command: process.execPath, args: ["--version"], env: { KEY: "synthetic" },
  }) });
  assert.equal(local.status, 201, await local.text());
  const localRemoved = await fetch(`${app.url}/api/connections/unused-local/remove`, {
    method: "POST", headers, body: '{"confirmed":true}',
  });
  assert.equal(localRemoved.status, 200, await localRemoved.text());
  const nativeRemoved = await app.kernel.request<{ config: { mcp: { servers: Record<string, unknown> } } }>("config.get", {});
  assert.deepEqual(nativeRemoved.config.mcp.servers["unused-local"], { enabled: false });
  evidence.scenarios.push("native-local-removal-clears-arguments-and-environment-with-explicit-array-intent");

  const removed = await fetch(`${app.url}/api/connections/evidence/remove`, {
    method: "POST", headers, body: '{"confirmed":true}',
  });
  assert.equal(removed.status, 200, await removed.text());
  const beforeDenied = mcpRequests.filter((entry) => entry.path === "/updated" && entry.method === "tools/call").length;
  await turn(first);
  assert.equal(mcpRequests.filter((entry) => entry.path === "/updated" && entry.method === "tools/call").length, beforeDenied);
  const cleared = await app.kernel.request<typeof nativeRemoved>("config.get", {});
  assert.deepEqual(cleared.config.mcp.servers.evidence, { enabled: false });
  const remaining = await app.service.abilities!.refresh(first.id);
  assert.ok(!remaining.some((ability) => ability.source === "evidence" || ability.name === "evidence"));
  await turn(first, "UNCHANGED");
  assert.equal(mcpRequests.filter((entry) => entry.path === "/other" && entry.method === "tools/call").length, 3);
  assert.equal(mcpRequests.filter((entry) => entry.path === "/other" && entry.method === "initialize").length, unchangedInitializations);
  evidence.scenarios.push("native-removal-clears-credentials-blocks-dispatch-and-preserves-unrelated-service");

  await app.kernel.restart();
  const afterRemoval = await fetch(`${app.url}/api/connections`, { headers });
  assert.ok(!(await afterRemoval.json()).some((entry: { name: string }) => entry.name === "evidence"));
  assert.ok(!(await app.service.abilities!.refresh(first.id)).some((ability) => ability.source === "evidence" || ability.name === "evidence"));
  evidence.scenarios.push("native-removal-and-hidden-stale-tool-state-survive-restart");
  const readded = await fetch(`${app.url}/api/connections`, { method: "POST", headers, body: JSON.stringify({
    name: "evidence", transport: "streamable-http", url: `${baseUrl}/updated`,
    headers: { Authorization: "Bearer synthetic-private-value" },
  }) });
  assert.equal(readded.status, 201, await readded.text());
  await turn(first);
  assert.equal(mcpRequests.filter((entry) => entry.path === "/updated" && entry.method === "tools/call").length, beforeDenied + 1);
  evidence.scenarios.push("explicit-readd-of-removed-service-restores-native-discovery-and-execution");

  const service = (await app.service.abilities!.refresh(first.id)).find((entry) => entry.name === "evidence")!;
  assert.ok(service);
  await app.service.abilities!.setEnabled(service.id, first.id, false);
  const privateConversation = app.store.createConversation("private", [first.id], "New synthetic private");
  const groupConversation = app.store.createConversation("group", [first.id, second.id], "New synthetic group");
  const serviceCalls = () => mcpRequests.filter((entry) => entry.method === "tools/call" && entry.path === "/updated").length;
  const beforePolicy = serviceCalls();
  await turn(first);
  await turn(first, "EVIDENCE", existingGroup.id);
  await turn(first, "EVIDENCE", privateConversation.id);
  await turn(first, "EVIDENCE", groupConversation.id);
  assert.equal(serviceCalls(), beforePolicy);
  await turn(second, "EVIDENCE", groupConversation.id);
  assert.equal(serviceCalls(), beforePolicy + 1);
  evidence.scenarios.push("whole-service-denial-covers-existing-and-new-private-and-group-conversations-without-denying-other-bot");

  await app.close();
  app = undefined;
  app = await launchWorkbench({
    root: paths.root, kernelEntry: resolve(values["kernel-entry"]), nodeExecutable: process.execPath,
  });
  const reopenedGroup = app.store.createConversation("group", [first.id, second.id], "After restart group");
  await turn(first, "EVIDENCE", reopenedGroup.id);
  assert.equal(serviceCalls(), beforePolicy + 1);
  assert.equal((await app.service.abilities!.refresh(first.id)).find((entry) => entry.id === service.id)?.access?.[first.id].enabled, false);
  const sessions = await app.kernel.request<typeof coldSessions>("sessions.list", {});
  const newGroup = sessions.sessions.find((session) => session.key === app!.store.engineSessionKey(reopenedGroup.id, first.id));
  assert.ok(newGroup?.kind === "group" || newGroup?.chatType === "group");
  evidence.scenarios.push("durable-per-bot-service-denial-survives-product-and-kernel-restart-and-applies-to-new-groups");

  await app.service.abilities!.setEnabled(service.id, first.id, true);
  const inherited = await app.kernel.request<{ session: { toolOverrides?: { mcpServers?: Record<string, boolean> } } }>(
    "sessions.describe", { key: app.store.engineSessionKey(reopenedGroup.id, first.id), agentId: first.agentId });
  assert.ok(!Object.hasOwn(inherited.session.toolOverrides?.mcpServers ?? {}, "evidence"));
  const globallyDisabled = await fetch(`${app.url}/api/connections/evidence/access`, {
    method: "POST", headers, body: JSON.stringify({ enabled: false }),
  });
  assert.equal(globallyDisabled.status, 200, await globallyDisabled.text());
  await turn(first, "EVIDENCE", reopenedGroup.id);
  assert.equal(serviceCalls(), beforePolicy + 1);
  const globallyEnabled = await fetch(`${app.url}/api/connections/evidence/access`, {
    method: "POST", headers, body: JSON.stringify({ enabled: true }),
  });
  assert.equal(globallyEnabled.status, 200, await globallyEnabled.text());
  await turn(first, "EVIDENCE", reopenedGroup.id);
  assert.equal(serviceCalls(), beforePolicy + 2);
  evidence.scenarios.push("per-bot-allow-inherits-global-disable-and-restores-execution-only-after-global-enable");

  const independentlyDeniedTool = tool(await app.service.abilities!.refresh(first.id));
  await app.service.abilities!.setEnabled(independentlyDeniedTool.id, first.id, false);
  await app.service.abilities!.setEnabled(service.id, first.id, false);
  await app.service.abilities!.setEnabled(service.id, first.id, true);
  await turn(first, "EVIDENCE", reopenedGroup.id);
  assert.equal(serviceCalls(), beforePolicy + 2);
  await app.service.abilities!.setEnabled(independentlyDeniedTool.id, first.id, true);
  await turn(first, "EVIDENCE", reopenedGroup.id);
  assert.equal(serviceCalls(), beforePolicy + 3);
  evidence.scenarios.push("whole-service-reenable-preserves-independent-native-tool-denial");
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await app?.close();
  await Promise.all([mcp, model].map((server) => new Promise<void>((done) => server.close(() => done()))));
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ root, ...evidence }, null, 2));
}
