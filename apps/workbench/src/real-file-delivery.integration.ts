import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchWorkbench, freeLoopbackPort } from "./main.ts";
import { buildKernelConfig, newGatewayToken, writeKernelConfig } from "../../../packages/kernel-runtime/src/config.ts";
import { preparePaths, runtimePaths } from "../../../packages/kernel-runtime/src/paths.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import type { Task } from "../../../packages/workbench/src/contracts.ts";

// Real file delivery through the product's own primitives. The bytes are the
// artifact the accepted real-Codex run already produced; nothing is re-executed
// and no executor is started. The parent model is synthetic: it only asks the
// native tool to deliver the file that is already sitting in the task workspace.
const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
const REUSED = resolve("local/test-fixtures/native-real-executors-aBOFNG/application/workspaces/atlas/livingbot-executor.txt");
const bytes = await readFile(REUSED);
const digest = createHash("sha256").update(bytes).digest("hex");
// The independent review recorded this exact digest for the accepted artifact.
const REVIEWED_DIGEST = "1574ee5f74126dc31e1851089e8b5df7ae420edb1a79e79f8b7208b8e137fc5e";
if (digest !== REVIEWED_DIGEST) throw new Error("Reused artifact differs from the reviewed bytes");

await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-file-delivery-"));
const paths = runtimePaths(join(root, "application"));
await preparePaths(paths);
const seed = new WorkbenchStore(join(paths.root, "workbench.sqlite"));
const bot = seed.createBot({ name: "Atlas", agentId: "atlas" });
const conversationId = seed.privateConversation(bot.id).id;
seed.close();
// Producer ownership: the deliverable lives in this Bot's own task workspace.
await mkdir(join(paths.workspaces, bot.agentId, "tasks"), { recursive: true });
await writeFile(join(paths.workspaces, bot.agentId, "tasks", "livingbot-executor.txt"), bytes);

