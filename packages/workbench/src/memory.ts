import type { MemoryProvider, MemoryQuery, MemoryReference } from "../../kernel-runtime/src/memory.ts";
import { randomUUID } from "node:crypto";
import { memoryPreviewDigest } from "../../kernel-runtime/src/memory-forget.ts";
import type { MemoryForgetOutcome, MemoryForgetPreview, MemoryForgetRecovery, MemoryRestore } from "../../kernel-runtime/src/memory-forget.ts";
import type { Bot, Conversation } from "./contracts.ts";
import type { WorkbenchStore } from "./store.ts";

export type ForgetReview = {
  id: string; botId: string; conversationIds: string[]; sessions: string[];
  createdAt: number; digest: string; report: MemoryForgetPreview;
  recovery?: MemoryForgetRecovery;
  outcome?: MemoryForgetOutcome;
  restores?: MemoryRestore[];
};
/** User-facing management is Bot-scoped; native agent tools never use operator reads. */
export class Memories {
  private readonly store: WorkbenchStore;
  private readonly provider: MemoryProvider;
  constructor(store: WorkbenchStore, provider: MemoryProvider) { this.store = store; this.provider = provider; }
  private agent(botId: string): string {
    const bot = this.store.get<Bot>("bots", botId);
    if (!bot) throw new Error("Unknown Bot");
    return bot.agentId;
  }
  health(botId: string) { return this.provider.health(this.agent(botId)); }
  search(botId: string, query: MemoryQuery) { return this.provider.search(this.agent(botId), query); }
  get(botId: string, reference: MemoryReference, from?: number) { return this.provider.get(this.agent(botId), reference, from); }
  recoveries(botId: string) {
    const agentId = this.agent(botId);
    return this.store.memoryRecoveryReviews<ForgetReview>(botId)
      .filter((review) => review.report.agentId === agentId && review.recovery)
      .map((review) => ({
        id: review.id, conversationIds: review.conversationIds, recovery: review.recovery!,
        ...(review.outcome ? { outcome: review.outcome } : {}),
        ...(review.restores?.length ? { restores: review.restores } : {}),
      }));
  }
  async previewForget(botId: string, conversationIds: string[]) {
    const agentId = this.agent(botId);
    if (!Array.isArray(conversationIds) || !conversationIds.length || conversationIds.length > 20 ||
      conversationIds.some((id) => typeof id !== "string" || !id)) throw new Error("Select 1–20 conversations");
    const selected = [...new Set(conversationIds)];
    const sessions = selected.map((id) => {
      const conversation = this.store.get<Conversation>("conversations", id);
      if (!conversation || !conversation.botIds.includes(botId)) throw new Error("Memory conversation ownership mismatch");
      return this.store.engineSessionKey(id, botId);
    });
    if (!this.provider.previewForget) throw new Error("Memory forgetting preview is unavailable");
    const report = await this.provider.previewForget(agentId, sessions);
    if (report.agentId !== agentId || report.dryRun !== true) throw new Error("Memory preview ownership mismatch");
    const preview: ForgetReview = {
      id: `memory-forget-${randomUUID()}`, botId, conversationIds: selected, sessions,
      createdAt: Date.now(), digest: memoryPreviewDigest(report), report,
    };
    this.store.put("settings", preview, "memory.forget-preview");
    return preview;
  }

  async prepareForget(botId: string, previewId: string, digest: string): Promise<ForgetReview> {
    const agentId = this.agent(botId);
    const preview = typeof previewId === "string" ? this.store.get<ForgetReview>("settings", previewId) : undefined;
    if (!preview || preview.botId !== botId || preview.report.agentId !== agentId ||
      preview.digest !== digest || memoryPreviewDigest(preview.report) !== digest) throw new Error("Memory preview changed or belongs to another Bot");
    if (preview.outcome) return preview;
    const sessions = preview.conversationIds.map((id) => this.store.engineSessionKey(id, botId));
    if (JSON.stringify(sessions) !== JSON.stringify(preview.sessions)) throw new Error("Memory conversation selection changed");
    if (!this.provider.prepareForget) throw new Error("Memory recovery preparation is unavailable");
    const recovery = await this.provider.prepareForget(agentId, sessions, digest);
    if (recovery.previewDigest !== digest || recovery.scope !== "kernel-and-selected-workspace" ||
      !/^memory-recovery-[a-zA-Z0-9]+$/.test(recovery.id) || !/^[a-f0-9]{64}$/.test(recovery.digest) ||
      !Number.isSafeInteger(recovery.createdAt) || recovery.createdAt <= 0 ||
      !Number.isSafeInteger(recovery.files) || recovery.files < 0 || !Number.isSafeInteger(recovery.bytes) || recovery.bytes < 0) {
      throw new Error("Invalid memory recovery receipt");
    }
    return this.store.put("settings", { ...preview, recovery }, "memory.recovery-prepared");
  }

