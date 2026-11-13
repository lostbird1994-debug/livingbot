import { expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import { compactHistory } from "./history-compaction.js";
import { OpenClawAgentRuntime } from "./openclaw-kernel.js";
vi.mock("./history-compaction.js", async importOriginal => ({
  ...await importOriginal<object>(), compactHistory: vi.fn(async () => undefined),
}));
it("builds a durable app summary for fresh native sessions instead of relying on the discarded engine session", async () => {
  const runtime = new OpenClawAgentRuntime({ store: { read: async () => undefined, write: async () => {} },
    resolveAgent: async () => { throw Error("No model calls permitted in this test"); } });
  const handlers = createBackgroundJobHandlers({
    executor: { resolveModel: vi.fn(), contextStrategy: "current" },
    prisma: { thread: { findUnique: async () => ({ userId: "review-user", spaceId: "review-space" }) } },
    sandbox: {}, home: {}, artifacts: {}, jobs: {}, events: {}, workerId: "review-worker", runtime,
    secretStore: {}, memoryProviders: { resolve: async () => null },
    deploymentModelKey: "synthetic", deploymentModelConfigured: true,
  } as any);
  await handlers["history.compact"]({ threadId: "review-thread" });
  expect(compactHistory).toHaveBeenCalled();
});
