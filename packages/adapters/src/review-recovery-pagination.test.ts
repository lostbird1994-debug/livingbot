import { describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";
import { createOpenClawReconciler } from "./openclaw-reconciler.js";

describe("review: recovery pagination through the executor", () => {
  function fixture() {
    const rows = Array.from({length: 30}, (_,i) => ({ id: `run-${String(i).padStart(3,"0")}`,
      status: "cancelled", userId: "review-user", spaceId: "review-space", modelId: "review", resourceWaitReason: "unconfirmed" }));
    const scanned: string[] = [];
    const findMany = vi.fn(async (query: any) => {
      if (query.where.thread) return []; // no undelivered receipts
      return rows.filter(r => !query.where.id?.gt || r.id > query.where.id.gt).slice(0,query.take);
    });
    const store = { read: vi.fn(async (key: string) => {
      const parsed = JSON.parse(key);
      if (Array.isArray(parsed) && parsed[1] === 0) scanned.push(parsed[0]);
      return undefined;
    }), write: vi.fn() };
    const deps: any = { prisma: { run: { findMany } }, nativeExecution: { store, connect: vi.fn() },
      web: {}, browser: {}, mediaGeneration: {}, events: {}, sandbox: {} };
    return { deps, scanned };
  }
  it("the reconciler itself advances to the second page when retained", async () => {
    const f = fixture(); const reconcile = createOpenClawReconciler(f.deps);
    await reconcile(); await reconcile();
    expect(new Set(f.scanned).size).toBe(30);
  });
  it("the public executor entry must also reach tasks beyond row 25", async () => {
    const f = fixture(); const executor = createRunExecutor(f.deps);
    await executor.reconcileExternalAgents(); await executor.reconcileExternalAgents();
    expect(new Set(f.scanned).size).toBe(30);
  });
});
