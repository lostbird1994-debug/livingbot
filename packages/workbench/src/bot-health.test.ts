import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { BotHealth } from "./bot-health.ts";
import type { HealthReport } from "./bot-health-types.ts";
import type { Message, Task } from "./contracts.ts";
import type { KernelControl } from "./service.ts";
import { WorkbenchService } from "./service.ts";
import { WorkbenchStore } from "./store.ts";
import { Workspaces } from "./workspaces.ts";

async function fixture(t: TestContext, silent = false) {
  const root = await mkdtemp(join(tmpdir(), "livingbot-health-test-"));
  const store = new WorkbenchStore(":memory:");
  const kernel = Object.assign(new EventEmitter(), {
    generation: 1,
    request: async () => ({ skills: [] }),
    phase: "ready",
    send: async () => ({ runId: "unused", status: "started" }),
    recoverHistory: async () => ({ messages: [] }),
    abort: async () => ({}),
  }) as unknown as KernelControl;
  const service = new WorkbenchService(store, kernel);
  const workspaces = new Workspaces(join(root, "workspaces"));
  const bot = store.createBot({ name: "Test Bot", agentId: "health-test" });
  const workspace = await workspaces.initialize(bot.agentId);
  const trash = join(root, "recoverable-trash");
  await mkdir(trash);
  const health = new BotHealth(service, workspaces, {
    trashRoot: trash,
    recoveryRoot: join(root, "recovery"),
  });
  store.put("settings", {
    id: `exclusive-capability-audit:${bot.id}`,
    mode: silent ? "silent" : "confirm",
    scopeConfirmed: true,
  });
  const start = async () => {
    const conversation = store.privateConversation(bot.id);
    const { task } = store.beginSubmission({
      submissionId: randomUUID(),
      botId: bot.id,
      conversationId: conversation.id,
      message: "请做一次体检",
      hiddenInput: true,
    });
    store.put("tasks", { ...task, status: "running" });
    const runId = randomUUID();
    const sessionKey = store.engineSessionKey(conversation.id, bot.id);
    store.put("runs", {
      id: runId,
      taskId: task.id,
      sessionKey,
      state: "running",
      generation: 1,
      lastSequence: -1,
      createdAt: Date.now(),
    });
    const authority = { agentId: bot.agentId, sessionKey, runId };
    const begun = (await health.invoke({ ...authority, operation: "begin" })) as {
      reportId: string;
      mode: string;
    };
    await health.invoke({ ...authority, operation: "skills" });
    return { authority, taskId: task.id, ...begun };
  };
  t.after(async () => {
    service.detach();
    store.close();
    // Own isolated fixtures remain recoverable, including failed-test evidence.
    const trashRoot = process.platform === "darwin" ? join(homedir(), ".Trash") : tmpdir();
    const recovery = await mkdtemp(join(trashRoot, "LivingBot-health-tests-"));
    await rename(root, join(recovery, "fixture"));
  });
  return { root, store, service, workspaces, bot, workspace, health, start };
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function issue(actions: unknown[] = []) {
  return {
    id: "broken-index",
    category: "workspace",
    priority: "P2",
    certainty: "confirmed",
    title: "目录入口需要更新",
    problem: "入口指向旧文件",
    impact: "可能打开旧版",
    suggestion: "更新入口",
    plan: {
      steps: ["保留原文件备份", "更新目录指向并读回核对"],
      ...(actions.length ? {} : { limitation: "需要先确认保留哪个业务版本，再生成文件修改方案" }),
    },
    evidence: [{ path: "tasks/index.md", excerpt: "旧入口" }],
    actions,
  };
}
const handoff = (id: string, target = "tasks/index.md") => ({
  id,
  kind: "instruction",
  target,
  steps: ["按确认后的方案处理"],
  explanation: "交给 Bot 按步骤处理",
});
async function submit(
  f: Awaited<ReturnType<typeof fixture>>,
  run: Awaited<ReturnType<typeof f.start>>,
  issues: unknown[],
) {
  await f.health.invoke({
    ...run.authority,
    operation: "submit_report",
    summary: "发现需要处理的文件问题",
    complete: true,
    gaps: [],
    issues,
  });
  return f.health.get(f.bot.id, run.reportId);
}

test("completed reports accept omitted gaps but incomplete reports require an explanation", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  const input = {
    ...run.authority,
    operation: "submit_report",
    summary: "检查完成",
    complete: true,
    issues: [issue([handoff("plan")])],
  };
  await assert.rejects(f.health.invoke({ ...input, gaps: "none" }), /gaps/);
  await assert.rejects(f.health.invoke({ ...input, complete: false }), /缺少什么/);
  await f.health.invoke(input);
  const report = f.health.get(f.bot.id, run.reportId);
  assert.equal(report.state, "reported");
  assert.deepEqual(report.gaps, []);
  assert.equal(report.issues.length, 1);
});

