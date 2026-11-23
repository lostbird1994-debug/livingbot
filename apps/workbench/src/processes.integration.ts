import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { freeLoopbackPort, launchWorkbench } from "./main.ts";
import { buildKernelConfig, newGatewayToken, writeKernelConfig } from "../../../packages/kernel-runtime/src/config.ts";
import { preparePaths, runtimePaths } from "../../../packages/kernel-runtime/src/paths.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import type { Task } from "../../../packages/workbench/src/contracts.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-processes-"));
const paths = runtimePaths(join(root, "application"));
await preparePaths(paths);
const seed = new WorkbenchStore(join(paths.root, "workbench.sqlite"));
const bot = seed.createBot({ name: "Atlas", agentId: "atlas" });
seed.close();
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
const commands = ["service-one", "service-two", "command", "stubborn", "timeout"] as const;
const frames: unknown[] = [];
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const messages = body.messages as { role: string; content: unknown }[];
  const trigger = messages.findLastIndex((entry) =>
    entry.role === "user" && commands.some((name) => JSON.stringify(entry.content).includes(`PROCESS:${name}`)));
  const selected = commands.find((name) => JSON.stringify(messages[trigger]?.content).includes(`PROCESS:${name}`));
  const received = messages.slice(trigger + 1).some((entry) => entry.role === "tool");
  const execute = Boolean(selected && !received);
  response.writeHead(200, { "content-type": "text/event-stream" });
  const delta = execute ? { role: "assistant", tool_calls: [{
    index: 0, id: randomUUID(), type: "function", function: {
      name: "exec", arguments: JSON.stringify({
        command: [
          process.execPath, fileURLToPath(new URL("./fixtures/long-command.mjs", import.meta.url)),
          join(root, `${selected}.pid`), selected === "stubborn" ? "stubborn" :
            selected === "command" || selected === "timeout" ? "command" : "service",
        ].map(quote).join(" "),
        background: selected !== "command" && selected !== "timeout", yieldMs: 10_000,
        timeoutSeconds: selected === "timeout" ? 1 : 0, host: "gateway",
      }),
    },
  }] } : { role: "assistant", content: selected === "timeout" ? "Synthetic command timeout recorded." : "Synthetic program started." };
  for (const [chunk, finish] of [[delta, null], [{}, execute ? "tool_calls" : "stop"]]) {
    response.write(`data: ${JSON.stringify({
      id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta: chunk, finish_reason: finish }],
    })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
const evidence: { scenarios: string[]; frames: unknown[]; tasks?: Task[]; error?: string } = { scenarios: [], frames };
const owned: string[] = [];
function until(id: string, predicate: (task: Task) => boolean): Promise<Task> {
  return new Promise((done, reject) => {
    const store = app!.store;
    const timer = setTimeout(() => { store.off("event", changed); reject(new Error("Native process deadline exceeded")); }, 35_000);
    function changed() {
      const task = app!.service.task(id);
      if (!predicate(task)) return;
      clearTimeout(timer); store.off("event", changed); done(task);
    }
    store.on("event", changed); changed();
  });
}
async function start(name: typeof commands[number]): Promise<Task> {
  const task = await app!.service.submit({
    submissionId: randomUUID(), botId: bot.id,
    conversationId: app!.store.privateConversation(bot.id).id, message: `PROCESS:${name}`,
  });
  owned.push(task.id);
  return until(task.id, (entry) => entry.processes?.some((process) => process.status === "running") === true &&
    (name === "command" || entry.status === "completed"));
}
function exited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}
function pidFile(name: string): Promise<number> {
  return new Promise((done, reject) => {
    const filename = `${name}.pid`;
    const watcher = watch(root, (_event, changed) => { if (String(changed) === filename) void read(); });
    const timer = setTimeout(() => { watcher.close(); reject(new Error("Fixture did not announce its PID")); }, 15_000);
    async function read() {
      try {
        const pid = Number(await readFile(join(root, filename), "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 0) return;
        clearTimeout(timer); watcher.close(); done(pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        clearTimeout(timer); watcher.close(); reject(error);
      }
    }
    void read();
  });
}
try {
  const config = buildKernelConfig(paths, await freeLoopbackPort(), newGatewayToken(), [{ id: bot.agentId }], {
    id: "synthetic", baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
    api: "openai-completions", apiKey: "synthetic", model: "synthetic", contextWindow: 64_000, maxTokens: 1000,
  });
  config.tools = { exec: { mode: "full", notifyOnExit: false } };
  await writeKernelConfig(paths, config);
  app = await launchWorkbench({ root: paths.root, kernelEntry: resolve(values["kernel-entry"]), nodeExecutable: process.execPath });
  app.kernel.on("observation", (event) => frames.push(event));
  const first = await start("service-one");
  const second = await start("service-two");
  const firstPid = await pidFile("service-one");
  const secondPid = await pidFile("service-two");
  assert.equal(exited(firstPid), false);
  assert.equal(exited(secondPid), false);
  await app.service.cancel(first.id);
  await until(first.id, (task) => task.processes?.every((entry) => entry.status === "killed") === true);
  assert.equal(exited(firstPid), true, "The stopped service must physically exit");
  assert.equal(exited(secondPid), false, "A different task in the same session must stay alive");
  assert.equal(app.service.task(second.id).processes?.[0].status, "running");
  evidence.scenarios.push("completed-task-service-stop-confirms-physical-exit-and-preserves-another-task-in-the-same-session");
  const foreground = await start("command");
  const commandPid = await pidFile("command");
  assert.equal(exited(commandPid), false);
  await app.service.cancel(foreground.id);
  await until(foreground.id, (task) => task.status === "cancelled" &&
    task.processes?.every((entry) => entry.status === "killed") === true);
  assert.equal(exited(commandPid), true, "The ordinary command must physically exit");
  assert.equal(exited(secondPid), false);
  evidence.scenarios.push("active-turn-stop-confirms-ordinary-command-exit-without-stopping-an-independent-service");
  await app.service.cancel(second.id);
  await until(second.id, (task) => task.processes?.every((entry) => entry.status === "killed") === true);
  assert.equal(exited(secondPid), true);
  evidence.scenarios.push("separate-service-stop-confirms-exit");
  const stubborn = await start("stubborn");
  const stubbornPid = await pidFile("stubborn");
  await app.service.cancel(stubborn.id);
  await until(stubborn.id, (task) => task.processes?.every((entry) => entry.status === "killed") === true);
  assert.equal(exited(stubbornPid), true, "An ignored TERM must not masquerade as completed cleanup");
  evidence.scenarios.push("stubborn-service-stop-confirms-physical-exit-after-native-escalation");
  const timeout = await app.service.submit({
    submissionId: randomUUID(), botId: bot.id,
    conversationId: app.store.privateConversation(bot.id).id, message: "PROCESS:timeout",
  });
  owned.push(timeout.id);
  const timedOut = await until(timeout.id, (task) => task.status === "completed" &&
    task.processes?.some((entry) => entry.status === "failed") === true);
  const timeoutPid = await pidFile("timeout");
  assert.equal(exited(timeoutPid), true);
  assert.equal(timedOut.processes?.[0].exitReason, "overall-timeout");
  evidence.scenarios.push("ordinary-command-timeout-confirms-physical-exit-and-retains-native-failure-reason");
  evidence.tasks = app.store.list<Task>("tasks");
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  if (app) {
    await Promise.allSettled(owned.map((id) => app!.service.cancel(id)));
    await app.close();
  }
  await new Promise<void>((done) => model.close(() => done()));
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
  console.log({ root, scenarios: evidence.scenarios, error: evidence.error });
}
