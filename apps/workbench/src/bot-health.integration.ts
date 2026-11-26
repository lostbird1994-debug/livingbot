// Reuses the official-kernel/offline-model acceptance harness from credentials.integration.ts.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { HealthReport } from "../../../packages/workbench/src/bot-health-types.ts";
import type { Task } from "../../../packages/workbench/src/contracts.ts";
import type { Routine } from "../../../packages/workbench/src/routines.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import { launchWorkbench } from "./main.ts";

await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/bot-health-"));
const receiptStem = basename(root);
const seed = new WorkbenchStore(join(root, "workbench.sqlite"));
const bot = seed.createBot({ name: "Health Test Bot", agentId: "health-test" });
seed.close();
const original = "旧入口";
const plan = {
  operation: "submit_report",
  summary: "发现一个旧入口，需要先补充可确认的修改方案",
  complete: true,
  gaps: [],
  issues: [
    {
      id: "stale-index",
      category: "workspace",
      priority: "P2",
      certainty: "confirmed",
      title: "目录入口需要更新",
      problem: "目录仍然记录旧入口",
      impact: "容易打开旧版",
      suggestion: "更新目录入口",
      plan: {
        steps: ["保留现有目录", "读取文件后生成修改内容供你确认"],
        limitation: "本轮检查尚未生成可执行的文件修改内容",
      },
      evidence: [{ path: "tasks/index.md", excerpt: original }],
      actions: [],
    },
  ],
};
const steps: { id: string; args: Record<string, unknown> }[] = [
  { id: "livingbot_health_check", args: { operation: "begin", onlyInspect: true } },
  // Read a reference outside the workspace through the ordinary native tool.
  { id: "read", args: { path: "" } },
  { id: "exec", args: { command: "" } },
  { id: "livingbot_health_check", args: { operation: "read_file", path: "tasks/index.md" } },
  { id: "livingbot_health_check", args: { operation: "skills" } },
  { id: "widget_guidelines", args: { modules: ["diagram", "interactive"] } },
  { id: "livingbot_health_check", args: plan },
];
let calls = 0;
const requests: unknown[] = [];
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(input);
  const step = steps[calls++];
  response.writeHead(200, { "content-type": "text/event-stream" });
  const delta = {
    role: "assistant",
    ...(step
      ? {
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: "function",
              function: { name: "dispatch_action", arguments: JSON.stringify(step) },
            },
          ],
        }
      : { content: "NO_REPLY" }),
  };
  for (const [part, finish] of [
    [delta, null],
    [{}, step ? "tool_calls" : "stop"],
  ]) {
    response.write(
      `data: ${JSON.stringify({
        id: randomUUID(),
        object: "chat.completion.chunk",
        created: 1,
        model: "synthetic",
        choices: [{ index: 0, delta: part, finish_reason: finish }],
      })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
async function until<T>(read: () => T | undefined, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Bot health native check timed out");
}
try {
  app = await launchWorkbench({
    root,
    localEmbeddings: false,
    nodeExecutable: process.execPath,
    kernelEntry: resolve("packages/kernel-runtime/node_modules/openclaw/openclaw.mjs"),
    connection: {
      id: "synthetic",
      api: "openai-completions",
      apiKey: "synthetic",
      baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      model: "synthetic",
      maxTokens: 2000,
      contextWindow: 64000,
    },
  });
  const workspace = join(root, "workspaces", bot.agentId);
  await mkdir(join(workspace, "tasks"), { recursive: true });
  await writeFile(join(workspace, "tasks/index.md"), original);
  const external = join(root, "external-reference.csv");
  await writeFile(external, "EXTERNAL_HEALTH_REFERENCE,60");
  await writeFile(join(workspace, "MEMORY.md"), "old memory");
  steps[1]!.args.path = external;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  steps[2]!.args.command =
    `node -e 'const fs=require("fs");const row=fs.readFileSync(process.argv[1],"utf8").split(",");console.log(JSON.stringify({healthParsedShare:Number(row[1])}))' ${quote(external)}`;
  const conversation = app.store.privateConversation(bot.id);
  const task = await app.service.submit({
    submissionId: randomUUID(),
    botId: bot.id,
    conversationId: conversation.id,
    message: "请只检查自己的工作区，不要修改",
  });
  await until(() =>
    ["completed", "failed"].includes(app!.store.get<Task>("tasks", task.id)!.status)
      ? true
      : undefined,
  );
  const report = app.store
    .list<HealthReport>("settings", -1)
    .find((item) => item.taskId === task.id && item.state === "reported");
  assert.ok(report, "Native tool must save its real structured report");
  assert.equal(await readFile(join(workspace, "tasks/index.md"), "utf8"), original);
  const toolResults = (inputs: unknown[]) => inputs.flatMap((input) =>
    ((input as { messages?: { role: string; content?: unknown }[] }).messages ?? [])
      .filter((message) => message.role === "tool")
      .map((message) => JSON.stringify(message.content)),
  ).join("\n");
  assert.ok(
    toolResults(requests).includes("EXTERNAL_HEALTH_REFERENCE,60"),
    "Ordinary native read must access the external reference during inspection",
  );
  assert.ok(toolResults(requests).includes('healthParsedShare'), "Script parser must return its result");
  assert.ok(toolResults(requests).includes('60'));
  assert.ok(JSON.stringify(requests).includes("visualizer_read_me_result"), "Read-only drawing guidance must remain available during health checks");
  const { token } = JSON.parse(await readFile(app.authPath, "utf8"));
  const endpoint = `${app.url}/api/bots/${bot.id}/health-reports/${encodeURIComponent(report.id)}`;
  assert.equal((await fetch(endpoint)).status, 401);
  const proposalSteps = [
    { id: "livingbot_health_check", args: { operation: "begin" } },
    { id: "livingbot_health_check", args: { operation: "read_file", path: "tasks/index.md" } },
    { id: "livingbot_health_check", args: { operation: "skills" } },
    {
      id: "livingbot_health_check",
      args: {
        operation: "submit_report",
        summary: "已补充可确认的目录修改方案",
        complete: true,
        gaps: [],
        issues: [
          {
            ...plan.issues[0],
            plan: { steps: ["保留原文件备份", "更新目录入口并读回核对"] },
            actions: [
              {
                id: "fix-index",
                kind: "write",
                path: "tasks/index.md",
                expectedDigest: createHash("sha256").update(original).digest("hex"),
                content: "新入口",
                explanation: "替换已核对的旧入口",
              },
              {
                id: "fix-memory",
                kind: "write",
                path: "MEMORY.md",
                expectedDigest: createHash("sha256").update("old memory").digest("hex"),
                content: "verified memory",
                explanation: "依据外部资料更正记忆",
              },
            ],
          },
        ],
      },
    },
  ];
  proposalSteps.forEach((step, index) => {
    steps[calls + index] = step;
  });
  const proposal = await fetch(`${endpoint}/decisions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ revision: report.revision, submissionId: "approve-batch", decisions: [{ issueId: "stale-index", choice: "apply" }] }),
  });
  const proposalResult = (await proposal.json()) as HealthReport;
  assert.equal(proposal.status, 200, JSON.stringify(proposalResult));
  assert.equal(proposalResult.batch?.state, "needs_review");
  assert.equal(await readFile(join(workspace, "tasks/index.md"), "utf8"), original);
  const proposalReport = await until(() =>
    app!.store
      .list<HealthReport>("settings", -1)
      .find((item) => item.taskId === proposalResult.batch?.taskId && item.state === "reported"),
  );
  await until(() =>
    ["completed", "failed"].includes(
      app!.store.get<Task>("tasks", proposalReport.taskId)!.status,
    )
      ? true
      : undefined,
  );
  const parentState = await fetch(endpoint, {
    headers: { authorization: `Bearer ${token}` },
  }).then((response) => response.json() as Promise<HealthReport>);
  assert.equal(parentState.batch?.state, "review_ready");
  assert.equal(proposalReport.issues[0]!.actions[0]!.state, undefined);
  assert.equal(await readFile(join(workspace, "tasks/index.md"), "utf8"), original);

  const proposalEndpoint = `${app.url}/api/bots/${bot.id}/health-reports/${encodeURIComponent(proposalReport.id)}`;
  const applied = await fetch(`${proposalEndpoint}/decisions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      revision: proposalReport.revision,
      submissionId: "approve-proposal",
      decisions: [{ issueId: "stale-index", choice: "apply" }],
    }),
  });
  const result = (await applied.json()) as HealthReport;
  assert.equal(applied.status, 200, JSON.stringify(result));
  assert.equal(result.issues[0]!.actions[0]!.state, "applied");
  assert.equal(await readFile(join(workspace, "tasks/index.md"), "utf8"), "新入口");
  assert.equal(await readFile(join(workspace, "MEMORY.md"), "utf8"), "verified memory");
  assert.equal(result.batch?.state, "completed");
  const messages = app.store.messages(conversation.id);
  assert.equal(
    messages.filter((message) => message.blocks.some((block) => block.kind === "health_check"))
      .length,
    2,
  );
  await app.service.reconcile();
  assert.equal(
    app.store
      .messages(conversation.id)
      .filter((message) => message.blocks.some((block) => block.kind === "health_check")).length,
    2,
  );
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const savedSchedule = await fetch(`${app.url}/api/bots/${bot.id}/capability-audit`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      enabled: true,
      cadence: "weekly",
      weekday: 1,
      hour: 9,
      minute: 0,
      timezone: "Asia/Shanghai",
      mode: "confirm",
      consolidateVersions: false,
      scopeConfirmed: true,
    }),
  });
  const settings = (await savedSchedule.json()) as { routineId: string };
  assert.equal(savedSchedule.status, 200, JSON.stringify(settings));
  const routine = app.store.get<Routine>("routines", settings.routineId)!;
  const scheduledCalls = calls;
  // Scheduled health checks can use normal tools even before begin.
  steps[calls] = {
    id: "read",
    args: { path: external },
  };
  steps[calls + 1] = { id: "livingbot_health_check", args: { operation: "begin" } };
  steps[calls + 2] = {
    id: "livingbot_health_check",
    args: { operation: "skills" },
  };
  steps[calls + 3] = {
    id: "livingbot_health_check",
    args: {
      operation: "submit_report",
      summary: "例行体检已完成，本次未发现新问题",
      complete: true,
      gaps: [],
      issues: [],
    },
  };
  await app.service.routines!.testRun(routine.id, routine.revision!);
  const scheduledReport = await until(
    () =>
      app!.store
        .list<HealthReport>("settings", -1)
        .find(
          (item) =>
            item.id !== report.id &&
            item.id !== proposalReport.id &&
            item.botId === bot.id &&
            item.state === "reported",
        ),
    120_000,
  );
  await until(
    () =>
      ["completed", "failed"].includes(
        app!.store.get<Task>("tasks", scheduledReport.taskId)!.status,
      )
        ? true
        : undefined,
    120_000,
  );
  const scheduledTask = app.store.get<Task>("tasks", scheduledReport.taskId)!;
  assert.equal(scheduledTask.routine?.id, routine.id);
  assert.ok(toolResults(requests.slice(scheduledCalls)).includes("EXTERNAL_HEALTH_REFERENCE,60"));
  assert.equal(await readFile(join(workspace, "tasks/index.md"), "utf8"), "新入口");
  assert.equal(
    app.store
      .messages(conversation.id)
      .filter((message) => message.blocks.some((block) => block.kind === "health_check")).length,
    3,
  );
  await app.close();
  app = undefined;
  const reopened = new WorkbenchStore(join(root, "workbench.sqlite"));
  const persisted = reopened.get<HealthReport>("settings", proposalReport.id);
  assert.ok(persisted);
  assert.equal(persisted.issues[0]!.actions[0]!.state, "applied");
  reopened.close();
  await writeFile(
    `local/validation/${receiptStem}-acceptance.json`,
    JSON.stringify(
      {
        root,
        passed: true,
        modelCalls: calls,
        nativeExternalReadPassed: true,
        nativeParserPassed: true,
        approvedMemoryApplied: true,
        confirmationApplied: true,
        unauthorizedRejected: true,
        healthReportCards: 3,
        proposalApprovalFlow: true,
        proposalCardPublishedOnce: true,
        proposalApprovalApplied: true,
        stableReplay: true,
        stableReopen: true,
        scheduledRunPassed: true,
        scheduledExternalReadBeforeBegin: true,
        scheduledReportInMainConversation: true,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      modelCalls: calls,
      nativeExternalReadPassed: true,
      approvedMemoryApplied: true,
      confirmationApplied: true,
      proposalApprovalApplied: true,
    }),
  );
} catch (error) {
  await writeFile(
    `local/validation/${receiptStem}-failure.json`,
    JSON.stringify(
      {
        root,
        error: String(error),
        requests,
        tasks: app?.store
          .list<Task>("tasks")
          .map((task) => ({ status: task.status, error: task.error })),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app?.close();
  await new Promise<void>((done) => model.close(() => done()));
  if (process.platform === "darwin") {
    const recovery = join(
      homedir(),
      ".Trash",
      `LivingBot-${receiptStem}-${Date.now()}`,
    );
    await rename(root, recovery);
    console.log(JSON.stringify({ testFixtureOriginal: root, testFixtureRecovery: recovery }));
  }
}
