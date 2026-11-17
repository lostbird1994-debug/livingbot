import type { Actor } from "@livingbot/contracts";
import { RoutineUsageTriggerSchema } from "@livingbot/contracts";
import { ACTIVE_RUN_STATUSES, CONTEXT_AUDIT_PROMPT } from "@livingbot/core";
import { appendEventInTransaction, createThreadMessageInTransaction } from "@livingbot/db";
import * as z from "zod";
import { redactConnectorPayload } from "./connector-safety.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { loadBotContextPreview } from "./loaded-context.js";
import type { ToolHandlers } from "./run-tool-gate.js";

/** No model call: count distinct human source messages and save one durable confirmation card. */
export async function maybeOfferContextAudit(
  deps: Pick<ExecutorDeps, "prisma" | "events">,
  scope: { spaceId: string; userId: string; botId: string },
  now = new Date(),
) {
  const routine = await deps.prisma.routine.findFirst({
    where: { ...scope, builtinKind: "context-audit", active: true },
  });
  if (!routine) return false;
  const trigger = RoutineUsageTriggerSchema.safeParse(routine.usageTrigger);
  if (!trigger.success) return false;
  const since = routine.usageSince ?? now;
  if (!routine.usageSince) {
    await deps.prisma.routine.updateMany({
      where: { id: routine.id, active: true, usageSince: null },
      data: { usageSince: now },
    });
    return false;
  }
  const messages = await deps.prisma.run.findMany({
    where: {
      ...scope,
      trigger: { in: ["user", "follow_up"] },
      sourceMessage: { role: "user", createdAt: { gt: since, lte: now } },
      externalMessage: null,
    },
    distinct: ["sourceMessageId"],
    select: { sourceMessageId: true },
    take: trigger.data.count,
  });
  if (messages.length < trigger.data.count) return false;
  const saved = await deps.prisma.$transaction(async (tx) => {
    const bot = await tx.bot.findFirst({
      where: { id: scope.botId, spaceId: scope.spaceId, userId: scope.userId, archivedAt: null },
      select: { thread: { select: { id: true } } },
    });
    if (!bot?.thread) return null;
    // Same lock order as answering and clearing a thread: thread, routine, run.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${bot.thread.id} FOR UPDATE`;
    const pending = await tx.run.findFirst({
      where: { ...scope, routineId: routine.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
    });
    if (pending) return null;
    const claimed = await tx.routine.updateMany({
      where: { id: routine.id, ...scope, active: true, usageSince: since },
      data: { usageSince: now, lastRunAt: now },
    });
    if (claimed.count !== 1) return null;
    const task = await tx.task.create({
      data: {
        ...scope,
        threadId: bot.thread.id,
        prompt: CONTEXT_AUDIT_PROMPT,
        status: "waiting_input",
      },
    });
    const run = await tx.run.create({
      data: {
        ...scope,
        threadId: bot.thread.id,
        taskId: task.id,
        routineId: routine.id,
        trigger: "routine",
        status: "waiting_input",
      },
    });
    const blocks = [
      {
        kind: "ask" as const,
        contextAudit: true as const,
        ownerOnly: true,
        status: "pending" as const,
        text: `已累计 ${trigger.data.count} 条人类消息，是否进行上下文审计？`,
        actions: [
          { id: "start", label: "开始审计" },
          { id: "skip", label: "暂不" },
        ],
      },
    ];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: bot.thread.id,
      botId: scope.botId,
      runId: run.id,
      role: "bot",
      blocks,
      markUnread: true,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: scope.spaceId,
      botId: scope.botId,
      threadId: bot.thread.id,
      runId: run.id,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { threadId: bot.thread.id, seq: event.seq };
  });
  if (!saved) return false;
  await deps.events.notify(saved.threadId, saved.seq);
  return true;
}

export const contextAuditTools: ToolHandlers = {
  async read_loaded_context(ctx, call) {
    if (!ctx.source.contextAudit)
      return call.finish({ error: "Only a confirmed context audit may read its loading preview." });
    const parsed = z
      .object({ offset: z.number().int().nonnegative().default(0) })
      .safeParse(call.args);
    if (!parsed.success) return call.finish({ error: "Invalid context page." });
    if (ctx.source.contextAuditSnapshot === undefined) {
      const actor = { spaceId: ctx.run.spaceId, userId: ctx.run.userId } as Actor;
      const preview = await loadBotContextPreview(ctx.deps, actor, ctx.bot.id, ctx.context.signal);
      ctx.source.contextAuditSnapshot = JSON.stringify(
        redactConnectorPayload(preview, ctx.secrets),
      );
    }
    const text = ctx.source.contextAuditSnapshot;
    const offset = parsed.data.offset;
    if (offset > text.length) return call.finish({ error: "Offset exceeds context preview." });
    const content = text.slice(offset, offset + 4000);
    return call.finish({
      untrusted: true,
      content,
      offset,
      next_offset: offset + content.length < text.length ? offset + content.length : null,
    });
  },
};
