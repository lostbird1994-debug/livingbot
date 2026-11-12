import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { loadThreadStopContext } from "./thread-stops.js";

const stoppedAt = new Date("2026-10-01T10:00:00Z");
const boundary = {
  type: "thread.stopped",
  runId: null,
  createdAt: stoppedAt,
  payload: {
    version: 1,
    throughMessageSeq: 8,
    runIds: ["run-1"],
    messageIds: ["original", "answer", "claimed", "pending"],
    pendingMessageIds: ["pending"],
  },
};
function database(events: unknown[]) {
  const findMany = vi.fn(async () => events);
  return { prisma: { event: { findMany } } as unknown as PrismaClient, findMany };
}
const run = { threadId: "thread-1", botId: "bot-1" };

describe("loadThreadStopContext", () => {
  it("keeps cancelled batches distinct from subsequent and completed requests", async () => {
    const { prisma, findMany } = database([boundary]);
    expect(
      await loadThreadStopContext(prisma, run, [
        { id: "original", runId: "run-1" },
        { id: "answer", runId: "run-1" },
        { id: "claimed", runId: "run-1" },
        // Its display run may already have finished. It was cancelled as pending.
        { id: "pending", runId: "routine-completed" },
        { id: "completed", runId: "old-completed" },
        { id: "new-request", runId: "run-2" },
      ]),
    ).toEqual({
      stoppedAt: stoppedAt.toISOString(),
      throughMessageSeq: 8,
      cancelledMessageIds: ["original", "answer", "claimed", "pending"],
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ...run, type: { in: ["thread.stopped", "run.cancelled"] } },
      }),
    );
  });

  it("retains earlier cancellation markers after another stop", async () => {
    const { prisma } = database([
      boundary,
      {
        ...boundary,
        createdAt: new Date("2026-10-01T11:00:00Z"),
        payload: {
          ...boundary.payload,
          throughMessageSeq: 12,
          runIds: ["run-2"],
          messageIds: ["later"],
        },
      },
    ]);
    expect(
      (
        await loadThreadStopContext(prisma, run, [
          { id: "pending", runId: null },
          { id: "later", runId: "run-2" },
        ])
      )?.cancelledMessageIds,
    ).toEqual(["pending", "later"]);
  });

  it("loads the boundary even when all cancelled messages were compacted away", async () => {
    const { prisma } = database([boundary]);
    expect(await loadThreadStopContext(prisma, run, [])).toEqual({
      stoppedAt: stoppedAt.toISOString(),
      throughMessageSeq: 8,
      cancelledMessageIds: [],
    });
  });

  it("covers cancellations recorded by older versions without a batch payload", async () => {
    const { prisma } = database([
      { type: "run.cancelled", runId: "old-run", payload: {}, createdAt: stoppedAt },
    ]);
    expect(
      await loadThreadStopContext(prisma, run, [
        { id: "old-supplement", runId: "old-run" },
        { id: "new-request", runId: "new-run" },
      ]),
    ).toEqual({
      stoppedAt: stoppedAt.toISOString(),
      throughMessageSeq: null,
      cancelledMessageIds: ["old-supplement"],
    });
  });

  it("adds no stop context to untouched conversations", async () => {
    expect(await loadThreadStopContext(database([]).prisma, run, [])).toBeUndefined();
  });
});