test("first silent inspection publishes a card, never modifies, and approval applies one version-checked plan", async (t) => {
  const f = await fixture(t, true);
  await writeFile(join(f.workspace, "tasks/index.md"), "旧入口");
  const run = await f.start();
  assert.equal(run.mode, "confirm");
  assert.ok(f.health.policy(run.authority).instructions);
  const report = await submit(f, run, [
    issue([
      {
        id: "fix",
        kind: "write",
        path: "tasks/index.md",
        expectedDigest: sha("旧入口"),
        content: "新入口",
        explanation: "修复目录中的旧入口",
      },
    ]),
  ]);
  assert.ok(report.messageId);
  assert.equal(report.issues[0]!.actions[0]!.beforeContent, "旧入口");
  assert.equal(await readFile(join(f.workspace, "tasks/index.md"), "utf8"), "旧入口");
  const other = f.store.createBot({ name: "Other", agentId: "other-test" });
  assert.throws(() => f.health.get(other.id, report.id), /未找到/);
  const result = await f.health.apply(f.bot.id, report.id, report.revision, ["fix"]);
  assert.equal(result.issues[0]!.actions[0]!.state, "applied");
  assert.equal(await readFile(join(f.workspace, "tasks/index.md"), "utf8"), "新入口");
  // 写入读回核对后，临时备份不再保留。
  assert.equal(result.issues[0]!.actions[0]!.recovery, undefined);
  assert.deepEqual(await readdir(join(f.root, "recovery")), []);
  await assert.rejects(f.health.apply(f.bot.id, report.id, report.revision, ["fix"]), /变化/);
  await assert.rejects(
    f.health.invoke({ ...run.authority, operation: "submit_report" }),
    /不能被模型覆盖/,
  );
  f.store.put<Message>("messages", {
    id: "engine-test",
    taskId: run.taskId,
    conversationId: f.store.privateConversation(f.bot.id).id,
    role: "assistant",
    blocks: [{ id: "native", kind: "text", text: "不应重复展示" }],
    final: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert.equal(
    f.store
      .messages(f.store.privateConversation(f.bot.id).id)
      .some((message) => message.id === "engine-test"),
    false,
  );
});

test("changed files and active Bot work prevent overwrites", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, "tasks/index.md"), "旧入口");
  const run = await f.start();
  let report = await submit(f, run, [
    issue([
      {
        id: "fix",
        kind: "write",
        path: "tasks/index.md",
        expectedDigest: sha("旧入口"),
        content: "新入口",
        explanation: "修复入口",
      },
    ]),
  ]);
  const task: Task = {
    id: "other",
    botId: f.bot.id,
    conversationId: "other",
    reportConversationId: "other",
    title: "正在工作",
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  f.store.put("tasks", task);
  await assert.rejects(f.health.apply(f.bot.id, report.id, report.revision, ["fix"]), /还有工作/);
  f.store.put("tasks", { ...task, status: "completed" });
  await writeFile(join(f.workspace, "tasks/index.md"), "用户的新内容");
  report = await f.health.apply(f.bot.id, report.id, report.revision, ["fix"]);
  assert.equal(report.issues[0]!.actions[0]!.state, "failed");
  assert.equal(await readFile(join(f.workspace, "tasks/index.md"), "utf8"), "用户的新内容");
});

