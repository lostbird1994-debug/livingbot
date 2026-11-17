import { createHash } from "node:crypto";
import type { PrismaClient } from "@livingbot/db";
import { Prisma } from "@livingbot/db";
import * as z from "zod";
import { redactConnectorPayload } from "./connector-safety.js";
import type { RunContext } from "./run-context.js";
import type { ToolHandlers } from "./run-tool-gate.js";

const Cursor = z.object({ at: z.string().datetime(), id: z.string() });
const Batch = z.object({
  ids: z.array(z.string()),
  to: Cursor.nullable(),
  acknowledged: z.boolean(),
  cutoff: z.string().datetime(),
  hasMore: z.boolean(),
});
export type DailyReviewBatch = z.infer<typeof Batch>;

/** Fixed membership survives worker restarts. Only direct human work is eligible. */
export async function prepareDailyReview(
  prisma: PrismaClient,
  run: {
    id: string;
    routineId: string | null;
    spaceId: string;
    userId: string;
    botId: string;
    startedAt: Date | null;
    createdAt: Date;
    dailyReviewBatch?: unknown;
  },
  fence: number,
) {
  const saved = Batch.safeParse(run.dailyReviewBatch);
  if (saved.success) return saved.data;
  const routine = await prisma.routine.findFirstOrThrow({
    where: { id: run.routineId!, spaceId: run.spaceId, userId: run.userId, botId: run.botId },
  });
  // A crash after terminal commit but before cursor caching must not repeat that batch.
  const previous = await prisma.run.findFirst({
    where: {
      routineId: routine.id,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      status: "completed",
      dailyReviewBatch: { path: ["acknowledged"], equals: true },
    },
    orderBy: { createdAt: "desc" },
    select: { dailyReviewBatch: true },
  });
  const previousBatch = Batch.safeParse(previous?.dailyReviewBatch);
  // Adopt the last successful legacy review without replaying the bot's entire history.
  // Use its start boundary so work finishing during that review remains eligible.
  const legacy = previousBatch.success
    ? null
    : await prisma.run.findFirst({
        where: {
          routineId: routine.id,
          spaceId: run.spaceId,
          userId: run.userId,
          botId: run.botId,
          status: "completed",
          dailyReviewBatch: { equals: Prisma.DbNull },
        },
        orderBy: { completedAt: "desc" },
        select: { startedAt: true, task: { select: { prompt: true } } },
      });
  const baseline =
    legacy?.startedAt && legacy.task.prompt.startsWith("bot-self-improvement/1 — 每日工作复盘")
      ? legacy.startedAt
      : routine.createdAt;
  const from = previousBatch.success
    ? previousBatch.data.to
    : { at: baseline.toISOString(), id: "" };
  const cutoff =
    previousBatch.success && previousBatch.data.hasMore
      ? new Date(previousBatch.data.cutoff)
      : (run.startedAt ?? run.createdAt);
  const rows = await prisma.run.findMany({
    where: {
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      status: { in: ["completed", "failed"] },
      trigger: { in: ["user", "follow_up"] },
      sourceMessage: { role: "user" },
      externalMessage: null,
      completedAt: { lte: cutoff },
      ...(from
        ? {
            OR: [
              { completedAt: { gt: new Date(from.at) } },
              { completedAt: new Date(from.at), id: { gt: from.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ completedAt: "asc" }, { id: "asc" }],
    take: 9,
    select: { id: true, completedAt: true },
  });
  const page = rows.slice(0, 8);
  const last = page.at(-1);
  const batch: DailyReviewBatch = {
    ids: page.map((row) => row.id),
    to: last ? { at: last.completedAt!.toISOString(), id: last.id } : null,
    acknowledged: false,
    cutoff: cutoff.toISOString(),
    hasMore: rows.length > 8,
  };
  const savedBatch = await prisma.run.updateMany({
    where: {
      id: run.id,
      spaceId: run.spaceId,
      userId: run.userId,
      leaseFence: fence,
      status: "running",
    },
    data: { dailyReviewBatch: batch },
  });
  if (savedBatch.count !== 1)
    throw new Error("Review execution lease changed before saving its batch.");
  // The execution lease serializes this run's attempts.
  return batch;
}

function batchOf(ctx: RunContext) {
  if (!ctx.source.dailyReview || !ctx.source.dailyReviewBatch)
    throw new Error("Only a built-in daily review can use this tool.");
  return ctx.source.dailyReviewBatch;
}

export const dailyReviewTools: ToolHandlers = {
  async read_review_work(ctx, call) {
    const batch = batchOf(ctx);
    const parsed = z
      .object({ run_id: z.string().optional(), offset: z.number().int().nonnegative().default(0) })
      .safeParse(call.args);
    if (!parsed.success) return call.finish({ error: "Invalid review page." });
    const { run_id: id, offset } = parsed.data;
    if (!id) return call.finish({ run_ids: batch.ids });
    if (!batch.ids.includes(id))
      return call.finish({ error: "Work is outside this review batch." });
    const work = await ctx.deps.prisma.run.findFirst({
      where: { id, spaceId: ctx.run.spaceId, userId: ctx.run.userId, botId: ctx.bot.id },
      select: {
        id: true,
        status: true,
        error: true,
        completedAt: true,
        task: { select: { prompt: true } },
        sourceMessage: { select: { blocks: true } },
      },
    });
    if (!work)
      return call.finish({ error: "Work record is unavailable; leave this batch incomplete." });
    const messages = await ctx.deps.prisma.message.findMany({
      where: { runId: id, thread: { spaceId: ctx.run.spaceId } },
      orderBy: { seq: "asc" },
      select: { role: true, blocks: true },
    });
    const receipts = await ctx.deps.prisma.event.findMany({
      where: { runId: id, spaceId: ctx.run.spaceId, type: "effect.recorded" },
      orderBy: { seq: "asc" },
      select: { payload: true },
    });
    const effects = await ctx.deps.prisma.externalEffect.findMany({
      where: { runId: id, spaceId: ctx.run.spaceId },
      orderBy: { id: "asc" },
      select: { kind: true, status: true, result: true },
    });
    const text = JSON.stringify(
      redactConnectorPayload({ work, messages, receipts, effects }, ctx.secrets),
    );
    if (offset > text.length) return call.finish({ error: "Offset exceeds work record." });
    const page = text.slice(offset, offset + 4000);
    ctx.source.dailyReviewCoverage ??= new Map();
    const coverage = ctx.source.dailyReviewCoverage;
    const hash = createHash("sha256").update(text).digest("hex");
    const previous = coverage.get(id);
    if (previous && previous.hash !== hash) {
      coverage.delete(id);
      ctx.source.dailyReviewRead?.delete(id);
      if (offset > 0) return call.finish({ error: "Work changed. Restart reading at offset 0." });
    }
    const read = coverage.get(id)?.read ?? 0;
    if (offset <= read) coverage.set(id, { hash, read: Math.max(read, offset + page.length) });
    if ((coverage.get(id)?.read ?? 0) >= text.length) {
      ctx.source.dailyReviewRead ??= new Set();
      ctx.source.dailyReviewRead.add(id);
    }
    return call.finish({
      untrusted: true,
      text: page,
      offset,
      next_offset: offset + page.length < text.length ? offset + page.length : null,
    });
  },
  async complete_daily_review(ctx, call) {
    const batch = batchOf(ctx);
    if (ctx.source.dailyReviewWriteFailures?.size)
      return call.finish({
        error: "Memory writes failed; retry them before completing the review.",
      });
    if (batch.ids.some((id) => !ctx.source.dailyReviewRead?.has(id)))
      return call.finish({
        error: "Read every page of every work record before completing this batch.",
      });
    const result = await ctx.deps.prisma.run.updateMany({
      where: { id: ctx.runId, spaceId: ctx.run.spaceId, leaseFence: ctx.fence, status: "running" },
      data: { dailyReviewBatch: { ...batch, acknowledged: true } },
    });
    if (result.count !== 1)
      return call.finish({ error: "Review lease changed; progress was not acknowledged." });
    batch.acknowledged = true;
    return call.finish({ status: "reviewed", count: batch.ids.length });
  },
};

export async function assertDailyReviewComplete(ctx: RunContext) {
  if (!ctx.source.dailyReview || !ctx.source.dailyReviewBatch?.ids.length) return;
  if (ctx.source.dailyReviewWriteFailures?.size)
    throw new Error("Daily review has failed memory writes; progress was preserved.");
  const row = await ctx.deps.prisma.run.findUniqueOrThrow({
    where: { id: ctx.runId },
    select: { dailyReviewBatch: true },
  });
  if (!Batch.parse(row.dailyReviewBatch).acknowledged)
    throw new Error("Daily review did not finish; progress was preserved.");
}
