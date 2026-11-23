import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { launchWorkbench } from "./main.ts";
import { preparePaths, runtimePaths } from "../../../packages/kernel-runtime/src/paths.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import type { Task } from "../../../packages/workbench/src/contracts.ts";
import { verifyRecoverySnapshot } from "../../../packages/kernel-runtime/src/recovery-snapshot.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-memory-"));
const paths = runtimePaths(join(root, "application"));
await preparePaths(paths);
const seed = new WorkbenchStore(join(paths.root, "workbench.sqlite"));
const first = seed.createBot({ name: "Atlas", agentId: "atlas" });
const second = seed.createBot({ name: "Moss", agentId: "moss" });
seed.close();
for (const [agentId, text] of [
  [first.agentId, "# 项目约定\n\n青岚计划的交付日期是十二月十日，书稿使用中文排版。\n"],
  [second.agentId, "# 私有资料\n\n赤霞方案的内部代号是 MOSS-PRIVATE-7321。\n"],
]) {
  await mkdir(join(paths.workspaces, agentId), { recursive: true });
  await writeFile(join(paths.workspaces, agentId, "MEMORY.md"), text, { mode: 0o600, flag: "wx" });
}
const requests: unknown[] = [];
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  response.writeHead(200, { "content-type": "text/event-stream" });
  const messages = body.messages as { role: string; content: unknown }[];
  const recallPass = messages.some((message) => message.role === "user" &&
    JSON.stringify(message.content).includes(":active-memory:"));
  const groupScopeCheck = messages.some((message) => message.role === "user" &&
    JSON.stringify(message.content).includes("NATIVE_GROUP_MEMORY_SCOPE_CHECK"));
  const toolResult = messages.findLast((message) => message.role === "tool");
  // Scripted protocol fixture: exercise the native recall tool, then pass its
  // exact returned excerpt onward. This does not grade natural-language quality.
  const call = (recallPass || groupScopeCheck) && !toolResult ? {
    index: 0, id: "synthetic-memory-search", type: "function", function: {
      name: "dispatch_action", arguments: JSON.stringify({
        id: "memory_search", args: { query: groupScopeCheck ? "ATLAS-PRIVATE-8294" : "银杏项目", maxResults: 6, minScore: 0 },
      }),
    },
  } : undefined;
  let content = "Synthetic memory protocol response.";
  if (recallPass && toolResult) {
    const raw = typeof toolResult.content === "string" ? toolResult.content : JSON.stringify(toolResult.content);
    const envelope = JSON.parse(raw);
    const result = envelope.result?.content
      ? JSON.parse(envelope.result.content.find((part: { type: string }) => part.type === "text").text)
      : envelope;
    content = result.results?.[0]?.snippet ?? "NONE";
  }
  for (const [delta, finish] of [
    [{ role: "assistant", ...(call ? { tool_calls: [call] } : { content }) }, null],
    [{}, call ? "tool_calls" : "stop"],
  ]) response.write(`data: ${JSON.stringify({
    id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
const evidence: { scenarios: string[]; root: string; requests: unknown[]; observations: unknown[]; error?: string } = {
  scenarios: [], root, requests, observations: [],
};
function terminal(id: string): Promise<Task> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { app!.store.off("event", changed); reject(new Error("Memory task deadline exceeded")); }, 45_000);
    function changed() {
      const task = app!.service.task(id);
      if (["completed", "failed", "cancelled"].includes(task.status)) {
        clearTimeout(timer); app!.store.off("event", changed); resolve(task);
      }
    }
    app!.store.on("event", changed); changed();
  });
}
try {
  app = await launchWorkbench({
    root: paths.root, kernelEntry: resolve(values["kernel-entry"]), nodeExecutable: process.execPath,
    connection: {
      id: "synthetic", baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      api: "openai-completions", apiKey: "synthetic", model: "synthetic", contextWindow: 32_000, maxTokens: 1000,
    },
  });
  const health = await app.service.memories!.health(first.id);
  evidence.observations.push({ health });
  assert.equal(health.providerId, "memory-core");
  assert.equal(health.mode, "text");
  const found = await app.service.memories!.search(first.id, { query: "青岚计划", sources: ["memory"] });
  evidence.observations.push({ found });
  assert.ok(found.hits.some((hit) => hit.excerpt.includes("十二月十日")));
  const source = await app.service.memories!.get(first.id, found.hits[0].reference);
  assert.equal(source.status, "ok");
  assert.ok(source.status === "ok" && source.text.includes("青岚计划"));
  const excluded = await app.service.memories!.search(first.id, { query: "MOSS-PRIVATE-7321", sources: ["memory", "sessions"] });
  assert.equal(excluded.hits.length, 0);
  evidence.scenarios.push("native-chinese-fts-source-get-and-other-agent-exclusion");
  const privateSource = app.store.privateConversation(first.id);
  const previous = await app.service.submit({
    submissionId: randomUUID(), conversationId: privateSource.id, botId: first.id,
    message: "请记住：我为银杏项目约定的专属交付编号是 ATLAS-PRIVATE-8294，写作时使用暖灰色图表。",
  });
  assert.equal((await terminal(previous.id)).status, "completed");
  const sessions = await app.kernel.request<{ sessions: { key: string; chatType?: string; kind?: string }[] }>("sessions.list", {});
  const sourceSession = sessions.sessions.find((item) => item.key === app!.store.engineSessionKey(privateSource.id, first.id));
  evidence.observations.push({ sourceSession });
  assert.equal(sourceSession?.chatType, "direct");
  // Native transcript indexing starts after 30 seconds with no turn activity.
  // This isolated acceptance wait does not add polling to product state handling.
  await delay(35_000);
  const recalled = await app.service.memories!.search(first.id, { query: "ATLAS-PRIVATE-8294", sources: ["sessions"] });
  evidence.observations.push({ recalled });
  assert.ok(recalled.hits.some((hit) => hit.excerpt.includes("ATLAS-PRIVATE-8294")));
  const other = await app.service.memories!.search(second.id, { query: "ATLAS-PRIVATE-8294", sources: ["sessions"] });
  assert.equal(other.hits.length, 0);
  evidence.scenarios.push("native-private-transcript-indexing-is-agent-scoped");
  const newPrivate = app.store.createConversation("private", [first.id], "Another private conversation");
  const following = await app.service.submit({
    submissionId: randomUUID(), conversationId: newPrivate.id, botId: first.id,
    message: "你还记得我之前说过的银杏项目专属交付编号和图表配色吗？",
  });
  assert.equal((await terminal(following.id)).status, "completed");
  evidence.observations.push({ automaticRecallRequests: requests.length });
  // Record the native injected context, without judging this synthetic model's prose.
  const hasInjectedSource = requests.some((request) => {
    const messages = (request as { messages: { role: string; content: unknown }[] }).messages;
    return messages.some((message) => JSON.stringify(message.content).includes("你还记得我之前")) &&
      messages.some((message) => JSON.stringify(message.content).includes("<active_memory_plugin>") &&
        JSON.stringify(message.content).includes("ATLAS-PRIVATE-8294"));
  });
  evidence.observations.push({ hasInjectedSource });
  assert.equal(hasInjectedSource, true, "Native recall context should reach the new private turn");
  evidence.scenarios.push("chinese-recall-intent-routes-native-private-memory-into-new-turn");
  const token = JSON.parse(await readFile(app.authPath, "utf8")).token;
  const searched = await fetch(`${app.url}/api/bots/${first.id}/memory/search`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: "青岚计划" }),
  });
  assert.equal(searched.status, 200);
  assert.ok((await searched.json()).hits.length);
  evidence.scenarios.push("authenticated-bot-memory-management-uses-native-index");
  const memoryBefore = await readFile(join(paths.workspaces, first.agentId, "MEMORY.md"), "utf8");
  evidence.observations.push({ beforePreviewSessions: await app.kernel.request("sessions.list", {}) });
  const previewResponse = await fetch(`${app.url}/api/bots/${first.id}/memory/forget-preview`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ conversationIds: [privateSource.id], allowKernelPause: true }),
  });
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 200, JSON.stringify(preview));
  evidence.observations.push({ forgettingPreview: preview });
  assert.equal(preview.report.agentId, first.agentId);
  assert.equal(preview.report.dryRun, true);
  assert.ok(preview.report.sessionResolutions.some((item: { source: string }) => item.source === "live"));
  assert.ok(preview.report.artifacts.indexChunks > 0);
  assert.equal(await readFile(join(paths.workspaces, first.agentId, "MEMORY.md"), "utf8"), memoryBefore);
  const retained = await app.service.memories!.search(first.id, { query: "ATLAS-PRIVATE-8294", sources: ["sessions"] });
  assert.ok(retained.hits.length, "Read-only forgetting preview must retain indexed source transcripts");
  evidence.scenarios.push("native-forgetting-preview-resolves-live-session-and-retains-memory-and-index");
  const preparationResponse = await fetch(`${app.url}/api/bots/${first.id}/memory/forget-backup`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ previewId: preview.id, digest: preview.digest, allowKernelPause: true }),
  });
  const preparation = await preparationResponse.json();
  assert.equal(preparationResponse.status, 200, JSON.stringify(preparation));
  const recovery = await verifyRecoverySnapshot(join(paths.root, "memory-recovery", preparation.recovery.id));
  assert.equal(recovery.digest, preparation.recovery.digest);
  assert.ok(recovery.files.some((file) => file.root === "kernel-state" && file.path.includes("agents/atlas/agent/openclaw-agent.sqlite")));
  assert.ok(recovery.files.some((file) => file.root === "kernel-state" && file.path === "state/openclaw.sqlite"));
  assert.ok(recovery.files.some((file) => file.root === "workspace" && file.path === "MEMORY.md"));
  assert.equal(await readFile(join(paths.workspaces, first.agentId, "MEMORY.md"), "utf8"), memoryBefore);
  evidence.observations.push({ recovery: preparation.recovery });
  evidence.scenarios.push("native-offline-recovery-copy-verifies-agent-database-shared-plugin-state-and-workspace");
  const absent = app.store.createConversation("private", [first.id], "Never sent");
  const unresolved = await app.service.memories!.previewForget(first.id, [absent.id]);
  assert.ok(unresolved.report.sessionResolutions.some((item) => item.source === "unresolved"));
  evidence.observations.push({ unresolvedPreview: unresolved });
  evidence.scenarios.push("native-forgetting-preview-reports-unresolved-conversation-without-claiming-deletion");
  await app.kernel.restart();
  const persisted = await app.service.memories!.search(first.id, { query: "青岚计划" });
  assert.ok(persisted.hits.length);
  assert.deepEqual(app.store.get("settings", preview.id), preparation);
  evidence.scenarios.push("native-memory-search-persists-across-kernel-restart");
  const group = app.store.createConversation("group", [first.id, second.id], "Scope check");
  const groupTask = await app.service.submit({
    submissionId: randomUUID(), conversationId: group.id, botId: first.id,
    message: "NATIVE_GROUP_MEMORY_SCOPE_CHECK Run the configured native memory search.",
  });
  assert.equal((await terminal(groupTask.id)).status, "completed");
  const groupResults = requests.flatMap((request) => {
    const messages = (request as { messages: { role: string; content: unknown }[] }).messages;
    return messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("NATIVE_GROUP_MEMORY_SCOPE_CHECK"))
      ? messages.filter((message) => message.role === "tool") : [];
  });
  assert.ok(groupResults.length, "Group must actually invoke native memory search");
  for (const message of groupResults) {
    const envelope = JSON.parse(String(message.content));
    const result = envelope.result?.content
      ? JSON.parse(envelope.result.content.find((part: { type: string }) => part.type === "text").text)
      : envelope;
    assert.ok(!(result.results ?? []).some((hit: { snippet?: string }) => hit.snippet?.includes("ATLAS-PRIVATE-8294")),
      "Ordinary group memory tools must not bypass explicit private sharing");
  }
  evidence.scenarios.push("ordinary-native-group-memory-cannot-read-unshared-private-transcripts");
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await app?.close();
  await new Promise<void>((resolve) => model.close(() => resolve()));
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ root, scenarios: evidence.scenarios, observations: evidence.observations, error: evidence.error }, null, 2));
}
