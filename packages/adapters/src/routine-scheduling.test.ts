import type { BackgroundJob, JobPublisher } from "@livingbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";
import { deferFutureRoutine, retryRoutineRun } from "./run-routines.js";

describe("routine scheduling", () => {
  it("never fires a future occurrence early", async () => {
    const scheduledAt = new Date(Date.now() + 60_000);
    const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
    const jobs: JobPublisher = {
      enqueue,
      cancel: async () => undefined,
      close: async () => undefined,
    };

    expect(await deferFutureRoutine(jobs, "routine-1", scheduledAt)).toBe(true);

    expect(enqueue).toHaveBeenCalledWith({
      name: "routine.wakeup",
      payload: { routineId: "routine-1", scheduledFor: scheduledAt.toISOString() },
      availableAt: scheduledAt,
      replaceKey: "routine:routine-1",
    });
  });
});

function pendingTimerFixture(reuse = true) {
  const scheduledAt = new Date(Date.now() - 1_000);
  const routine = {
    id: "routine-1",
    spaceId: "space-1",
    botId: "bot-1",
    userId: "user-1",
    prompt: "check current work",
    crons: ["* * * * *"],
    timezone: "UTC",
    active: true,
    nextRunAt: scheduledAt,
    watch: null,
  };
  const pending = {
    id: "pending-1",
    taskId: "task-1",
    leaseFence: 0,
    updatedAt: scheduledAt,
  };
  const tx = {
    message: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => ({ id: "human-message" })),
    },
    computerExecutionLease: { findMany: vi.fn(async () => []) },
    computer: { findMany: vi.fn(async () => []) },
    routine: {
      updateMany: vi.fn(async (args: { data: { nextRunAt?: Date | null } }) => {
        if (args.data.nextRunAt) routine.nextRunAt = args.data.nextRunAt;
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => ({
        prompt: routine.prompt,
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
      })),
    },
    run: {
      findMany: vi.fn(async () => (reuse ? [pending] : [])),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async (): Promise<{ id: string } | null> => null),
      create: vi.fn(async () => ({ id: "new-1", taskId: "task-1" })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    task: {
      create: vi.fn(async () => ({ id: "task-1" })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const prisma = {
    routine: { findUnique: vi.fn(async () => routine) },
    bot: { findUnique: vi.fn(async () => ({ id: "bot-1", thread: { id: "thread-1" } })) },
    agentSkill: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(tx)),
  };
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
  const append = vi.fn();
  const executor = createRunExecutor({
    prisma,
    jobs: { enqueue, cancel: vi.fn(), close: vi.fn() },
    events: { append },
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return { executor, tx, prisma, enqueue, append, scheduledAt, routine };
}

describe("recurring routine catch-up", () => {
  it("catches up a daily review once after a week offline and returns to local 18:00", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T02:00:00Z"));
    try {
      const { executor, tx, routine } = pendingTimerFixture(false);
      const missed = new Date("2026-11-01T10:00:00Z");
      routine.crons = ["0 18 * * *"];
      routine.timezone = "Asia/Shanghai";
      routine.nextRunAt = missed;
      await executor.wakeRoutine(routine.id, missed.toISOString());
      expect(tx.run.create).toHaveBeenCalledOnce();
      expect(routine.nextRunAt).toEqual(new Date("2026-11-08T10:00:00Z"));
      await executor.wakeRoutine(routine.id, missed.toISOString());
      expect(tx.run.create).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps one pending run and advances the next tick without a duplicate firing event", async () => {
    const { executor, tx, enqueue, append, scheduledAt } = pendingTimerFixture();
    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "run.continue",
        payload: { runId: "pending-1" },
        keepExisting: true,
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "routine.wakeup" }));
    expect(append).not.toHaveBeenCalled();
  });
  it("keeps the advanced schedule when publishing a reused run's wakeup fails", async () => {
    const { executor, tx, enqueue, scheduledAt } = pendingTimerFixture();
    enqueue.mockRejectedValueOnce(new Error("publisher unavailable"));
    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());
    expect(tx.run.deleteMany).not.toHaveBeenCalled();
    expect(tx.task.deleteMany).not.toHaveBeenCalled();
    expect(tx.routine.updateMany).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ name: "routine.wakeup" }));
  });
  it("preserves unclaimed durable work and advances scheduling when publication fails", async () => {
    const { executor, tx, enqueue, append, scheduledAt } = pendingTimerFixture(false);
    enqueue.mockRejectedValueOnce(new Error("publisher unavailable"));
    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());
    expect(tx.run.deleteMany).not.toHaveBeenCalled();
    expect(tx.task.deleteMany).not.toHaveBeenCalled();
    expect(tx.routine.updateMany).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.fired", runId: "new-1" }),
    );
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ name: "routine.wakeup" }));
  });
  it("advances past an occurrence that already fired instead of firing it again", async () => {
    const { executor, tx, enqueue, append, scheduledAt } = pendingTimerFixture(false);
    tx.run.findUnique.mockResolvedValueOnce({ id: "fired-1" });
    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());
    expect(tx.routine.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "routine.wakeup" }));
  });
});

it("runs the prompt and model committed at claim time after a concurrent edit", async () => {
  const f = pendingTimerFixture(false);
  f.routine.prompt = "Old instructions";
  f.tx.routine.findUnique.mockResolvedValue({
    prompt: "Updated instructions",
    modelProvider: "test",
    modelId: "new-model",
    thinkingLevel: null,
  } as never);
  await f.executor.wakeRoutine(f.routine.id, f.scheduledAt.toISOString());
  expect(f.tx.task.create).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ prompt: "Updated instructions" }) }),
  );
  expect(f.tx.run.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ modelProvider: "test", modelId: "new-model" }),
    }),
  );
});

