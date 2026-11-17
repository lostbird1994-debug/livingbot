import { describe, expect, it, vi } from "vitest";
import { assertDailyReviewComplete, dailyReviewTools, prepareDailyReview } from "./daily-review.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";

const at = new Date("2026-11-16T10:00:00Z");
const batch = {
  ids: ["work"],
  to: { at: at.toISOString(), id: "work" },
  acknowledged: false,
  cutoff: at.toISOString(),
  hasMore: false,
};
const run = {
  id: "review",
  routineId: "routine",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  startedAt: at,
  createdAt: at,
};
function fixture() {
  const db = {
    routine: {
      findFirstOrThrow: vi
        .fn()
        .mockResolvedValue({ id: "routine", createdAt: new Date("2026-11-15T00:00:00Z") }),
    },
    run: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ dailyReviewBatch: batch }),
    },
    message: { findMany: vi.fn().mockResolvedValue([]) },
    event: { findMany: vi.fn().mockResolvedValue([]) },
    externalEffect: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const ctx = {
    run,
    runId: run.id,
    bot: { id: "bot" },
    fence: 1,
    secrets: [],
    deps: { prisma: db },
    source: { dailyReview: true, dailyReviewBatch: structuredClone(batch) },
  } as unknown as RunContext;
  return { db, ctx };
}
const call = (args = {}) => ({ args, finish: async (result: unknown) => result }) as ToolCall;

describe("built-in daily review", () => {
  it("keeps a fixed batch across retries without querying work again", async () => {
    const { db } = fixture();
    expect(await prepareDailyReview(db as never, { ...run, dailyReviewBatch: batch }, 1)).toEqual(
      batch,
    );
    expect(db.run.findMany).not.toHaveBeenCalled();
  });
  it("skips the model for empty work and only takes bounded terminal human work", async () => {
    const { db } = fixture();
    expect((await prepareDailyReview(db as never, run, 1)).ids).toEqual([]);
    expect(db.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 9,
        where: expect.objectContaining({
          ...{ spaceId: "space", userId: "user", botId: "bot" },
          status: { in: ["completed", "failed"] },
          sourceMessage: { role: "user" },
          externalMessage: null,
        }),
      }),
    );
  });
  it("uses only successfully completed acknowledged reviews as the progress cursor and retains the backlog cutoff", async () => {
    const { db } = fixture();
    db.run.findFirst.mockResolvedValue({
      dailyReviewBatch: { ...batch, acknowledged: true, hasMore: true },
    } as never);
    db.run.findMany.mockResolvedValue(
      Array.from({ length: 9 }, (_, i) => ({ id: `work-${i}`, completedAt: at })) as never,
    );
    const result = await prepareDailyReview(db as never, run, 1);
    expect(result.ids).toHaveLength(8);
    expect(result.hasMore).toBe(true);
    expect(result.to?.id).toBe("work-7");
    expect(db.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "completed",
          dailyReviewBatch: { path: ["acknowledged"], equals: true },
        }),
      }),
    );
    expect(db.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ completedAt: { gt: at } }, { completedAt: at, id: { gt: "work" } }],
          completedAt: { lte: at },
        }),
      }),
    );
  });
  it("rejects records outside the frozen batch and cannot acknowledge unread work", async () => {
    const { db, ctx } = fixture();
    expect(await dailyReviewTools.read_review_work!(ctx, call({ run_id: "other" }))).toHaveProperty(
      "error",
    );
    expect(db.run.findFirst).not.toHaveBeenCalled();
    expect(await dailyReviewTools.complete_daily_review!(ctx, call())).toHaveProperty("error");
    expect(db.run.updateMany).not.toHaveBeenCalled();
    await expect(assertDailyReviewComplete(ctx)).rejects.toThrow("did not finish");
  });
  it("requires contiguous pages before acknowledging, and fails on a lost lease", async () => {
    const { db, ctx } = fixture();
    db.run.findFirst.mockResolvedValue({ task: { prompt: "x".repeat(9000) } } as never);
    await dailyReviewTools.read_review_work!(ctx, call({ run_id: "work", offset: 4000 }));
    expect(ctx.source.dailyReviewRead?.has("work")).not.toBe(true);
    for (const offset of [0, 4000, 8000])
      await dailyReviewTools.read_review_work!(ctx, call({ run_id: "work", offset }));
    expect(ctx.source.dailyReviewRead?.has("work")).toBe(true);
    db.run.updateMany.mockResolvedValue({ count: 0 });
    expect(await dailyReviewTools.complete_daily_review!(ctx, call())).toHaveProperty("error");
    db.run.updateMany.mockResolvedValue({ count: 1 });
    expect(await dailyReviewTools.complete_daily_review!(ctx, call())).toMatchObject({
      status: "reviewed",
    });
  });
  it("offers only review and memory tools and never offers review controls in ordinary runs", () => {
    const options = {
      graphicalToolsAllowed: true,
      groupId: null,
      trigger: "routine",
      semanticMemoryEnabled: true,
      messagingChannelRun: false,
      dailyReview: true,
    };
    const names = selectBuiltinToolsForRun(options).map((tool) => tool.name);
    expect(names).toContain("read_review_work");
    expect(names).toContain("complete_daily_review");
    expect(names).toContain("write_memory");
    for (const name of [
      "shell",
      "web_fetch",
      "schedule_create",
      "message_user",
      "organize_memory",
      "forget_memory",
    ])
      expect(names).not.toContain(name);
    expect(
      selectBuiltinToolsForRun({ ...options, dailyReview: false }).map((tool) => tool.name),
    ).not.toContain("read_review_work");
  });
});

it("refuses acknowledgment after a failed memory write", async () => {
  const { ctx, db } = fixture();
  ctx.source.dailyReviewRead = new Set(["work"]);
  ctx.source.dailyReviewWriteFailures = new Set(["write_memory:topic.md"]);
  expect(await dailyReviewTools.complete_daily_review!(ctx, call())).toHaveProperty("error");
  expect(db.run.updateMany).not.toHaveBeenCalled();
});

it("continues a migrated legacy review at its last successful start boundary", async () => {
  const { db } = fixture();
  const legacyStart = new Date("2026-11-15T18:00:00Z");
  db.run.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
    startedAt: legacyStart,
    task: { prompt: "bot-self-improvement/1 — 每日工作复盘\nReviewed work" },
  } as never);
  await prepareDailyReview(db as never, run, 1);
  expect(db.run.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        OR: [{ completedAt: { gt: legacyStart } }, { completedAt: legacyStart, id: { gt: "" } }],
      }),
    }),
  );
});