test("later silent runs can repair memory and context as well as maintenance indexes", async (t) => {
  const f = await fixture(t, true);
  const first = await f.start();
  await submit(f, first, []);
  const task = f.store.get<Task>("tasks", first.taskId)!;
  f.store.put("tasks", { ...task, status: "completed" });
  await mkdir(join(f.workspace, "tasks/health-check"));
  await writeFile(join(f.workspace, "tasks/health-check/INDEX.md"), "old");
  await writeFile(join(f.workspace, "MEMORY.md"), "old memory");
  const run = await f.start();
  assert.equal(run.mode, "silent");
  const report = await submit(f, run, [
    issue([
      {
        id: "index",
        kind: "write",
        path: "tasks/health-check/INDEX.md",
        expectedDigest: sha("old"),
        content: "new",
        explanation: "更新体检入口",
      },
      {
        id: "memory",
        kind: "write",
        path: "MEMORY.md",
        expectedDigest: sha("old memory"),
        content: "verified memory",
        explanation: "更正已核实的记忆",
      },
    ]),
  ]);
  assert.equal(report.messageId, undefined);
  assert.equal(await readFile(join(f.workspace, "tasks/health-check/INDEX.md"), "utf8"), "new");
  assert.equal(await readFile(join(f.workspace, "MEMORY.md"), "utf8"), "verified memory");
});

test("unverified findings never run automatically but follow the user's explicit approval", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  for (const path of ["../outside", "tasks/../outside", "tasks//outside"]) {
    await assert.rejects(f.health.invoke({ ...run.authority, operation: "read_file", path }));
  }
  await symlink(join(f.workspace, "AGENTS.md"), join(f.workspace, "tasks/link.md"));
  await assert.rejects(
    f.health.invoke({ ...run.authority, operation: "read_file", path: "tasks/link.md" }),
    /符号链接/,
  );
  await assert.rejects(
    f.health.invoke({
      ...run.authority,
      operation: "submit_report",
      complete: false,
      gaps: [],
      summary: "未完成",
      issues: [],
    }),
    /缺少/,
  );
  await writeFile(join(f.workspace, "tasks/index.md"), "old");
  const report = await submit(f, run, [
    {
      ...issue([
        {
          id: "fix",
          kind: "write",
          path: "tasks/index.md",
          expectedDigest: sha("old"),
          content: "new",
          explanation: "待核实",
        },
      ]),
      certainty: "unverified",
    },
  ]);
  await assert.rejects(
    f.health.apply(f.bot.id, report.id, report.revision, ["fix"], true),
    /单独确认/,
  );
  const applied = await f.health.apply(f.bot.id, report.id, report.revision, ["fix"]);
  assert.equal(applied.issues[0]!.actions[0]!.state, "applied");
  assert.equal(await readFile(join(f.workspace, "tasks/index.md"), "utf8"), "new");
});

test("external references, memory and skill scripts produce executable plans applied in one submission", async (t) => {
  const f = await fixture(t);
  const external = join(f.root, "reference.csv");
  await writeFile(external, "name,share\nExample,60\n");
  await mkdir(join(f.workspace, "memory"), { recursive: true });
  await mkdir(join(f.workspace, "skills/example"), { recursive: true });
  const files = ["MEMORY.md", "memory/project.md", "USER.md", "skills/example/check.py", external];
  for (const path of files.slice(0, -1)) await writeFile(join(f.workspace, path), "old");
  const run = await f.start();
  const actions = [];
  for (const [index, path] of files.entries()) {
    const before = (await f.health.invoke({
      ...run.authority,
      operation: "read_file",
      path,
    })) as { content: string; digest: string };
    actions.push({
      id: `fix-${index}`,
      kind: "write",
      path,
      expectedDigest: before.digest,
      content: `${before.content}\nverified`,
      explanation: "按核实后的资料修订",
    });
  }
  const report = await submit(f, run, [issue(actions)]);
  for (const path of files.slice(0, -1))
    assert.equal(await readFile(join(f.workspace, path), "utf8"), "old");
  const result = await f.health.decide(f.bot.id, report.id, {
    revision: report.revision,
    submissionId: "approve-memory-and-reference",
    decisions: [{ issueId: "broken-index", choice: "apply" }],
  });
  assert.equal(result.batch?.state, "completed");
  assert.equal(result.batch?.taskId, undefined);
  assert.equal(f.store.list<Task>("tasks", -1).length, 1);
  for (const action of result.issues[0]!.actions) {
    assert.equal(action.state, "applied", action.error);
    const actualPath = action.path === external ? external : join(f.workspace, action.path!);
    assert.equal(await readFile(actualPath, "utf8"), action.content);
    assert.equal(action.recovery, undefined);
  }
});