it("defers only this bot's maintenance when a built-in run is active", async () => {
  const f = pendingTimerFixture(false);
  Object.assign(f.routine, { builtinKind: "daily-review" });
  const query = vi.fn(async () => []);
  Object.assign(f.tx, { $queryRaw: query });
  Object.assign(f.tx.run, { findFirst: vi.fn(async () => ({ id: "other-maintenance" })) });
  Object.assign(f.prisma.routine, { updateMany: vi.fn(async () => ({ count: 1 })) });
  await f.executor.wakeRoutine(f.routine.id, f.scheduledAt.toISOString());
  expect(query).toHaveBeenCalledOnce();
  expect(f.tx.run.create).not.toHaveBeenCalled();
  expect(f.enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "routine.wakeup" }));
});

describe("built-in maintenance on inactive days", () => {
  it.each(["daily-review", "memory-organization", "workspace-organization"])(
    "silently skips %s and keeps tomorrow scheduled",
    async (builtinKind) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-17T10:20:00Z"));
      try {
        const f = pendingTimerFixture(false);
        Object.assign(f.routine, { builtinKind });
        f.routine.crons = ["20 18 * * *"];
        f.routine.timezone = "Asia/Shanghai";
        f.tx.message.findFirst.mockResolvedValue(null);
        await f.executor.wakeRoutine(f.routine.id, f.scheduledAt.toISOString());
        expect(f.tx.message.findFirst).toHaveBeenCalledWith({
          where: {
            role: "user",
            botId: null,
            externalTranscriptFor: null,
            createdAt: {
              gte: new Date("2026-11-16T16:00:00Z"),
              lte: new Date("2026-11-17T10:20:00Z"),
            },
            thread: {
              spaceId: "space-1",
              userId: "user-1",
              OR: [{ botId: "bot-1" }, { taskBotId: "bot-1" }],
            },
          },
          select: { id: true },
        });
        expect(f.tx.task.create).not.toHaveBeenCalled();
        expect(f.tx.run.create).not.toHaveBeenCalled();
        expect(f.append).not.toHaveBeenCalled();
        expect(f.tx.routine.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: { nextRunAt: new Date("2026-11-18T10:20:00Z") } }),
        );
        expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ name: "routine.wakeup" }),
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ["America/New_York", "2026-03-08T23:00:00Z", "2026-03-08T05:00:00Z"],
    ["America/New_York", "2026-11-01T23:00:00Z", "2026-11-01T04:00:00Z"],
    ["Asia/Shanghai", "2026-11-17T16:01:00Z", "2026-11-17T16:00:00Z"],
  ])(
    "checks the actual local day across DST, midnight and delayed ticks: %s %s",
    async (timezone, now, start) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      try {
        const f = pendingTimerFixture(false);
        Object.assign(f.routine, { builtinKind: "daily-review" });
        f.routine.timezone = timezone;
        const overdue = new Date(Date.now() - 7 * 86400000);
        f.routine.nextRunAt = overdue;
        f.tx.message.findFirst.mockResolvedValue(null);
        await f.executor.wakeRoutine(f.routine.id, overdue.toISOString());
        expect(f.tx.message.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              createdAt: { gte: new Date(start), lte: new Date(now) },
            }),
          }),
        );
        expect(f.tx.run.create).not.toHaveBeenCalled();
        expect(f.routine.nextRunAt.getTime()).toBeGreaterThan(Date.now());
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not gate custom timers on human activity", async () => {
    const f = pendingTimerFixture(false);
    f.routine.prompt = "Daily workspace organization";
    f.tx.message.findFirst.mockResolvedValue(null);
    await f.executor.wakeRoutine(f.routine.id, f.scheduledAt.toISOString());
    expect(f.tx.message.findFirst).not.toHaveBeenCalled();
    expect(f.tx.run.create).toHaveBeenCalledOnce();
  });

  it("still dispatches active-day maintenance", async () => {
    const f = pendingTimerFixture(false);
    Object.assign(f.routine, { builtinKind: "workspace-organization" });
    Object.assign(f.tx, { $queryRaw: vi.fn(async () => []) });
    Object.assign(f.tx.run, { findFirst: vi.fn(async () => null) });
    await f.executor.wakeRoutine(f.routine.id, f.scheduledAt.toISOString());
    expect(f.tx.run.create).toHaveBeenCalledOnce();
  });

  it("does not enqueue a duplicate skip after another worker claimed the tick", async () => {
    const f = pendingTimerFixture(false);
    Object.assign(f.routine, { builtinKind: "daily-review" });
    f.tx.message.findFirst.mockResolvedValue(null);
    f.tx.routine.updateMany.mockResolvedValue({ count: 0 });
    await f.executor.wakeRoutine(f.routine.id, f.scheduledAt.toISOString());
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.tx.run.create).not.toHaveBeenCalled();
  });
});

it("does not revive yesterday's failed maintenance through an automatic retry on an inactive day", async () => {
  const enqueue = vi.fn();
  const create = vi.fn();
  const deps = {
    prisma: {
      run: {
        findUnique: vi.fn(async () => ({
          id: "failed",
          routineId: "daily-review:bot",
          trigger: "routine",
          status: "failed",
          retryOfRunId: null,
        })),
        create,
      },
      routine: {
        findUnique: vi.fn(async () => ({
          active: true,
          builtinKind: "daily-review",
          spaceId: "space",
          userId: "user",
          botId: "bot",
          timezone: "UTC",
        })),
      },
      message: { findFirst: vi.fn(async () => null) },
    },
    jobs: { enqueue },
  };
  await retryRoutineRun(deps as never, "failed");
  expect(create).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});