  /**
   * Copies a reviewed recovery copy into a new independent folder so the user
   * can inspect it. Nothing is activated and no source is written.
   */
  async restoreForget(botId: string, previewId: string): Promise<ForgetReview> {
    const agentId = this.agent(botId);
    const review = typeof previewId === "string" ? this.store.get<ForgetReview>("settings", previewId) : undefined;
    if (!review || review.botId !== botId || review.report.agentId !== agentId || !review.recovery) {
      throw new Error("Memory recovery copy belongs to another Bot");
    }
    // One independent copy per reviewed recovery; a repeated click is a no-op
    // rather than another copy of the same bytes.
    if (review.restores?.length) return review;
    if (!this.provider.restoreForget) throw new Error("Memory recovery restore is unavailable");
    const restored = await this.provider.restoreForget(review.recovery.id);
    if (!/^memory-recovery-[a-zA-Z0-9]+$/.test(restored.source) || restored.source !== review.recovery.id ||
      !Number.isSafeInteger(restored.files) || restored.files < 0 || restored.files > review.recovery.files ||
      !Number.isSafeInteger(restored.bytes) || restored.bytes < 0 || restored.bytes > review.recovery.bytes ||
      typeof restored.target !== "string" || !restored.target) {
      throw new Error("Invalid memory restore receipt");
    }
    const previous = review.restores ?? [];
    if (previous.some((entry) => entry.target === restored.target)) return review;
    return this.store.put("settings", { ...review, restores: [...previous, restored] }, "memory.recovery-restored");
  }

  async applyForget(botId: string, previewId: string, digest: string): Promise<ForgetReview> {
    const agentId = this.agent(botId);
    const preview = typeof previewId === "string" ? this.store.get<ForgetReview>("settings", previewId) : undefined;
    if (!preview || preview.botId !== botId || preview.report.agentId !== agentId ||
      preview.digest !== digest || memoryPreviewDigest(preview.report) !== digest) throw new Error("Memory preview changed or belongs to another Bot");
    if (preview.outcome) return preview;
    const sessions = preview.conversationIds.map((id) => this.store.engineSessionKey(id, botId));
    if (JSON.stringify(sessions) !== JSON.stringify(preview.sessions)) throw new Error("Memory conversation selection changed");
    if (!this.provider.applyForget) throw new Error("Recoverable memory forgetting is unavailable");
    const outcome = await this.provider.forgetOutcome?.(agentId, sessions, digest, preview.id)
      ?? await this.provider.applyForget(agentId, sessions, digest, preview.id);
    return this.saveOutcome(preview, outcome);
  }

  /** Repair only product receipts; this never retries native maintenance. */
  async reconcileForgetOutcomes(): Promise<void> {
    if (!this.provider.forgetOutcome) return;
    for (const preview of this.store.pendingMemoryReviews<ForgetReview>()) {
      const agentId = this.agent(preview.botId);
      if (preview.report.agentId !== agentId || memoryPreviewDigest(preview.report) !== preview.digest) {
        throw new Error("Memory preview ownership changed");
      }
      const sessions = preview.conversationIds.map((id) => this.store.engineSessionKey(id, preview.botId));
      if (JSON.stringify(sessions) !== JSON.stringify(preview.sessions)) throw new Error("Memory conversation selection changed");
      const outcome = await this.provider.forgetOutcome(agentId, sessions, preview.digest, preview.id);
      if (outcome) this.saveOutcome(preview, outcome);
    }
  }

  private saveOutcome(preview: ForgetReview, outcome: MemoryForgetOutcome): ForgetReview {
    const agentId = this.agent(preview.botId);
    if (outcome.agentId !== agentId || !/^memory-forget-[a-zA-Z0-9]+$/.test(outcome.id) ||
      !["completed", "recovery-required"].includes(outcome.status) || outcome.recovery.previewDigest !== preview.digest) {
      throw new Error("Invalid native forgetting outcome");
    }
    return this.store.put("settings", { ...preview, recovery: outcome.recovery, outcome }, "memory.forgetting-result");
  }
}