test("duplicate-version cleanup keeps the selected file and moves only the approved unreferenced copy to Trash", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, "tasks/draft.txt"), "same");
  await writeFile(join(f.workspace, "tasks/final.txt"), "same");
  const run = await f.start();
  let report = await submit(f, run, [
    issue([
      {
        id: "old-version",
        kind: "trash",
        path: "tasks/draft.txt",
        expectedDigest: sha("same"),
        retainedPath: "tasks/final.txt",
        retainedDigest: sha("same"),
        explanation: "保留最终版，旧副本移入废纸篓",
        uniqueContent: "两个文件内容完全相同",
        referencesChecked: true,
        processesChecked: true,
        referencePaths: ["AGENTS.md"],
      },
    ]),
  ]);
  report = await f.health.apply(f.bot.id, report.id, report.revision, ["old-version"]);
  const action = report.issues[0]!.actions[0]!;
  if (process.platform === "darwin") {
    assert.equal(action.state, "applied", action.error);
    assert.equal(await readFile(join(f.workspace, "tasks/final.txt"), "utf8"), "same");
    assert.equal(await readFile(action.recovery!, "utf8"), "same");
    await assert.rejects(readFile(join(f.workspace, "tasks/draft.txt")), { code: "ENOENT" });
  } else assert.equal(action.state, "failed");
});

test("defer/dismiss persists without pretending an issue was solved", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  let report: HealthReport = await submit(f, run, [issue([handoff("plan")])]);
  report = await f.health.disposition(
    f.bot.id,
    report.id,
    report.revision,
    "broken-index",
    "dismissed",
    "这是刻意保留的历史索引",
  );
  assert.equal(report.issues[0]!.disposition, "dismissed");
  assert.equal(report.issues[0]!.certainty, "confirmed");
  assert.equal(report.issues[0]!.dispositionReason, "这是刻意保留的历史索引");
  f.store.put("tasks", { ...f.store.get<Task>("tasks", run.taskId)!, status: "completed" });
  const next = await f.start();
  const repeated = await submit(f, next, [issue([handoff("plan")])]);
  assert.equal(repeated.issues[0]!.disposition, "dismissed");
  f.store.put("tasks", { ...f.store.get<Task>("tasks", next.taskId)!, status: "completed" });
  const changed = await f.start();
  const fresh = await submit(f, changed, [
    { ...issue([handoff("plan")]), evidence: [{ path: "tasks/index.md", excerpt: "新证据" }] },
  ]);
  assert.equal(fresh.issues[0]!.disposition, undefined);
  const reopened = await f.health.disposition(
    f.bot.id,
    repeated.id,
    repeated.revision,
    "broken-index",
    "reopen",
    "用户选择重新处理",
  );
  assert.equal(reopened.issues[0]!.disposition, undefined);
  assert.equal(reopened.issues[0]!.dispositionReason, undefined);
});

test("incomplete first inspection never unlocks silent automatic changes", async (t) => {
  const f = await fixture(t, true);
  const run = await f.start();
  await f.health.invoke({
    ...run.authority,
    operation: "submit_report",
    summary: "尚未完成检查",
    complete: false,
    gaps: ["上下文暂时无法读取"],
    issues: [],
  });
  f.store.put("tasks", { ...f.store.get<Task>("tasks", run.taskId)!, status: "completed" });
  const next = await f.start();
  assert.equal(next.mode, "confirm");
  assert.equal(f.health.get(f.bot.id, next.reportId).first, true);
});

