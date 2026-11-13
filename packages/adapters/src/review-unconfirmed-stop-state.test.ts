import { expect, it, vi } from "vitest";
import { createOpenClawReconciler } from "./openclaw-reconciler.js";
it("retains an unconfirmed stop as discoverable when the native runtime cannot confirm termination", async () => {
  const row = { id: "review-cancelled", botId: "review-bot", userId: "review-user", spaceId: "review-space",
    status: "cancelled", resourceWaitReason: "stopping", error: null, modelId: "synthetic", taskSlotHeld: true };
  const key = JSON.stringify([row.id, 0]);
  const record = { version: 1, runId: "review-native", sessionKey: "review-session", inputHash: "review",
    startedAt: 1, status: "unconfirmed", text: "" };
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const request = vi.fn(async (method: string) => method === "chat.abort"
    ? { aborted: false } : { status: "timeout", unconfirmed: true });
  await createOpenClawReconciler({
    prisma: { run: { findMany: async () => [row], updateMany } },
    nativeExecution: { store: { read: async (k: string) => k === key ? record : undefined, write: async () => {} },
      connect: async () => ({ request, stop() {} }) },
  } as any)({ runIds: [row.id] });
  const lastWrite = updateMany.mock.calls.at(-1) as any;
  expect(lastWrite[0].data.resourceWaitReason).toBe("unconfirmed");
});
