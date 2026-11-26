// Adapts the existing native audit schedule, adminPath/versioned file changes,
// durable settings/message records and native skill/context reads.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { validateWidgetCode } from "../../contracts/src/widget-code.ts";
import type { NativeContextPreview } from "../../kernel-runtime/src/context-preview.ts";
import { SkillDocuments } from "../../kernel-runtime/src/skill-documents.ts";
import { adminPath } from "./admin.ts";
import type { NativeAuthority } from "./authority.ts";
import { nativeTask } from "./authority.ts";
import type { BotHealthSettings } from "./bot-health-policy.ts";
import { BOT_HEALTH_INSTRUCTIONS, BOT_HEALTH_VERSION } from "./bot-health-policy.ts";
import type {
  HealthAction,
  HealthDecision,
  HealthIssue,
  HealthReport,
} from "./bot-health-types.ts";
import type { Artifact, Bot, Conversation, Message, Run, Task } from "./contracts.ts";
import type { Routine } from "./routines.ts";
import type { WorkbenchService } from "./service.ts";
import type { Workspaces } from "./workspaces.ts";

type HealthOptions = {
  preview?: (agentId: string) => Promise<NativeContextPreview>;
  recoveryRoot?: string;
  trashRoot?: string;
};
class RecoverableHealthError extends Error {
  readonly recovery: string;
  constructor(message: string, recovery: string) {
    super(message);
    this.recovery = recovery;
  }
}
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
/** Host-executed file effects carry a version so the write can be verified first. */
type FileAction = HealthAction & { kind: "write" | "trash"; path: string; expectedDigest: string };
function isFileAction(action: HealthAction): action is FileAction {
  return action.kind !== "instruction";
}
const text = (value: unknown, max = 8000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("体检内容不完整或过长");
  return value;
};
const array = (value: unknown, max = 100): unknown[] => {
  if (!Array.isArray(value) || value.length > max) throw new Error("体检列表不完整或过长");
  return value;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("体检内容格式不正确");
  return value as Record<string, unknown>;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new Error("体检分类不正确");
  return value as T;
}
function digest(value: unknown): string {
  const result = text(value, 64);
  if (result === "absent") return result;
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error("请先读取文件取得当前版本");
  return result;
}
function pathName(value: unknown): string {
  const path = text(value, 1000);
  if (
    path.includes("\\") ||
    path.split("/").some((part, index) => (!part && index !== 0) || part === "." || part === "..") ||
    [...path].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("请使用相对文件路径或完整的绝对路径");
  return path;
}
function healthPath(root: string, path: string, allowAbsent = false) {
  return isAbsolute(path)
    ? adminPath(dirname(path), basename(path), allowAbsent)
    : adminPath(root, path, allowAbsent);
}
function parseIssues(input: unknown): HealthIssue[] {
  const ids = new Set<string>();
  const actionIds = new Set<string>();
  return array(input, 80).map((value) => {
    const item = object(value);
    const id = text(item.id, 120);
    if (ids.has(id)) throw new Error("同一问题不能重复提交");
    ids.add(id);
    if (!item.plan) throw new Error("每项问题必须提供 plan.steps 具体处理方案");
    const plan = object(item.plan);
    const steps = array(plan.steps, 6).map((step) => text(step, 300));
    if (!steps.length) throw new Error("每项问题必须提供具体处理步骤");
    if (!item.actions || !Array.isArray(item.actions) || !item.actions.length)
      throw new Error("每项问题必须给出可执行方案；不能直接改文件时用 kind:instruction 交给 Bot 执行");
    const illustration = plan.illustration ? object(plan.illustration) : undefined;
    if (illustration) {
      const format = choice(illustration.format, ["svg", "html"]);
      const error = validateWidgetCode(text(illustration.code, 50000), format);
      if (error) throw new Error(`解释图格式需要调整：${error}`);
    }
    return {
      id,
      category: choice(item.category, ["context", "memory", "skills", "workspace"]),
      priority: choice(item.priority, ["P0", "P1", "P2", "P3"]),
      certainty: choice(item.certainty, ["confirmed", "suggestion", "unverified"]),
      title: text(item.title, 80),
      problem: text(item.problem, 400),
      impact: text(item.impact, 300),
      suggestion: text(item.suggestion, 300),
      plan: {
        steps,
        ...(plan.limitation ? { limitation: text(plan.limitation, 2000) } : {}),
        ...(plan.diagram ? { diagram: text(plan.diagram, 12000) } : {}),
        ...(illustration
          ? {
              illustration: {
                title: text(illustration.title, 100),
                format: choice(illustration.format, ["svg", "html"]),
                code: text(illustration.code, 50000),
              },
            }
          : {}),
      },
      evidence: array(item.evidence, 20).map((value) => {
        const evidence = object(value);
        return { path: text(evidence.path, 1000), excerpt: text(evidence.excerpt, 2000) };
      }),
      actions: array(item.actions ?? [], 20).map((value) => {
        const action = object(value);
        const id = text(action.id, 120);
        if (actionIds.has(id)) throw new Error("修改方案标识不能重复");
        actionIds.add(id);
        const kind = choice(action.kind, ["write", "trash", "instruction"]);
        const explanation = text(action.explanation);
        if (kind === "instruction") {
          const steps = array(action.steps ?? [], 20).map((step) => text(step, 2000));
          if (!steps.length) throw new Error("交给 Bot 执行的方案必须写明具体步骤");
          return { id, kind, target: text(action.target, 200), steps, explanation };
        }
        if (typeof action.path !== "string") throw new Error("文件修改请提供 path");
        if (typeof action.expectedDigest !== "string")
          throw new Error("文件修改请先读取文件取得 expectedDigest");
        return {
          id,
          kind,
          path: pathName(action.path),
          expectedDigest: digest(action.expectedDigest),
          explanation,
          ...(kind === "write"
            ? {
                content:
                  typeof action.content === "string" && action.content.length <= 500_000
                    ? action.content
                    : (() => {
                        throw new Error("请提供完整修改正文");
                      })(),
              }
            : {
                retainedPath: pathName(action.retainedPath),
                retainedDigest: digest(action.retainedDigest),
                referencePaths: array(action.referencePaths ?? [], 100).map(pathName),
                uniqueContent: text(action.uniqueContent),
                referencesChecked: action.referencesChecked === true,
                processesChecked: action.processesChecked === true,
              }),
        };
      }),
    };
  });
}

/** Model supplies findings/plans; only the host executes reviewed file effects. */
export class BotHealth {
  private readonly applying = new Set<string>();
  private readonly applyingBots = new Set<string>();
  private readonly inspections = new Map<string, Promise<unknown>>();
  private readonly batches = new Map<string, Promise<HealthReport>>();
  private readonly service: WorkbenchService;
  private readonly workspaces: Workspaces;
  private readonly options: HealthOptions;
  constructor(service: WorkbenchService, workspaces: Workspaces, options: HealthOptions = {}) {
    this.service = service;
    this.workspaces = workspaces;
    this.options = options;
  }
  private settings(botId: string): BotHealthSettings {
    const saved = this.service.store.get<BotHealthSettings>(
      "settings",
      `exclusive-capability-audit:${botId}`,
    );
    return {
      mode: saved?.mode ?? "confirm",
      consolidateVersions: saved?.consolidateVersions === true,
      scopeConfirmed: saved?.scopeConfirmed === true,
    };
  }
  private reports(botId: string) {
    return this.service.store
      .list<HealthReport>("settings", -1)
      .filter((item) => item.version === BOT_HEALTH_VERSION && item.botId === botId)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }
  get(botId: string, id: string) {
    const report = this.service.store.get<HealthReport>("settings", id);
    if (!report || report.version !== BOT_HEALTH_VERSION || report.botId !== botId)
      throw new Error("未找到这个 Bot 的体检报告");
    if (report.batch?.state === "needs_review" && report.batch.taskId) {
      const next = this.service.store.get<HealthReport>(
        "settings",
        `bot-health:${report.batch.taskId}`,
      );
      if (next?.state === "reported" && next.issues.length > 0)
        return { ...report, batch: { ...report.batch, state: "review_ready" as const } };
      if (next?.state === "reported")
        return {
          ...report,
          batch: {
            ...report.batch,
            state: "failed" as const,
            error:
              "Bot 没有提交可确认的补充方案；该项目没有执行修改。请重新体检后再试。",
          },
        };
      const task = this.service.store.get<Task>("tasks", report.batch.taskId);
      if (task && ["failed", "cancelled", "interrupted", "completed"].includes(task.status))
        return {
          ...report,
          batch: {
            ...report.batch,
            state: "failed" as const,
            error: "补充方案未生成，请在会话中重新发起体检",
          },
        };
    }
    return report;
  }
  private save(report: HealthReport): HealthReport {
    return this.service.store.put(
      "settings",
      { ...report, revision: randomUUID() },
      "bot-health.changed",
    );
  }
  policy(input: NativeAuthority) {
    // Prompt hooks may precede the run mirror, so also recognize scheduled sessions.
    const bot = this.service.store
      .list<Bot>("bots", -1)
      .find((bot) => bot.agentId === input.agentId);
    const run = this.service.store.get<Run>("runs", input.runId);
    const task = run && this.service.store.get<Task>("tasks", run.taskId);
    const settings =
      bot &&
      this.service.store.get<{ id: string; routineId?: string; scopeConfirmed?: boolean }>(
        "settings",
        `exclusive-capability-audit:${bot.id}`,
      );
    const schedule =
      settings?.scopeConfirmed && settings.routineId
        ? this.service.store.get<Routine>("routines", settings.routineId)
        : undefined;
    const scheduledSession =
      bot &&
      schedule?.state !== "removed" &&
      schedule &&
      this.service.store.engineSessionKey(schedule.conversationId, bot.id) === input.sessionKey;
    const active = !!(task?.healthCheckId || scheduledSession);
    return {
      instructions: active
        ? BOT_HEALTH_INSTRUCTIONS
        : "用户明确要求为你自己做体检时，调用 livingbot_health_check begin；只检查时传 onlyInspect:true。工具会返回范围、检查规则和后续报告流程。不要把普通业务请求当成体检。",
    };
  }
  async invoke(input: NativeAuthority & Record<string, unknown>) {
    const { bot, task } = nativeTask(this.service.store, input);
    if (
      this.service.store.get<Conversation>("conversations", task.conversationId)?.kind !== "private"
    )
      throw new Error("请在这个 Bot 的私聊里进行体检，避免向群聊暴露私人资料");
    const operation = text(input.operation, 40);
    if (operation === "begin") {
      const key = `health-inspection:${task.id}`;
      const pending = this.inspections.get(key);
      if (pending) return pending;
      const work = this.begin(bot, task, input).finally(() => this.inspections.delete(key));
      this.inspections.set(key, work);
      return work;
    }
    const report = this.get(bot.id, task.healthCheckId ?? "");
    if (report.taskId !== task.id || report.runId !== input.runId || report.state !== "checking")
      throw new Error("请先开始体检；已提交的报告不能被模型覆盖");
    const root = join(this.workspaces.root, bot.agentId);
    if (operation === "context") {
      if (!this.options.preview) throw new Error("上下文预览暂不可用，请将这一项列为未验证");
      return this.options.preview(bot.agentId);
    }
    if (operation === "list_files") {
      const path = input.path ? await healthPath(root, pathName(input.path)) : root;
      const items = await readdir(path, { withFileTypes: true });
      if (items.length > 1000) throw new Error("目录过大，请分批检查");
      return items.map((item) => ({
        name: item.name,
        kind: item.isSymbolicLink() ? "link" : item.isDirectory() ? "directory" : "file",
      }));
    }
    if (operation === "read_file" || operation === "file_info") {
      const path = pathName(input.path);
      const result = await this.read(
        await healthPath(root, path, operation === "read_file"),
        operation === "file_info",
        operation === "read_file",
      );
      return { ...result, path };
    }
    if (operation === "tasks")
      return this.service.store
        .list<Task>("tasks", -1)
        .filter((item) => item.botId === bot.id && !item.healthCheckId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 100)
        .map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          updatedAt: item.updatedAt,
        }));
    if (operation === "skills") {
      const skills = await new SkillDocuments(this.service.kernel).list(bot.agentId);
      const latest = this.get(bot.id, report.id);
      this.save({
        ...latest,
        coverage: {
          skillKeys: skills.map((skill) => skill.key),
          readSkillKeys: latest.coverage?.readSkillKeys ?? [],
        },
      });
      return skills;
    }
    if (operation === "read_skill") {
      const path = input.path ? pathName(input.path) : "SKILL.md";
      const document = await new SkillDocuments(this.service.kernel).read(
        bot.agentId,
        text(input.skillKey, 1000),
        path,
      );
      if (path === "SKILL.md") {
        const latest = this.get(bot.id, report.id);
        this.save({
          ...latest,
          coverage: {
            skillKeys: latest.coverage?.skillKeys ?? [],
            readSkillKeys: [
              ...new Set([...(latest.coverage?.readSkillKeys ?? []), document.skill.key]),
            ],
          },
        });
      }
      return document;
    }
    if (operation === "submit_report") return this.submit(bot, report, input);
    throw new Error("不支持这项体检操作");
  }
  private async begin(bot: Bot, task: Task, input: NativeAuthority & Record<string, unknown>) {
    const id = task.healthCheckId ?? `bot-health:${task.id}`;
    let report = this.service.store.get<HealthReport>("settings", id);
    if (!report) {
      const settings = this.settings(bot.id);
      const first = !this.reports(bot.id).some(
        (report) => report.state === "reported" && report.complete,
      );
      report = this.save({
        id,
        botId: bot.id,
        taskId: task.id,
        runId: input.runId,
        version: BOT_HEALTH_VERSION,
        createdAt: Date.now(),
        revision: "",
        mode: first || input.onlyInspect === true ? "confirm" : settings.mode,
        first,
        state: "checking",
        summary: "",
        complete: false,
        gaps: [],
        issues: [],
      });
      this.service.store.put("tasks", { ...task, healthCheckId: id, title: "Bot 体检" });
    }
    const previous = this.reports(bot.id)
      .filter((item) => item.id !== id && item.state === "reported")
      .slice(0, 3);
    const knownIssues = new Map<string, HealthIssue>();
    for (const prior of this.reports(bot.id).filter(
      (item) => item.id !== id && item.state === "reported",
    )) {
      for (const issue of prior.issues)
        if (!knownIssues.has(issue.id)) knownIssues.set(issue.id, issue);
    }
    return {
      reportId: report.id,
      mode: report.mode,
      first: report.first,
      instructions: BOT_HEALTH_INSTRUCTIONS,
      workspace: join(this.workspaces.root, bot.agentId),
      previous,
      knownIssues: [...knownIssues.values()].map(({ actions, ...issue }) => ({
        ...issue,
        actions: actions.map(({ id, path, target, state }) => ({ id, path, target, state })),
      })),
      automaticVersionConsolidation: this.settings(bot.id).consolidateVersions,
    };
  }
  private async submit(bot: Bot, current: HealthReport, input: Record<string, unknown>) {
    if (typeof input.complete !== "boolean") throw new Error("请说明本次检查是否完成");
    // A completed inspection may omit the optional gaps field in the native schema.
    // Keep malformed values invalid, and still require gaps for incomplete reports.
    if (input.gaps !== undefined && (!Array.isArray(input.gaps) || input.gaps.length > 40))
      throw new Error("gaps 必须是未完成项列表，最多 40 项；没有未完成项时传 []");
    const gaps = array(input.gaps === undefined ? [] : input.gaps, 40).map((value) => text(value, 2000));
    const issues = parseIssues(input.issues);
    const plannedPaths = issues.flatMap((issue) =>
      issue.actions.filter(isFileAction).map((action) => action.path),
    );
    if (plannedPaths.length > 100) throw new Error("本批修改过多，请将检查范围分成可确认的批次");
    if (new Set(plannedPaths).size !== plannedPaths.length)
      throw new Error("多个问题修改同一文件，请把具体改动合并为一个方案，其他问题说明关联关系");
    if (
      input.complete &&
      (!current.coverage ||
        current.coverage.skillKeys.some((key) => !current.coverage!.readSkillKeys.includes(key)))
    )
      throw new Error(
        "专属能力尚未检查完：请先 skills，再 read_skill 读取每个技能正文；确实无法读取时提交未完成项",
      );
    // Carry the user's decision forward only for exactly the same evidence.
    // Changed evidence must be reviewed again; prose similarity is not graded.
    for (const issue of issues) {
      const prior = this.reports(bot.id)
        .filter((report) => report.id !== current.id)
        .flatMap((report) => report.issues)
        .find((item) => item.id === issue.id);
      if (prior?.disposition && JSON.stringify(prior.evidence) === JSON.stringify(issue.evidence)) {
        issue.disposition = prior.disposition;
        issue.dispositionReason = prior.dispositionReason;
      }
    }
    const root = join(this.workspaces.root, bot.agentId);
    for (const action of issues.flatMap((issue) => issue.actions).filter(isFileAction)) {
      this.checkWritable(action);
      const before = await this.read(
        await healthPath(root, action.path, action.kind === "write"),
        action.kind === "trash",
        action.kind === "write",
      );
      if (before.digest !== action.expectedDigest)
        throw new Error("方案引用的文件已变化，请重新读取后再提交");
      if (action.kind === "write") action.beforeContent = before.content;
    }
    if (!input.complete && !gaps.length) throw new Error("检查未完成时请说明还缺少什么");
    if (issues.some((issue) => issue.certainty === "confirmed" && !issue.evidence.length))
      throw new Error("已确认的问题必须提供证据");
    let report = this.save({
      ...current,
      state: "reported",
      summary: text(input.summary, 1200),
      complete: input.complete && !gaps.length,
      gaps,
      issues,
    });
    if (report.mode === "silent") {
      const eligible = issues
        .filter(
          (issue) => !issue.disposition && issue.certainty === "confirmed" && issue.actions.length,
        )
        .flatMap((issue) => issue.actions)
        .filter((action) => this.automatic(action, bot.id))
        .map((action) => action.id);
      if (eligible.length)
        report = await this.apply(bot.id, report.id, report.revision, eligible, true);
    }
    const proposalFollowup = this.reports(bot.id).some(
      (item) => item.batch?.taskId === current.taskId,
    );
    const notify =
      !(proposalFollowup && report.issues.length === 0) &&
      (report.mode === "confirm" ||
        !report.complete ||
        report.issues.some(
          (issue) =>
            (issue.certainty === "confirmed" && ["P0", "P1"].includes(issue.priority)) ||
            issue.actions.some(
              (action) => action.state === "failed" || action.kind === "instruction",
            ),
        ));
    if (notify) report = this.publish(report);
    return { reportId: report.id, saved: true, published: notify, reply: "NO_REPLY" };
  }
  private publish(report: HealthReport) {
    const conversation = this.service.store.privateConversation(report.botId);
    const messageId = report.messageId ?? `health-report:${report.id}`;
    const now = Date.now();
    this.service.store.put<Message>(
      "messages",
      {
        id: messageId,
        conversationId: conversation.id,
        botId: report.botId,
        role: "assistant",
        final: true,
        blocks: [
          {
            id: "health-result",
            kind: "health_check",
            reportId: report.id,
            botId: report.botId,
            summary: report.summary,
          },
        ],
        createdAt: report.createdAt,
        updatedAt: now,
      },
      "messages.delivered",
    );
    return this.save({ ...report, messageId });
  }
  private automatic(action: HealthAction, botId: string) {
    if (action.kind === "trash") return this.settings(botId).consolidateVersions;
    // 交给 Bot 执行会开启一次新的会话任务，静默模式不代用户发起。
    if (action.kind === "instruction") return false;
    return true;
  }
  async disposition(
    botId: string,
    id: string,
    revision: string,
    issueId: string,
    disposition: "deferred" | "dismissed" | "reopen",
    reason: string,
  ) {
    if (this.applying.has(id) || this.batches.has(id))
      throw new Error("正在处理修改，请稍后再操作");
    const report = this.get(botId, id);
    if (report.revision !== revision || !report.issues.some((issue) => issue.id === issueId))
      throw new Error("报告已变化，请刷新后再操作");
    const updated = this.save({
      ...report,
      issues: report.issues.map((issue) =>
        issue.id === issueId
          ? {
              ...issue,
              disposition: disposition === "reopen" ? undefined : disposition,
              dispositionReason: disposition === "reopen" ? undefined : text(reason, 1000),
            }
          : issue,
      ),
    });
    return updated.messageId ? this.publish(updated) : updated;
  }
  decide(botId: string, id: string, input: Record<string, unknown>): Promise<HealthReport> {
    if (this.batches.has(id)) return Promise.reject(new Error("正在处理这份报告，请稍后刷新"));
    const work = this.decideBatch(botId, id, input).finally(() => this.batches.delete(id));
    this.batches.set(id, work);
    return work;
  }
  private async decideBatch(botId: string, id: string, input: Record<string, unknown>) {
    let report = this.get(botId, id);
    const submissionId = text(input.submissionId, 120);
    const decisions: HealthDecision[] = array(input.decisions, 80).map((value) => {
      const item = object(value);
      const decision: HealthDecision = {
        issueId: text(item.issueId, 120),
        choice: choice(item.choice, ["defer", "apply", "other"]),
      };
      if (decision.choice === "other") decision.instruction = text(item.instruction, 2000);
      return decision;
    });
    if (report.batch) {
      if (
        report.batch.id !== submissionId ||
        JSON.stringify(report.batch.decisions) !== JSON.stringify(decisions)
      )
        throw new Error("这份报告已提交，请查看处理结果或新的方案");
      // A lost HTTP acknowledgement must never execute the approved batch again.
      if (report.batch.state !== "processing") return report;
      if (
        report.issues.some((issue) => issue.actions.some((action) => action.state === "applying"))
      )
        throw new Error("上次执行结果尚未确认，请复查文件后重新体检");
    } else {
      if (report.revision !== input.revision || report.state !== "reported")
        throw new Error("报告已变化，请重新查看方案");
      const pending = report.issues.filter(
        (issue) =>
          !issue.disposition &&
          (!issue.actions.length || issue.actions.some((action) => !action.state)),
      );
      if (
        !decisions.length ||
        new Set(decisions.map((item) => item.issueId)).size !== decisions.length ||
        pending.length !== decisions.length ||
        pending.some((issue) => !decisions.some((item) => item.issueId === issue.id))
      )
        throw new Error("请为每个待处理问题选择一种处理方式");
      const bot = this.service.store.get<Bot>("bots", botId);
      if (!bot || bot.archivedAt) throw new Error("请先恢复这个 Bot");
      if (this.applying.has(id) || this.applyingBots.has(botId))
        throw new Error("这个 Bot 正在处理体检修改，请稍后刷新");
      const ids = decisions.filter((item) => item.choice === "apply").map((item) => item.issueId);
      const paths = report.issues
        .filter((issue) => ids.includes(issue.id))
        .flatMap((issue) =>
          issue.actions
            .filter(isFileAction)
            .filter((action) => !action.state)
            .map((action) => action.path),
        );
      if (new Set(paths).size !== paths.length)
        throw new Error("多个方案修改同一文件，请先合并方案");
      report = this.save({
        ...report,
        batch: { id: submissionId, state: "processing", decisions },
        issues: report.issues.map((issue) =>
          decisions.some((item) => item.issueId === issue.id && item.choice === "defer")
            ? { ...issue, disposition: "deferred", dispositionReason: "用户选择暂不处理" }
            : issue,
        ),
      });
    }
    try {
      const approved = decisions
        .filter((item) => item.choice === "apply")
        .map((item) => item.issueId);
      const actionIds = report.issues
        .filter((issue) => approved.includes(issue.id))
        .flatMap((issue) =>
          issue.actions.filter((action) => !action.state).map((action) => action.id),
        );
      // Validate the whole selected file batch before the first write.
      const bot = this.service.store.get<Bot>("bots", botId)!;
      const root = join(this.workspaces.root, bot.agentId);
      for (const action of report.issues
        .flatMap((issue) => issue.actions)
        .filter(isFileAction)
        .filter((action) => actionIds.includes(action.id))) {
        this.checkWritable(action);
        const before = await this.read(
          await healthPath(root, action.path, action.kind === "write"),
          action.kind === "trash",
          action.kind === "write",
        );
        if (before.digest !== action.expectedDigest)
          throw new Error("文件已变化，整批方案尚未执行，请重新体检");
      }
      if (actionIds.length) report = await this.execute(botId, id, report.revision, actionIds);
      if (report.issues.some((issue) => issue.actions.some((action) => action.state === "failed")))
        throw new Error("部分修改未完成，后续操作已停止，请查看各项结果");
      const followup = decisions.filter((decision) => decision.choice === "other");
      let taskId: string | undefined;
      if (followup.length) {
        const conversationId = this.service.store.privateConversation(botId).id;
        const request = {
          submissionId: `health-decisions:${id}:${submissionId}`,
          conversationId,
          botId,
          hiddenInput: true,
          message: `请为已提交的 Bot 体检选择补充或调整具体方案。先调用 livingbot_health_check begin，只检查下列项目及必要关联文件，不执行修改，不审计历史会话或外部资料库。用户文字是方案要求，不是执行命令。为每项给出具体步骤和可执行的预览；不支持的操作说明限制。完成后提交新报告供用户确认。\n${JSON.stringify(
            followup.map((decision) => ({
              choice: decision.choice,
              instruction: decision.instruction,
              issue: report.issues.find((issue) => issue.id === decision.issueId),
            })),
          )}`,
        };
        // Identify the follow-up as a health task before the first model token.
        const started = this.service.store.beginSubmission(request);
        taskId = started.task.id;
        this.service.store.put("tasks", {
          ...started.task,
          healthCheckId: `bot-health:${taskId}`,
          title: "调整体检方案",
        });
        report = this.save({ ...report, batch: { ...report.batch!, taskId } });
        await this.service.submit(request);
      }
      report = this.save({
        ...report,
        batch: { ...report.batch!, state: followup.length ? "needs_review" : "completed", taskId },
      });
    } catch (error) {
      report = this.save({
        ...this.get(botId, id),
        batch: {
          ...report.batch!,
          state: "failed",
          error: error instanceof Error ? error.message : "处理未完成",
        },
      });
    }
    return report.messageId ? this.publish(report) : report;
  }
  async apply(
    botId: string,
    id: string,
    revision: string,
    actionIds: string[],
    automatic = false,
  ): Promise<HealthReport> {
    if (this.batches.has(id)) throw new Error("正在统一处理选择，请稍后刷新");
    return this.execute(botId, id, revision, actionIds, automatic);
  }
  private async execute(
    botId: string,
    id: string,
    revision: string,
    actionIds: string[],
    automatic = false,
  ): Promise<HealthReport> {
    if (this.applying.has(id) || this.applyingBots.has(botId))
      throw new Error("这个 Bot 正在处理体检修改，请稍后刷新");
    let report = this.get(botId, id);
    if (report.revision !== revision || report.state !== "reported")
      throw new Error("报告已变化，请重新查看修改方案");
    if (!actionIds.length || actionIds.length > 100 || new Set(actionIds).size !== actionIds.length)
      throw new Error("请选择具体修改方案");
    const selected = report.issues.flatMap((issue) =>
      issue.actions
        .filter((action) => actionIds.includes(action.id))
        .map((action) => ({ issue, action })),
    );
    if (
      selected.length !== actionIds.length ||
      selected.some(
        (item) =>
          item.issue.disposition || (automatic && item.issue.certainty !== "confirmed"),
      )
    )
      throw new Error("方案不存在、已暂缓或还需要单独确认");
    const bot = this.service.store.get<Bot>("bots", botId);
    if (!bot || bot.archivedAt) throw new Error("请先恢复这个 Bot");
    if (
      this.service.store
        .list<Task>("tasks", -1)
        .some(
          (task) =>
            task.botId === botId &&
            task.id !== report.taskId &&
            (["queued", "running", "waiting", "stopping"].includes(task.status) ||
              task.processes?.some(
                (process) => !["completed", "failed", "killed"].includes(process.status),
              )),
        )
    )
      throw new Error("这个 Bot 还有工作在执行，请结束后再优化文件");
    const paths = selected
      .map((item) => item.action)
      .filter(isFileAction)
      .map((action) => action.path);
    if (new Set(paths).size !== paths.length) throw new Error("多个方案修改同一文件，请先合并方案");
    this.applying.add(id);
    this.applyingBots.add(botId);
    try {
      const handled: { issue: HealthIssue; action: HealthAction }[] = [];
      for (const { issue, action } of selected) {
        if (action.state === "applied" || action.state === "handed_off") continue;
        if (action.state) throw new Error("这项修改已有执行记录，请复查后重新制定方案");
        if (automatic && (!this.automatic(action, botId) || issue.certainty !== "confirmed"))
          throw new Error("这项修改需要单独确认");
        if (!isFileAction(action)) {
          handled.push({ issue, action });
          continue;
        }
        report = this.setAction(report, action.id, { state: "applying" });
        try {
          const result = await this.effect(bot, action, automatic);
          report = this.setAction(report, action.id, {
            state: "applied",
            recovery: result.recovery,
          });
        } catch (error) {
          report = this.setAction(report, action.id, {
            state: "failed",
            error: error instanceof Error ? error.message : "修改未完成",
            ...(error instanceof RecoverableHealthError ? { recovery: error.recovery } : {}),
          });
          return report.messageId ? this.publish(report) : report; // Stop dependent work after a failure.
        }
      }
      if (handled.length) report = await this.handOff(bot, report, handled);
      return report.messageId ? this.publish(report) : report;
    } finally {
      this.applying.delete(id);
      this.applyingBots.delete(botId);
    }
  }
  /** Fixes the host cannot perform as files go back to the Bot, which uses its normal tools. */
  private async handOff(
    bot: Bot,
    report: HealthReport,
    items: { issue: HealthIssue; action: HealthAction }[],
  ): Promise<HealthReport> {
    const request = {
      submissionId: `health-handoff:${report.id}:${items
        .map(({ action }) => action.id)
        .sort()
        .join(",")}`,
      conversationId: this.service.store.privateConversation(bot.id).id,
      botId: bot.id,
      hiddenInput: true,
      message: `Bot 体检里这些修改用户已经确认，请直接用你平时的工具完成，不要重新体检，也不用再问一遍。\n${items
        .map(
          ({ issue, action }, index) =>
            `${index + 1}. ${issue.title}${action.target ? `（${action.target}）` : ""}\n${(
              action.steps ?? []
            )
              .map((step) => `   - ${step}`)
              .join("\n")}`,
        )
        .join("\n")}\n完成后说明改了什么、怎么确认的。`,
    };
    const started = this.service.store.beginSubmission(request);
    this.service.store.put("tasks", { ...started.task, title: "执行体检修改" });
    await this.service.submit(request);
    return items.reduce(
      (next, { action }) =>
        this.setAction(next, action.id, { state: "handed_off", taskId: started.task.id }),
      report,
    );
  }
  private setAction(report: HealthReport, id: string, patch: Partial<HealthAction>) {
    return this.save({
      ...report,
      issues: report.issues.map((issue) => ({
        ...issue,
        actions: issue.actions.map((action) =>
          action.id === id ? { ...action, ...patch } : action,
        ),
      })),
    });
  }
  private async read(path: string, binary = false, allowAbsent = false) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (error: NodeJS.ErrnoException) => {
        if (allowAbsent && error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!file) return { digest: "absent", bytes: 0, content: "", exists: false };
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > (binary ? 25_000_000 : 1_000_000))
        throw new Error("文件过大或不是普通文件，请列为未验证");
      const data = await file.readFile();
      const after = await file.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
        throw new Error("文件已变化，请重新读取");
      if (!binary && data.includes(0))
        throw new Error("这是二进制文件，请使用 file_info，内容未验证");
      return {
        digest: hash(data),
        bytes: data.length,
        ...(!binary ? { content: data.toString("utf8") } : {}),
      };
    } finally {
      await file.close();
    }
  }
  private async effect(
    bot: Bot,
    action: FileAction,
    automatic: boolean,
  ): Promise<{ recovery?: string }> {
    const root = join(this.workspaces.root, bot.agentId);
    this.checkWritable(action);
    const path = await healthPath(root, action.path, action.kind === "write");
    const before = await this.read(path, action.kind === "trash", action.kind === "write");
    if (before.digest !== action.expectedDigest)
      throw new Error("文件已变化，旧方案已失效，请重新体检");
    if (before.digest === "absent") {
      if (action.kind !== "write" || action.content === undefined) throw new Error("文件不存在");
      const file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(action.content);
        await file.sync();
        if ((await this.read(path)).digest !== hash(action.content))
          throw new Error("新增文件读回验证失败");
      } finally {
        await file.close();
      }
      this.service.store.recordEvent("bot-health.created", bot.id, { actionId: action.id, path });
      return { recovery: "原路径不存在；如需撤销，将新增文件移入废纸篓" };
    }
    return this.effectExisting(bot, action, automatic, root, path, before);
  }
  private checkWritable(action: HealthAction) {
    if (action.kind === "write" && action.content === undefined)
      throw new Error("当前只支持预览过的文本修改");
  }
  private async effectExisting(
    bot: Bot,
    action: FileAction,
    automatic: boolean,
    root: string,
    path: string,
    before: { digest: string },
  ): Promise<{ recovery?: string }> {
    if (action.kind === "trash") {
      if (
        !action.retainedPath ||
        action.retainedPath === action.path ||
        !action.retainedDigest ||
        !action.referencesChecked ||
        !action.processesChecked
      )
        throw new Error("还没有确认保留版本、引用或进程占用，本次未移走文件");
      const kept = await this.read(await healthPath(root, action.retainedPath), true);
      if (kept.digest !== action.retainedDigest)
        throw new Error("准备保留的版本已经变化，请重新检查");
      if (automatic && kept.digest !== before.digest)
        throw new Error("自动收敛只处理完全相同的副本，迭代版本需要你确认");
      const artifacts = this.service.store.list<Artifact>("artifacts", -1);
      if (
        artifacts.some(
          (item) => !item.trashedAt && (item.path === path || item.sourcePath === path),
        )
      )
        throw new Error("此文件仍关联交付记录，请先确定交付入口，本次保留原文件");
      await this.assertNoReferences(root, action.path, action.retainedPath);
      if (process.platform === "darwin") {
        try {
          const result = await promisify(execFile)("/usr/sbin/lsof", ["-t", path], {
            timeout: 5000,
          });
          if (result.stdout.trim()) throw new Error("文件仍被程序使用，本次保留");
        } catch (error) {
          if ((error as { code?: number }).code !== 1) throw error;
        }
      } else throw new Error("当前平台暂不能核验文件占用，本次保留原文件");
      const container = await mkdtemp(
        join(this.options.trashRoot ?? join(homedir(), ".Trash"), "LivingBot-health-"),
      );
      const recovery = join(container, basename(path));
      // Recheck after reference/process scans, which may take time.
      if (
        (await this.read(path, true)).digest !== action.expectedDigest ||
        (await this.read(await healthPath(root, action.retainedPath), true)).digest !==
          action.retainedDigest
      )
        throw new Error("文件在检查期间发生变化，本次未移走");
      await rename(path, recovery);
      return { recovery };
    }
    if (action.content === undefined)
      throw new Error("当前只支持预览过的文本修改，其他类型请单独处理");
    const recoveryRoot =
      this.options.recoveryRoot ?? join(dirname(this.workspaces.root), "health-revisions");
    await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
    const recovery = join(recoveryRoot, randomUUID());
    await copyFile(path, recovery, constants.COPYFILE_EXCL);
    if ((await this.read(recovery)).digest !== action.expectedDigest)
      throw new Error("修改前备份校验失败");
    this.service.store.recordEvent("bot-health.backup", bot.id, {
      actionId: action.id,
      original: path,
      recovery,
      digest: action.expectedDigest,
    });
    const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      if (hash(await file.readFile()) !== action.expectedDigest)
        throw new Error("文件已变化，旧方案已失效");
      const data = Buffer.from(action.content);
      let offset = 0;
      while (offset < data.length) {
        const result = await file.write(data, offset, data.length - offset, offset);
        if (!result.bytesWritten) throw new Error("写入未完成");
        offset += result.bytesWritten;
      }
      await file.truncate(data.length);
      await file.sync();
      const verify = await this.read(path);
      if (verify.digest !== hash(data)) throw new Error(`写入验证失败，原版保存在 ${recovery}`);
    } catch (error) {
      throw new RecoverableHealthError(
        error instanceof Error ? error.message : "写入未完成",
        recovery,
      );
    } finally {
      await file.close();
    }
    // 写入已读回核对，临时备份随即删除；只有失败时才留着恢复副本。
    await rm(recovery, { force: true });
    this.service.store.recordEvent("bot-health.backup-cleared", bot.id, {
      actionId: action.id,
      original: path,
    });
    return {};
  }
  private async assertNoReferences(root: string, target: string, retained: string) {
    root = await realpath(root);
    let count = 0;
    const visit = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++count > 5000) throw new Error("引用检查范围过大，尚不能安全移走旧版");
        if (entry.isSymbolicLink()) throw new Error("工作区存在未检查的链接，尚不能安全移走旧版");
        const path = join(directory, entry.name);
        const name = relative(root, path);
        if (name.split("/").some((part) => part.startsWith(".")))
          throw new Error("隐藏目录尚未核对引用，不能自动移走旧版");
        if (entry.isDirectory()) {
          await visit(await adminPath(root, name));
          continue;
        }
        if (name === target || name === retained) continue;
        // Binary/secret references cannot be proven absent: keep the file.
        const record = await this.read(await adminPath(root, name));
        if (record.content?.includes(target) || record.content?.includes(basename(target)))
          throw new Error("仍有文件引用这个旧版，请先更新引用");
      }
    };
    await visit(root);
  }
}
