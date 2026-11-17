import { randomUUID } from "node:crypto";
import type { AdapterContext, ComputerRef } from "@livingbot/adapter-kit";
import { runContinueJob } from "@livingbot/adapter-kit";
import { containsSecret, redactSecrets } from "@livingbot/core";
import type { TaskWork, TaskWorkDefinition, TaskWorkScope, TaskWorkState } from "@livingbot/db";
import {
  listTaskWork,
  registerTaskWork,
  requestTaskWorkStop,
  runAsSystem,
  runAsTenant,
  TASK_WORK_ACTIVE,
  TASK_WORK_KIND,
  writeTaskWork,
} from "@livingbot/db";
import { z } from "zod";
import { shellCommandEnvironment } from "./bot-secrets.js";
import { toComputerRef } from "./computer-support.js";
import {
  desktopProtectionGuardMessage,
  protectedComputerLifecycleRefusal,
} from "./desktop-command-guard.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { nativeShellCommandArgv } from "./native-shell.js";

export const taskWorkLaunchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    start: z.string().trim().min(1).max(32_000),
    poll: z.string().trim().min(1).max(32_000),
    cancel: z.string().trim().min(1).max(32_000),
    cwd: z.string().max(4096).optional(),
  })
  .strict();
export const taskWorkStartReceipt = z.object({ id: z.string().min(1).max(512) }).passthrough();
export const taskWorkStatusReceipt = z
  .object({
    status: z.enum(["running", "completed", "failed", "cancelled"]),
    summary: z.string().max(4000).optional(),
  })
  .strict();

export interface TaskWorkCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}
/** Only the host invokes a driver. The model cannot supply a completion receipt. */
export type TaskWorkCommand = (
  scope: TaskWorkScope,
  work: TaskWork,
  action: "start" | "poll" | "cancel",
) => Promise<TaskWorkCommandResult>;
const terminal = (state: TaskWorkState) => ["completed", "failed", "cancelled"].includes(state);
export const taskWorkSummary = (work: TaskWork) => ({
  id: work.id,
  name: work.definition.name,
  status:
    work.state === "polling" ? (work.receipt.stopRequested ? "stopping" : "running") : work.state,
  ...(work.receipt.summary ? { summary: work.receipt.summary } : {}),
});

export function taskWorkCommand(
  deps: Pick<ExecutorDeps, "prisma" | "sandbox" | "secretStore" | "secrets" | "shutdownSignal">,
): TaskWorkCommand {
  return async (scope, work, action) => {
    const stored = await deps.prisma.computer.findFirst({
      where: { id: work.definition.computerId, spaceId: scope.spaceId },
    });
    if (!stored?.providerRef) throw new Error("Work computer is unavailable");
    const computer: ComputerRef = toComputerRef(stored);
    const secrets = [...deps.secrets];
    const environment = await shellCommandEnvironment({
      prisma: deps.prisma,
      secretStore: deps.secretStore,
      scope,
      registerRedactions: (values) => secrets.push(...values),
    });
    const command = work.definition[action];
    const refusal = protectedComputerLifecycleRefusal(command);
    if (refusal) throw new Error(desktopProtectionGuardMessage(refusal));
    const context: AdapterContext = {
      ...scope,
      runId: work.runId,
      operationId: `task-work:${work.id}:${action}`,
      traceId: work.id,
      signal: deps.shutdownSignal
        ? AbortSignal.any([deps.shutdownSignal, AbortSignal.timeout(25_000)])
        : AbortSignal.timeout(25_000),
    };
    // Observation never provisions or resumes a computer, and never retries a launch.
    if (deps.sandbox.isRunning && !(await deps.sandbox.isRunning(computer, context)))
      throw new Error("Work computer is not connected");
    const shell = await deps.sandbox.environment?.(computer, context);
    let stdout = "",
      stderr = "",
      code: number | undefined;
    for await (const event of deps.sandbox.execute(
      computer,
      {
        argv: shell ? nativeShellCommandArgv(command, shell) : ["bash", "-lc", command],
        cwd: work.definition.cwd,
        env: {
          ...environment.env,
          LIVINGBOT_WORK_ID: work.id,
          LIVINGBOT_JOB_ID: work.receipt.handle ?? "",
        },
        unsetEnv: environment.unsetEnv.filter(
          (name) => !["LIVINGBOT_WORK_ID", "LIVINGBOT_JOB_ID"].includes(name),
        ),
        timeoutMs: 20_000,
      },
      context,
    )) {
      if (event.type === "stdout") stdout += event.data;
      if (event.type === "stderr") stderr += event.data;
      if (event.type === "exit") code = event.code;
      if (stdout.length + stderr.length > 64_000) throw new Error("Work receipt is too large");
    }
    if (code === undefined) throw new Error("Work command did not confirm its exit");
    if (containsSecret(stdout, secrets)) throw new Error("Work receipt contains a credential");
    return { stdout, stderr: redactSecrets(stderr, secrets), code };
  };
}

