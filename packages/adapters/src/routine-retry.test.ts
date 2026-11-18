import { describe, expect, it, vi } from "vitest";
import { NATIVE_CONNECT_TIMEOUT_MESSAGE, NativeExecutionError } from "./openclaw-native-driver.js";
import { scheduleRoutineRetry } from "./run-routines.js";

const run = {
  id: "run",
  threadId: "thread",
  trigger: "routine",
  routineId: "routine",
  retryOfRunId: null,
};

function deps(toolCalls = 0) {
  const prisma = {
    routine: { findUnique: vi.fn().mockResolvedValue({ nextRunAt: null }) },
    event: { count: vi.fn().mockResolvedValue(toolCalls) },
    message: { count: vi.fn().mockResolvedValue(0) },
  };
  const jobs = { enqueue: vi.fn().mockResolvedValue(undefined) };
  return { prisma, jobs } as unknown as Parameters<typeof scheduleRoutineRetry>[0] & {
    prisma: typeof prisma;
    jobs: typeof jobs;
  };
}

describe("routine retry scheduling", () => {
  it("retries when the external runtime never accepted the connection", async () => {
    const d = deps();
    const error = new NativeExecutionError(NATIVE_CONNECT_TIMEOUT_MESSAGE, "dispatching");
    expect(await scheduleRoutineRetry(d, run, error)).toBe(true);
    expect(d.jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it("does not retry after a tool call, whose effects are not repeatable", async () => {
    const d = deps(2);
    const error = new NativeExecutionError(NATIVE_CONNECT_TIMEOUT_MESSAGE, "dispatching");
    expect(await scheduleRoutineRetry(d, run, error)).toBe(false);
    expect(d.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("keeps other failures non-retryable", async () => {
    const d = deps();
    expect(await scheduleRoutineRetry(d, run, new Error("boom"))).toBe(false);
    expect(d.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("never retries a retry", async () => {
    const d = deps();
    const error = new NativeExecutionError(NATIVE_CONNECT_TIMEOUT_MESSAGE, "dispatching");
    expect(await scheduleRoutineRetry(d, { ...run, retryOfRunId: "earlier" }, error)).toBe(false);
  });
});
