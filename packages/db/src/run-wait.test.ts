import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { effectiveWaitReason, markExecutionStateUnconfirmed } from "./run-wait.js";

describe("effectiveWaitReason", () => {
  it("drops the unknown execution state of a turn that finished", () => {
    expect(effectiveWaitReason("completed", "unconfirmed")).toBeNull();
  });

  it("keeps every wait a finished turn can still hold", () => {
    // Work the turn handed to the host outlives the turn on purpose.
    expect(effectiveWaitReason("completed", "background_work")).toBe("background_work");
    expect(effectiveWaitReason("failed", "unconfirmed")).toBe("unconfirmed");
    expect(effectiveWaitReason("cancelled", "unconfirmed")).toBe("unconfirmed");
    expect(effectiveWaitReason("running", "unconfirmed")).toBe("unconfirmed");
  });

  it("reports nothing for a run that waits on nothing", () => {
    expect(effectiveWaitReason("completed", null)).toBeNull();
    expect(effectiveWaitReason("running", undefined)).toBeNull();
  });
});

describe("markExecutionStateUnconfirmed", () => {
  /** Applies the guard the way Postgres would, so the test asserts which runs may take the wait. */
  function runStore(row: {
    status: string;
    leaseFence: number;
    resourceWaitReason?: string | null;
  }) {
    return {
      run: {
        updateMany: vi.fn(async ({ where, data }: any) => {
          if (!(where.status?.in ?? []).includes(row.status)) return { count: 0 };
          if (where.leaseFence !== row.leaseFence) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
    } as unknown as PrismaClient;
  }
  const input = {
    spaceId: "space-1",
    userId: "user-1",
    runId: "run-1",
    leaseFence: 3,
    error: "底层任务状态未确认，请先核实，勿重复提交。",
  };

  it("marks a turn that can still be resumed", async () => {
    const row = { status: "running", leaseFence: 3, resourceWaitReason: null };

    await expect(markExecutionStateUnconfirmed(runStore(row), input)).resolves.toBe(true);

    expect(row.resourceWaitReason).toBe("unconfirmed");
  });

  it("never reopens a conversation a finished turn already closed", async () => {
    const row = { status: "completed", leaseFence: 3, resourceWaitReason: null };

    await expect(markExecutionStateUnconfirmed(runStore(row), input)).resolves.toBe(false);

    expect(row.resourceWaitReason).toBeNull();
  });

  it("ignores a callback from a superseded fence", async () => {
    const row = { status: "running", leaseFence: 2, resourceWaitReason: null };

    await expect(markExecutionStateUnconfirmed(runStore(row), input)).resolves.toBe(false);

    expect(row.resourceWaitReason).toBeNull();
  });
});