const requests: { roles: string; round: number }[] = [];
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { role: string; content?: unknown }[] };
  const trigger = body.messages.findLastIndex((entry) => entry.role === "user" &&
    JSON.stringify(entry.content ?? "").includes("DELIVER-REUSED-ARTIFACT"));
  const round = body.messages.slice(trigger + 1).filter((entry) => entry.role === "tool").length;
  requests.push({ roles: body.messages.map((entry) => entry.role).join(","), round });
  const delta = trigger >= 0 && round === 0
    ? { role: "assistant", tool_calls: [{
        index: 0, id: randomUUID(), type: "function", function: {
          name: "dispatch_action",
          arguments: JSON.stringify({ id: "livingbot_deliver_file", args: {
            relativePath: "tasks/livingbot-executor.txt", mediaType: "text/plain",
          } }),
        },
      }] }
    : { role: "assistant", content: "已交付，文件卡片在上一条消息里。" };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [chunk, finish] of [[delta, null], [{}, trigger >= 0 && round === 0 ? "tool_calls" : "stop"]]) {
    response.write(`data: ${JSON.stringify({
      id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta: chunk, finish_reason: finish }],
    })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((ready) => model.listen(0, "127.0.0.1", ready));

type App = Awaited<ReturnType<typeof launchWorkbench>>;
let app: App | undefined;
const evidence: Record<string, unknown> = {
  reusedFrom: REUSED, digest, requestedDigest: REVIEWED_DIGEST, requests,
  command: "CODEX_HOME=<inherited> launchWorkbench with synthetic parent; no executor started",
};
let token = "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(app!.url + path, {
    ...init,
    headers: { authorization: "Bearer " + token, ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
  return await response.json() as T;
}

async function waitTask(id: string, timeout = 60_000): Promise<Task> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const snapshot = await api<{ tasks: Task[] }>("/api/snapshot");
    const task = snapshot.tasks.find((entry) => entry.id === id);
    if (task?.status === "completed") return task;
    if (task && ["failed", "cancelled"].includes(task.status)) throw new Error("Task became " + task.status);
    if (Date.now() > deadline) throw new Error("Task did not complete");
    await new Promise((done) => setTimeout(done, 250));
  }
}

try {
  const config = buildKernelConfig(paths, await freeLoopbackPort(), newGatewayToken(), [{ id: bot.agentId }], {
    id: "synthetic", baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    api: "openai-completions", apiKey: "synthetic", model: "synthetic", contextWindow: 32_000, maxTokens: 1000,
  });
  await writeKernelConfig(paths, config);
  app = await launchWorkbench({ root: paths.root, kernelEntry: resolve(values["kernel-entry"]!), nodeExecutable: process.execPath });
  token = JSON.parse(await readFile(app.authPath, "utf8")).token as string;

  const before = await api<{ files: unknown[] }>(`/api/bots/${encodeURIComponent(bot.id)}/files`);
  evidence.artifactsBefore = before.files.length;

  const task = await api<Task>("/api/submissions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ submissionId: randomUUID(), conversationId, botId: bot.id, message: "DELIVER-REUSED-ARTIFACT" }),
  });
  await waitTask(task.id);

  const listed = await api<{
    files: { id: string; name: string; mediaType: string; bytes: number; digest: string; origin: string; taskId?: string; conversationId: string }[];
  }>(`/api/bots/${encodeURIComponent(bot.id)}/files`);
  assert.equal(listed.files.length, 1, "Exactly one delivered artifact was recorded");
  const artifact = listed.files[0]!;
  assert.equal(artifact.digest, REVIEWED_DIGEST);
  assert.equal(artifact.bytes, bytes.byteLength);
  assert.equal(artifact.name, "livingbot-executor.txt");
  assert.equal(artifact.mediaType, "text/plain");
  assert.equal(artifact.origin, "delivery");
  assert.equal(artifact.taskId, task.id);
  assert.equal(artifact.conversationId, conversationId);
  const stored = app.store.artifact(artifact.id);
  assert.ok(stored?.path.startsWith(join(paths.workspaces, bot.agentId, "tasks")),
    "Delivered bytes stay in the producer Bot's own workspace");

  const messages = await api<{ messages: { id: string; taskId?: string; blocks: { kind: string; artifactId?: string; name?: string }[] }[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
  );
  const card = messages.messages.find((entry) => entry.blocks.some((block) => block.kind === "file" && block.artifactId === artifact.id));
  assert.ok(card, "The conversation carries a real file card for the delivered bytes");
  assert.equal(card.blocks.find((block) => block.artifactId === artifact.id)?.name, "livingbot-executor.txt");

  // Authenticated download, byte for byte.
  const download = await fetch(app.url + "/api/files/" + artifact.id, { headers: { authorization: "Bearer " + token } });
  assert.equal(download.status, 200);
  const downloaded = Buffer.from(await download.arrayBuffer());
  assert.equal(createHash("sha256").update(downloaded).digest("hex"), REVIEWED_DIGEST);
  assert.ok(downloaded.equals(bytes), "Downloaded bytes equal the executor's actual output");
  const disposition = download.headers.get("content-disposition") ?? "";
  assert.ok(disposition.startsWith("attachment;"), "Download is an attachment");
  assert.ok(disposition.includes(encodeURIComponent("livingbot-executor.txt")));
  const unauthenticated = await fetch(app.url + "/api/files/" + artifact.id);
  assert.equal(unauthenticated.status, 401, "Download requires the desktop token");

  evidence.artifact = {
    id: artifact.id, name: artifact.name, bytes: artifact.bytes, digest: artifact.digest,
    origin: artifact.origin, taskId: artifact.taskId, conversationId: artifact.conversationId,
    path: stored?.path, relativeToWorkspace: stored && stored.path.startsWith(join(paths.workspaces, bot.agentId, "tasks")),
  };
  evidence.card = { messageId: card.id, block: card.blocks.find((block) => block.artifactId === artifact.id) };
  evidence.download = {
    status: download.status, contentType: download.headers.get("content-type"),
    contentDisposition: disposition, bytes: downloaded.byteLength, sha256: REVIEWED_DIGEST,
    unauthenticatedStatus: unauthenticated.status,
  };
  evidence.artifactsAfter = (await api<{ files: unknown[] }>(`/api/bots/${encodeURIComponent(bot.id)}/files`)).files.length;
  evidence.status = "real-file-delivery-passed";
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  try { await app?.close(); }
  finally {
    await new Promise<void>((done) => model.close(() => done()));
    await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
    console.log({ root, status: evidence.status, error: evidence.error });
  }
}