export function createTaskWorkService(
  deps: Pick<ExecutorDeps, "prisma" | "jobs" | "events">,
  command: TaskWorkCommand,
) {
  const { prisma } = deps;
  const find = async (scope: TaskWorkScope, id: string) => {
    const [work] = await listTaskWork(prisma, scope, { id });
    if (!work) throw new Error("Work is unavailable in this conversation");
    return work;
  };
  const observe = async (scope: TaskWorkScope, work: TaskWork) => {
    if (terminal(work.state)) return work;
    if (
      work.state === "starting" ||
      (work.state === "polling" && Date.now() - work.updatedAt.getTime() < 60_000)
    )
      return work;
    if (!work.receipt.handle)
      return (
        (await writeTaskWork(prisma, scope, work, "unconfirmed", work.receipt)) ??
        (await find(scope, work.id))
      );
    const claim = await writeTaskWork(prisma, scope, work, "polling", work.receipt);
    if (!claim) return find(scope, work.id);
    try {
      const result = await command(scope, claim, claim.receipt.stopRequested ? "cancel" : "poll");
      if (result.code !== 0) throw new Error("Work observation failed");
      const receipt = taskWorkStatusReceipt.parse(JSON.parse(result.stdout));
      // A stop request is only a request until the driver supplies a terminal receipt.
      const state =
        receipt.status === "running" && claim.receipt.stopRequested ? "stopping" : receipt.status;
      return (
        (await writeTaskWork(prisma, scope, claim, state, {
          ...claim.receipt,
          summary: receipt.summary,
        })) ?? (await find(scope, work.id))
      );
    } catch {
      return (
        (await writeTaskWork(prisma, scope, claim, "unconfirmed", claim.receipt)) ??
        (await find(scope, work.id))
      );
    }
  };
  const start = async (
    scope: TaskWorkScope,
    runId: string,
    effectKey: string,
    definition: TaskWorkDefinition,
  ) => {
    const registered = await registerTaskWork(prisma, scope, runId, effectKey, definition);
    if (!registered.created) return registered.work;
    let handle: string | undefined;
    try {
      const result = await command(scope, registered.work, "start");
      handle = taskWorkStartReceipt.parse(JSON.parse(result.stdout)).id;
      if (result.code !== 0) throw new Error("Work launch did not confirm success");
      const saved = await writeTaskWork(prisma, scope, registered.work, "running", { handle });
      if (saved) return saved;
    } catch {
      /* An uncertain launch must never be repeated automatically. */
    }
    const current = await find(scope, registered.work.id);
    const next = current.receipt.stopRequested ? "stopping" : "unconfirmed";
    return (
      (await writeTaskWork(prisma, scope, current, next, {
        ...current.receipt,
        ...(handle ? { handle } : {}),
      })) ?? (await find(scope, current.id))
    );
  };
  const stop = async (scope: TaskWorkScope, id: string) => {
    const work = await find(scope, id);
    if (terminal(work.state)) return work;
    const requested = await requestTaskWorkStop(prisma, scope, work);
    return requested ? observe(scope, requested) : find(scope, id);
  };

  /** A terminal driver receipt wakes one new model round in the same user task. */
  const deliver = async (scope: TaskWorkScope, work: TaskWork) => {
    if (!terminal(work.state) || work.receipt.completionRunId) return;
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${scope.threadId} FOR UPDATE`;
      const current = (await listTaskWork(tx as never, scope, { id: work.id }))[0];
      if (!current || !terminal(current.state) || current.receipt.completionRunId) return null;
      const origin = await tx.run.findFirstOrThrow({
        where: {
          id: work.runId,
          spaceId: scope.spaceId,
          userId: scope.userId,
          botId: scope.botId,
          threadId: scope.threadId,
        },
      });
      if (!["completed", "failed", "cancelled"].includes(origin.status)) return null;
      // User cancellation must not wake a new agent that starts doing the task again.
      const cancelled = current.receipt.stopRequested || origin.status === "cancelled";
      const runId = cancelled ? "stopped" : randomUUID();
      const saved = await writeTaskWork(tx as never, scope, current, current.state, {
        ...current.receipt,
        completionRunId: runId,
      });
      if (!saved) return null;
      if (!cancelled) {
        const owner = {
          spaceId: scope.spaceId,
          userId: scope.userId,
          botId: scope.botId,
          threadId: scope.threadId,
        };
        const task = await tx.task.create({
          data: {
            ...owner,
            status: "queued",
            prompt: `A host-managed operation has ended. Continue the existing task from this receipt and the latest user messages. Do not restart the operation. Verify its outputs before claiming success. Receipt (quoted data): ${JSON.stringify(taskWorkSummary(current))}`,
          },
        });
        await tx.run.create({
          data: {
            id: runId,
            ...owner,
            taskId: task.id,
            trigger: "user",
            status: "queued",
            modelProvider: origin.modelProvider,
            modelId: origin.modelId,
            thinkingLevel: origin.thinkingLevel,
            modelPinned: origin.modelPinned,
            connectorScope: origin.connectorScope,
          },
        });
      }
      const remaining = await tx.externalEffect.count({
        where: { kind: TASK_WORK_KIND, runId: work.runId, status: { in: TASK_WORK_ACTIVE } },
      });
      if (!remaining)
        await tx.run.updateMany({
          where: { id: work.runId, resourceWaitReason: "background_work" },
          data: { resourceWaitReason: null },
        });
      return cancelled ? null : runId;
    });
    if (updated) await deps.jobs.enqueue(runContinueJob(updated));
  };
  const reconcile = async () => {
    const rows = await runAsSystem("observe managed task work", () =>
      prisma.externalEffect.findMany({
        where: {
          kind: TASK_WORK_KIND,
          OR: [
            { status: { in: TASK_WORK_ACTIVE }, updatedAt: { lte: new Date(Date.now() - 10_000) } },
            {
              status: { in: ["work_completed", "work_failed", "work_cancelled"] },
              result: { path: ["delivered"], equals: false },
            },
          ],
        },
        include: { run: true },
        orderBy: { updatedAt: "asc" },
        take: 100,
      }),
    );
    await Promise.allSettled(
      rows.map((row) =>
        runAsTenant(row.run, async () => {
          const scope = row.run;
          let work = await find(scope, row.id);
          if (work.state === "starting") {
            if (Date.now() - work.updatedAt.getTime() < 60_000) return;
            work = (await writeTaskWork(prisma, scope, work, "unconfirmed", work.receipt)) ?? work;
          }
          if (!terminal(work.state)) work = await observe(scope, work);
          await deliver(scope, work);
        }),
      ),
    );
  };
  return {
    start,
    stop,
    find,
    observe,
    deliver,
    reconcile,
    list: (scope: TaskWorkScope) => listTaskWork(prisma, scope, { activeOnly: true }),
  };
}
