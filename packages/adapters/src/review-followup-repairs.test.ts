import { expect, it, vi } from "vitest";
import { compactHistory } from "./history-compaction.js";
import { createOpenClawReconciler } from "./openclaw-reconciler.js";

it("loads summary input for an independent task whose owner is taskBotId", async () => {
  const findMany = vi.fn(async () => []);
  await compactHistory({ prisma: {
    thread: { findUniqueOrThrow: async () => ({ id: "review-task-thread", botId: null,
      taskBotId: "review-bot", userId: "review-user", spaceId: "review-space",
      nextMessageSeq: 250, historyCompactedUpToSeq: null, historyCompactionGeneration: 0,
      historyCompactionSummary: null }) }, message: { findMany },
  } } as any, "review-task-thread");
  expect(findMany).toHaveBeenCalled();
});

it("actually aborts a failed/unconfirmed run after a stop retry marks it stopping", async () => {
  const row = { id: "review-failed", botId: "review-bot", userId: "review-user", spaceId: "review-space",
    status: "failed", resourceWaitReason: "stopping", error: null, modelId: "synthetic" };
  const key = JSON.stringify([row.id, 0]);
  const record = { version: 1, runId: "review-native-run", sessionKey: "review-session",
    inputHash: "review", startedAt: 1, status: "unconfirmed", text: "" };
  const request = vi.fn(async (method: string) => method === "chat.abort"
    ? { aborted: true } : { status: "timeout", unconfirmed: true });
  const reconciler = createOpenClawReconciler({
    prisma: { run: { findMany: async () => [row], updateMany: vi.fn(async () => ({ count: 1 })) } },
    nativeExecution: {
      store: { read: async (k: string) => k === key ? record : undefined, write: async () => {} },
      connect: async () => ({ request, stop() {} }),
    },
  } as any);
  await reconciler({ runIds: [row.id] });
  expect(request.mock.calls.map(call => call[0])).toContain("chat.abort");
});
