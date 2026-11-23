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
import type { Message, Task } from "../../../packages/workbench/src/contracts.ts";
import type { RuntimeObservation } from "../../../packages/kernel-runtime/src/contracts.ts";

// E41: one fresh live Codex child writes a file, and the product delivers that
// exact file in the same work chain. The parent model is scripted; the child is
// the vendor's harness through the pinned acpx plugin and the executor's own
// inherited login. No credential is read, copied or printed.
const { values } = parseArgs({ options: {
  "kernel-entry": { type: "string" }, "acp-plugin": { type: "string" },
  "codex-adapter": { type: "string" }, "codex-home": { type: "string" },
} });
if (!values["kernel-entry"] || !values["acp-plugin"]) {
  throw new Error("--kernel-entry and --acp-plugin are required");
}
const codexAdapter = resolve(values["codex-adapter"] ??
  "local/validation/acp-NEwuNm/node_modules/@agentclientprotocol/codex-acp/dist/index.js");
const codexHome = resolve(values["codex-home"] ?? join(process.env.HOME ?? "", ".codex"));
const quote = (value: string) => "'" + value.split("'").join("'\\''") + "'";
const token = randomUUID().slice(0, 8);
const relativePath = `tasks/fresh-codex-${token}/fresh.txt`;
const content = `FRESH-CODEX-DELIVERY-${token}\n`;
const spawnTask = `Create the file ${relativePath} in your working directory (create the directory if needed). ` +
  `Its exact content must be the single line ${content.trim()}. Then reply with only the absolute path of that file.`;

await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/fresh-codex-delivery-"));
const paths = runtimePaths(join(root, "application"));
await preparePaths(paths);
const seed = new WorkbenchStore(join(paths.root, "workbench.sqlite"));
const bot = seed.createBot({ name: "Atlas", agentId: "atlas" });
const conversationId = seed.privateConversation(bot.id).id;
seed.close();

const requests: { marker: string; round: number; trigger: number; head: string }[] = [];
const observations: RuntimeObservation[] = [];
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { role: string; content?: unknown }[] };
  const trigger = body.messages.findLastIndex((entry) => entry.role === "user" &&
    /FRESH-CODEX|DELIVER-FRESH/.test(JSON.stringify(entry.content ?? "")));
  const instruction = JSON.stringify(body.messages[trigger]?.content ?? "");
  const round = body.messages.slice(trigger + 1).filter((entry) => entry.role === "tool").length;
  const deliver = instruction.includes("DELIVER-FRESH");
  // The kernel's own "background result" turn is a notice, not a new command.
  const notice = instruction.includes("A background");
  requests.push({
    marker: notice ? "notice" : deliver ? "deliver" : "spawn", round, trigger,
    head: body.messages.slice(Math.max(0, trigger)).map((entry) => entry.role + ":" + JSON.stringify(entry.content ?? "").slice(0, 40)).join(" | ").slice(0, 300),
  });
  const delta = notice
    ? { role: "assistant", content: "收到后台结果。" }
    : round > 0
    ? { role: "assistant", content: deliver ? "已交付刚生成的文件。" : "文件已生成。" }
    : deliver
      ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: {
          name: "dispatch_action", arguments: JSON.stringify({ id: "livingbot_deliver_file", args: {
            relativePath, mediaType: "text/plain", name: "fresh.txt" } }) } }] }
      : { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: {
          name: "dispatch_action", arguments: JSON.stringify({ id: "sessions_spawn", args: {
            runtime: "acp", agentId: "codex", mode: "run", task: spawnTask } }) } }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [chunk, finish] of [[delta, null], [{}, notice ? "stop" : round === 0 ? "tool_calls" : "stop"]]) {
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
let bearer = "";
const evidence: Record<string, unknown> = {
  token, relativePath, content, requests,
  commands: { codex: "CODEX_HOME=<executor home> node <codex-acp adapter> (own login)" },
};

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(app!.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + bearer, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

async function untilTask(id: string, timeout = 240_000): Promise<Task> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const snapshot = await api<{ tasks: Task[] }>("/api/snapshot");
    const task = snapshot.tasks.find((entry) => entry.id === id);
    if (task && ["completed", "failed", "cancelled"].includes(task.status)) return task;
    if (Date.now() > deadline) throw new Error("Task did not finish: " + id);
    await new Promise((done) => setTimeout(done, 500));
  }
}