test("automatic consolidation requires separate permission, exact bytes and no remaining references", async (t) => {
  const f = await fixture(t, true);
  const first = await f.start();
  await submit(f, first, []);
  f.store.put("tasks", { ...f.store.get<Task>("tasks", first.taskId)!, status: "completed" });
  await writeFile(join(f.workspace, "tasks/draft.txt"), "draft");
  await writeFile(join(f.workspace, "tasks/final.txt"), "final");
  const action = {
    id: "old",
    kind: "trash",
    path: "tasks/draft.txt",
    expectedDigest: sha("draft"),
    retainedPath: "tasks/final.txt",
    retainedDigest: sha("final"),
    explanation: "保留最终版",
    uniqueContent: "有差异，需要确认",
    referencesChecked: true,
    processesChecked: true,
    referencePaths: [],
  };
  const run = await f.start();
  let report = await submit(f, run, [issue([action])]);
  assert.equal(report.issues[0]!.actions[0]!.state, undefined);
  assert.equal(await readFile(join(f.workspace, "tasks/draft.txt"), "utf8"), "draft");
  f.store.put("tasks", { ...f.store.get<Task>("tasks", run.taskId)!, status: "completed" });
  f.store.put("settings", {
    id: `exclusive-capability-audit:${f.bot.id}`,
    mode: "silent",
    scopeConfirmed: true,
    consolidateVersions: true,
  });
  const second = await f.start();
  report = await submit(f, second, [issue([action])]);
  assert.equal(report.issues[0]!.actions[0]!.state, "failed");
  assert.match(report.issues[0]!.actions[0]!.error!, /完全相同/);
  assert.equal(await readFile(join(f.workspace, "tasks/draft.txt"), "utf8"), "draft");
  f.store.put("tasks", { ...f.store.get<Task>("tasks", second.taskId)!, status: "completed" });
  await writeFile(join(f.workspace, "tasks/final.txt"), "draft");
  await writeFile(join(f.workspace, "tasks/reference.md"), "仍引用 tasks/draft.txt");
  const third = await f.start();
  report = await submit(f, third, [issue([{ ...action, retainedDigest: sha("draft") }])]);
  assert.equal(report.issues[0]!.actions[0]!.state, "failed");
  assert.match(report.issues[0]!.actions[0]!.error!, /仍有文件引用/);
  assert.equal(await readFile(join(f.workspace, "tasks/draft.txt"), "utf8"), "draft");
});

test("every finding requires a concrete plan and empty actions require a specific blocker", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  const incomplete = { ...issue(), plan: { steps: [] } };
  await assert.rejects(submit(f, run, [incomplete]), /具体处理步骤/);
  await assert.rejects(
    submit(f, run, [{ ...issue(), plan: { steps: ["更新入口"] } }]),
    /可执行方案/,
  );
  assert.equal(f.health.get(f.bot.id, run.reportId).state, "checking");
});

test("complete reports require reading the full exclusive skill bodies", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  const report = f.health.get(f.bot.id, run.reportId);
  f.store.put("settings", {
    ...report,
    coverage: { skillKeys: ["private:one"], readSkillKeys: [] },
  });
  await assert.rejects(submit(f, run, []), /read_skill/);
  f.store.put("settings", {
    ...report,
    coverage: { skillKeys: ["private:one"], readSkillKeys: ["private:one"] },
  });
  assert.equal((await submit(f, run, [])).complete, true);
});

test("batch applies approved items, defers the rest, and retries never repeat file effects", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, "tasks/index.md"), "old");
  const run = await f.start();
  const report = await submit(f, run, [
    issue([
      {
        id: "fix",
        kind: "write",
        path: "tasks/index.md",
        expectedDigest: sha("old"),
        content: "new",
        explanation: "更新目录",
      },
    ]),
    { ...issue([handoff("later-plan")]), id: "later", title: "稍后确认" },
  ]);
  const input = {
    revision: report.revision,
    submissionId: "batch-1",
    decisions: [
      { issueId: "broken-index", choice: "apply" },
      { issueId: "later", choice: "defer" },
    ],
  };
  const result = await f.health.decide(f.bot.id, report.id, input);
  assert.equal(result.batch?.state, "completed");
  assert.equal(result.issues[0]!.actions[0]!.state, "applied");
  assert.equal(result.issues[1]!.disposition, "deferred");
  assert.equal(await readFile(join(f.workspace, "tasks/index.md"), "utf8"), "new");
  const recovery = result.issues[0]!.actions[0]!.recovery;
  const retried = await f.health.decide(f.bot.id, report.id, input);
  assert.equal(retried.revision, result.revision);
  assert.equal(retried.issues[0]!.actions[0]!.recovery, recovery);
  await assert.rejects(
    f.health.decide(f.bot.id, report.id, { ...input, submissionId: "different" }),
    /已提交/,
  );
});

