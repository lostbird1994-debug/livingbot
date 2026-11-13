import { runContinueJob } from "@livingbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { startNextWaitingRun } from "./run-lifecycle.js";

function deps(next: { id: string } | null) {
  const findFirst = vi.fn(async () => next);
  const enqueue = vi.fn(async () => undefined);
  return {
    deps: { prisma: { run: { findFirst } }, jobs: { enqueue } } as unknown as ExecutorDeps,
    findFirst,
    enqueue,
  };
}

describe("starting the next run waiting for a bot's computer", () => {
  it("starts the oldest due conversation before background checks, leaving failure backoff alone", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T12:00:00Z") });
    try {
      const f = deps({ id: "waiting" });
      await startNextWaitingRun(f.deps, "bot", "finished");
      expect(f.findFirst).toHaveBeenCalledWith({
        where: {
          botId: "bot",
          trigger: { notIn: ["routine", "reaction"] },
          status: "queued",
          id: { not: "finished" },
          OR: [{ wakeAt: null }, { wakeAt: { lte: new Date("2026-10-28T12:00:00Z") } }],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("waiting"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to a background check when no conversation is due", async () => {
    const f = deps(null);
    f.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "check" });
    await startNextWaitingRun(f.deps, "bot", "finished");
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("check"));
    expect(f.findFirst).toHaveBeenCalledTimes(2);
  });

  it("does nothing when no run is waiting", async () => {
    const f = deps(null);
    await startNextWaitingRun(f.deps, "bot", "finished");
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});