try {
  const config = buildKernelConfig(paths, await freeLoopbackPort(), newGatewayToken(), [{ id: bot.agentId }], {
    id: "synthetic", baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    api: "openai-completions", apiKey: "synthetic", model: "synthetic", contextWindow: 64_000, maxTokens: 1200,
  });
  const plugins = config.plugins as { load?: unknown; entries: Record<string, unknown> };
  plugins.load = { paths: [resolve(values["acp-plugin"])] };
  plugins.entries.acpx = { enabled: true, config: {
    agents: { codex: { command: "/bin/sh", args: ["-c",
      "CODEX_HOME=" + quote(codexHome) + " exec " + quote(process.execPath) + " " + quote(codexAdapter)] } },
    probeAgent: "codex", timeoutSeconds: 240,
    nativeAgents: { opencode: false, qwen: false, pi: false, kilocode: false, copilot: false },
    piSessionCatalog: { enabled: false }, agentProcessEnvAllow: [],
  } };
  config.acp = { enabled: true, dispatch: { enabled: true }, backend: "acpx", allowedAgents: ["codex"] };
  await writeKernelConfig(paths, config);
  const launch = () => launchWorkbench({ root: paths.root, kernelEntry: resolve(values["kernel-entry"]!), nodeExecutable: process.execPath });
  app = await launch();
  bearer = JSON.parse(await readFile(app.authPath, "utf8")).token as string;
  app.kernel.on("observation", (event) => observations.push(event));

  const spawnParent = await api<Task>("/api/submissions", {
    submissionId: randomUUID(), conversationId, botId: bot.id, message: "FRESH-CODEX 生成一个文件",
  });
  const spawnDone = await untilTask(spawnParent.id, 60_000);
  assert.equal(spawnDone.status, "completed");
  const child = await (async () => {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const snapshot = await api<{ tasks: Task[] }>("/api/snapshot");
      const found = snapshot.tasks.find((entry) => entry.parentTaskId === spawnParent.id);
      if (found) return found;
      if (Date.now() > deadline) throw new Error("The Codex child was not adopted");
      await new Promise((done) => setTimeout(done, 500));
    }
  })();
  const childDone = await untilTask(child.id, 240_000);
  assert.equal(childDone.status, "completed", "The live Codex child completed");
  assert.equal(childDone.delegation?.executor, "codex");

  const absolute = join(paths.workspaces, bot.agentId, relativePath);
  const written = await readFile(absolute).catch(() => undefined);
  assert.ok(written, "The live Codex child wrote the requested file at " + absolute);
  assert.equal(written.toString("utf8"), content);
  const digest = createHash("sha256").update(written).digest("hex");

  // Wait until the child's final message is projected, so the delivery turn sees
  // a settled conversation rather than racing its session.
  const projectedDeadline = Date.now() + 60_000;
  for (;;) {
    const page = await api<{ messages: Message[] }>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`);
    if (page.messages.some((entry) => entry.taskId === child.id && entry.final)) break;
    if (Date.now() > projectedDeadline) throw new Error("The child's final message was never projected");
    await new Promise((done) => setTimeout(done, 250));
  }
  // The kernel writes a background-result turn after the child. Wait for the
  // conversation to go quiet so the delivery command starts its own fresh turn
  // instead of being steered into a turn where dispatch is unavailable.
  const quietDeadline = Date.now() + 120_000;
  let lastCursor = -1;
  let quiet = 0;
  for (;;) {
    const snapshot = await api<{ tasks: Task[]; cursor: number }>("/api/snapshot");
    const busy = snapshot.tasks.some((entry) =>
      ["queued", "running", "waiting", "stopping"].includes(entry.status));
    quiet = !busy && snapshot.cursor === lastCursor ? quiet + 1 : 0;
    lastCursor = snapshot.cursor;
    if (quiet >= 6) break;
    if (Date.now() > quietDeadline) throw new Error("The conversation never settled after the Codex child");
    await new Promise((done) => setTimeout(done, 250));
  }
  const deliverTask = await api<Task>("/api/submissions", {
    submissionId: randomUUID(), conversationId, botId: bot.id, message: "DELIVER-FRESH 交付刚生成的文件",
  });
  const delivered = await untilTask(deliverTask.id, 120_000);
  assert.equal(delivered.status, "completed");
  const files = await api<{ files: { id: string; name: string; bytes: number; digest: string; origin: string; taskId?: string; botId?: string }[] }>(
    `/api/bots/${encodeURIComponent(bot.id)}/files`,
  );
  const artifact = files.files.find((entry) => entry.name === "fresh.txt");
  assert.ok(artifact, "The product recorded a delivered artifact");
  assert.equal(artifact.digest, digest);
  assert.equal(artifact.bytes, written.byteLength);
  assert.equal(artifact.origin, "delivery");
  assert.equal(artifact.taskId, deliverTask.id);
  assert.equal(artifact.botId, bot.id);
  const deliveredRound = requests.find((entry) => entry.marker === "deliver");
  assert.ok(deliveredRound, "The delivery turn asked the product to deliver the file");
  assert.equal(deliveredRound.round, 0, "The delivery turn started fresh, not as a tool follow-up");

  const download = await fetch(app.url + "/api/files/" + artifact.id, { headers: { authorization: "Bearer " + bearer } });
  assert.equal(download.status, 200);
  const downloaded = Buffer.from(await download.arrayBuffer());
  assert.equal(createHash("sha256").update(downloaded).digest("hex"), digest);
  assert.ok(downloaded.equals(written));
  assert.ok((download.headers.get("content-disposition") ?? "").startsWith("attachment;"));
  const anonymous = await fetch(app.url + "/api/files/" + artifact.id);
  assert.equal(anonymous.status, 401);

  const messages = await api<{ messages: Message[] }>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`);
  const card = messages.messages.find((entry) => entry.blocks.some((block) => block.kind === "file" && block.artifactId === artifact.id));
  assert.ok(card, "A real file card names the delivered artifact");
  const toolNames = messages.messages.flatMap((entry) => entry.blocks)
    .filter((block) => block.kind === "tool").map((block) => (block as { name: string }).name);
  for (const name of ["sessions_spawn", "livingbot_deliver_file"]) {
    assert.ok(toolNames.includes(name), `The native tool ${name} ran`);
  }
  const phases = [...new Set(observations.flatMap((event) => event.type !== "frame" ? [] :
    event.frame.event !== "agent" || event.frame.payload?.stream !== "acp" ? [] :
    [(event.frame.payload.data as { phase?: string } | undefined)?.phase].filter(Boolean)))];

  await app.close();
  app = undefined;
  app = await launch();
  bearer = JSON.parse(await readFile(app.authPath, "utf8")).token as string;
  const restarted = await api<{ tasks: Task[] }>("/api/snapshot");
  const childAgain = restarted.tasks.find((entry) => entry.id === child.id);
  assert.equal(childAgain?.status, "completed");
  assert.equal(childAgain?.delegation?.executor, "codex");
  const filesAgain = await api<{ files: { id: string; digest: string; taskId?: string; botId?: string }[] }>(`/api/bots/${encodeURIComponent(bot.id)}/files`);
  const after = filesAgain.files.find((entry) => entry.id === artifact.id);
  assert.equal(after?.digest, digest);
  assert.equal(after?.taskId, deliverTask.id);
  assert.equal(after?.botId, bot.id);
  const messagesAgain = await api<{ messages: Message[] }>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`);
  assert.ok(messagesAgain.messages.some((entry) => entry.blocks.some((block) => block.kind === "file" && block.artifactId === artifact.id)));

  evidence.spawnParent = { id: spawnParent.id, status: spawnDone.status };
  evidence.child = { id: child.id, status: childDone.status, executor: childDone.delegation?.executor };
  evidence.file = { relativePath, absolute, bytes: written.byteLength, digest };
  evidence.delivery = { taskId: deliverTask.id, artifactId: artifact.id, downloadStatus: download.status, anonymous: anonymous.status };
  evidence.card = Boolean(card);
  evidence.nativeTools = [...new Set(toolNames)];
  evidence.phases = phases;
  evidence.restart = { child: childAgain?.status, artifactDigest: after?.digest, artifactTask: after?.taskId, card: true };
  evidence.status = "fresh-codex-delivery-passed";
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