test("batch validates all choices and versions before writing any selected file", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, "tasks/one.md"), "one");
  await writeFile(join(f.workspace, "tasks/two.md"), "two");
  const run = await f.start();
  const report = await submit(f, run, [
    issue([
      {
        id: "one",
        kind: "write",
        path: "tasks/one.md",
        expectedDigest: sha("one"),
        content: "changed",
        explanation: "更新一",
      },
    ]),
    {
      ...issue([
        {
          id: "two",
          kind: "write",
          path: "tasks/two.md",
          expectedDigest: sha("two"),
          content: "changed",
          explanation: "更新二",
        },
      ]),
      id: "second",
    },
  ]);
  const input = {
    revision: report.revision,
    submissionId: "batch",
    decisions: [{ issueId: "broken-index", choice: "apply" }],
  };
  await assert.rejects(f.health.decide(f.bot.id, report.id, input), /每个待处理/);
  await writeFile(join(f.workspace, "tasks/two.md"), "user edit");
  const result = await f.health.decide(f.bot.id, report.id, {
    ...input,
    decisions: [...input.decisions, { issueId: "second", choice: "apply" }],
  });
  assert.equal(result.batch?.state, "failed");
  assert.equal(await readFile(join(f.workspace, "tasks/one.md"), "utf8"), "one");
  assert.equal(await readFile(join(f.workspace, "tasks/two.md"), "utf8"), "user edit");
});

test("custom instructions are consolidated into one proposal task before file approval", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, "tasks/index.md"), "old");
  const run = await f.start();
  const report = await submit(f, run, [
    issue([
      {
        id: "fix",
        kind: "write",
        path: "tasks/index.md",
        expectedDigest: sha("old"),
        content: "new",
        explanation: "修改",
      },
    ]),
    { ...issue([handoff("other-plan")]), id: "other" },
  ]);
  const result = await f.health.decide(f.bot.id, report.id, {
    revision: report.revision,
    submissionId: "custom",
    decisions: [
      { issueId: "broken-index", choice: "other", instruction: "保留两个入口" },
      { issueId: "other", choice: "defer" },
    ],
  });
  assert.equal(result.batch?.state, "needs_review");
  assert.ok(result.batch?.taskId);
  const followup = f.store.get<Task>("tasks", result.batch!.taskId!)!;
  assert.ok(followup.healthCheckId);
  assert.equal(f.store.list<Task>("tasks", -1).length, 2);
  assert.equal(await readFile(join(f.workspace, "tasks/index.md"), "utf8"), "old");
  f.store.put("tasks", { ...followup, status: "failed" });
  assert.equal(f.health.get(f.bot.id, report.id).batch?.state, "failed");
  f.store.put("settings", {
    ...report,
    id: followup.healthCheckId!,
    taskId: followup.id,
    state: "reported",
  });
  assert.equal(f.health.get(f.bot.id, report.id).batch?.state, "review_ready");
});

test("an empty proposal follow-up fails the original batch and does not publish a misleading empty card", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  const report = await submit(f, run, [issue([handoff("plan")])]);
  const decided = await f.health.decide(f.bot.id, report.id, {
    revision: report.revision,
    submissionId: "needs-plan",
    decisions: [{ issueId: "broken-index", choice: "other", instruction: "先确认保留哪个版本" }],
  });
  const followupTask = f.store.get<Task>("tasks", decided.batch!.taskId!)!;
  f.store.put("tasks", { ...followupTask, status: "running" });
  const conversation = f.store.privateConversation(f.bot.id);
  const sessionKey = f.store.engineSessionKey(conversation.id, f.bot.id);
  const runId = randomUUID();
  f.store.put("runs", {
    id: runId,
    taskId: followupTask.id,
    sessionKey,
    state: "running",
    generation: 1,
    lastSequence: -1,
    createdAt: Date.now(),
  });
  const authority = { agentId: f.bot.agentId, sessionKey, runId };
  const begun = (await f.health.invoke({ ...authority, operation: "begin" })) as {
    reportId: string;
  };
  await f.health.invoke({ ...authority, operation: "skills" });
  await f.health.invoke({
    ...authority,
    operation: "submit_report",
    summary: "方案未能整理成可确认的问题项",
    complete: false,
    gaps: ["体检工具未接受补充方案"],
    issues: [],
  });

  const followup = f.health.get(f.bot.id, begun.reportId);
  assert.equal(followup.messageId, undefined);
  const parent = f.health.get(f.bot.id, report.id);
  assert.equal(parent.batch?.state, "failed");
  assert.match(parent.batch?.error ?? "", /没有提交可确认的补充方案/);
  assert.equal(
    f.store
      .messages(conversation.id)
      .filter((message) => message.blocks.some((block) => block.kind === "health_check"))
      .length,
    1,
  );
});

