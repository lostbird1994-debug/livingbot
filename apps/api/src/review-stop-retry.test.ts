import { expect, it, vi } from "vitest";
import { stopThreadRuns } from "./thread-target.js";

it("retries native cancellation for an already cancelled but unconfirmed task", async () => {
  const row = { id: "review-run", status: "cancelled", resourceWaitReason: "unconfirmed" };
  const tx: any = {
    $queryRaw: vi.fn(),
    run: { updateManyAndReturn: vi.fn(async ({where}: any) =>
      where.status.in.includes(row.status) ? [row] : []) },
    steeringMessage: { findMany: vi.fn(async () => []), deleteMany: vi.fn() },
  };
  const prisma: any = {
    $transaction: async (fn: any) => fn(tx),
    run: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
    computer: { updateMany: vi.fn() }, computerExecutionLease: { updateMany: vi.fn() },
  };
  const cancelNativeRuns = vi.fn(async () => {});
  await stopThreadRuns({ prisma, sandbox: {} as any, events: {} as any, cancelNativeRuns },
    { userId: "review-user", spaceId: "review-space" } as any,
    { kind: "bot", botId: "review-bot", threadId: "review-thread", taskSessionId: "review-task" } as any,
    { runIds: [row.id] });
  expect(cancelNativeRuns).toHaveBeenCalledWith([row.id]);
});