test("new text plans use an explicit absent version and never replace a file created after approval", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  const info = (await f.health.invoke({
    ...run.authority,
    operation: "read_file",
    path: "tasks/INDEX.md",
  })) as { digest: string };
  assert.equal(info.digest, "absent");
  const report = await submit(f, run, [
    issue([
      {
        id: "create-index",
        kind: "write",
        path: "tasks/INDEX.md",
        expectedDigest: "absent",
        content: "任务入口",
        explanation: "新增任务入口",
      },
    ]),
  ]);
  const result = await f.health.decide(f.bot.id, report.id, {
    revision: report.revision,
    submissionId: "create",
    decisions: [{ issueId: "broken-index", choice: "apply" }],
  });
  assert.equal(result.batch?.state, "completed");
  assert.equal(await readFile(join(f.workspace, "tasks/INDEX.md"), "utf8"), "任务入口");
});

test("a finding without an executable plan is rejected instead of offered as a proposal", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  await assert.rejects(submit(f, run, [issue()]), /可执行方案/);
  await assert.rejects(
    submit(f, run, [issue([{ id: "x", kind: "instruction", target: "技能", steps: [], explanation: "改" }])]),
    /具体步骤/,
  );
  const report = await submit(f, run, [issue([handoff("plan")])]);
  assert.equal(report.issues[0]!.actions.length, 1);
});

test("fixes that are not plain files go back to the Bot as one normal task", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  const report = await submit(f, run, [
    issue([
      {
        id: "workshop-skill",
        kind: "instruction",
        target: "Workshop 技能：dividend-simulation-workbook",
        steps: [
          "先读当前版本确认写死的期间",
          "把 10 月目录改成按本次期间取值",
          "提交新版本并保留上一版",
        ],
        explanation: "技能把 10 月目录写死在步骤里，跨月会读错",
      },
    ]),
  ]);
  assert.equal(report.issues[0]!.actions[0]!.state, undefined);
  const result = await f.health.decide(f.bot.id, report.id, {
    revision: report.revision,
    submissionId: "handoff",
    decisions: [{ issueId: "broken-index", choice: "apply" }],
  });
  assert.equal(result.batch?.state, "completed");
  const action = result.issues[0]!.actions[0]!;
  assert.equal(action.state, "handed_off");
  const handoff = f.store.get<Task>("tasks", action.taskId!)!;
  assert.equal(handoff.title, "执行体检修改");
  assert.equal(handoff.healthCheckId, undefined);
  const text = f.store.find<{ message: string }>("submissions", "taskId", handoff.id)[0]!.message;
  assert.ok(text.includes("按本次期间取值"), text);
  assert.ok(!text.includes("expectedDigest"));
});

test("a hand-off fix must say what to do", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  await assert.rejects(
    submit(f, run, [
      issue([
        {
          id: "workshop-skill",
          kind: "instruction",
          target: "Workshop 技能",
          steps: [],
          explanation: "需要调整",
        },
      ]),
    ]),
    /具体步骤/,
  );
});

test("silent mode keeps hand-off fixes waiting for the user", async (t) => {
  const f = await fixture(t, true);
  const run = await f.start();
  assert.equal(run.mode, "confirm");
  const report = await submit(f, run, [
    issue([
      {
        id: "workshop-skill",
        kind: "instruction",
        target: "Workshop 技能",
        steps: ["按新期间改写"],
        explanation: "写死期间",
      },
    ]),
  ]);
  assert.equal(report.issues[0]!.actions[0]!.state, undefined);
  assert.equal(f.store.list<Task>("tasks", -1).length, 1);
});
