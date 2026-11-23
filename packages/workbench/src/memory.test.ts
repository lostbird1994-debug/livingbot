import assert from "node:assert/strict";
import test from "node:test";
import { Memories } from "./memory.ts";
import type { ForgetReview } from "./memory.ts";
import { WorkbenchStore } from "./store.ts";
import type { MemoryProvider } from "../../kernel-runtime/src/memory.ts";
import type { MemoryForgetOutcome, MemoryForgetPreview } from "../../kernel-runtime/src/memory-forget.ts";

test("memory forgetting preview derives only the selected Bot's conversation keys and stores a review receipt", async () => {
  const store = new WorkbenchStore(":memory:");
  const atlas = store.createBot({ name: "Atlas", agentId: "atlas" });
  const moss = store.createBot({ name: "Moss", agentId: "moss" });
  const privateChat = store.privateConversation(atlas.id);
  const group = store.createConversation("group", [atlas.id, moss.id], "Synthetic group");
  const foreign = store.privateConversation(moss.id);
  const calls: { agentId: string; sessions: string[] }[] = [];
  const report: MemoryForgetPreview = {
    agentId: atlas.agentId, dryRun: true, sessionIds: [], sessionResolutions: [], entryKeys: [],
    mixedLineageEntryKeys: [], untargetableEntryKeys: [], curatedWrites: [], artifacts: {}, refusals: [],
  };
  const provider: MemoryProvider = {
    async health() { throw new Error("Not called"); },
    async search() { throw new Error("Not called"); },
    async get() { throw new Error("Not called"); },
    async previewForget(agentId, sessions) { calls.push({ agentId, sessions }); return report; },
  };
  const memories = new Memories(store, provider);
  try {
    await assert.rejects(memories.previewForget(atlas.id, [foreign.id]), /ownership/);
    await assert.rejects(memories.previewForget(atlas.id, []), /Select/);
    await assert.rejects(memories.previewForget("unknown", [privateChat.id]), /Unknown/);
    assert.equal(calls.length, 0);
    const preview = await memories.previewForget(atlas.id, [privateChat.id, group.id, privateChat.id]);
    assert.deepEqual(calls, [{
      agentId: atlas.agentId, sessions: [store.engineSessionKey(privateChat.id, atlas.id), store.engineSessionKey(group.id, atlas.id)],
    }]);
    assert.deepEqual(preview.conversationIds, [privateChat.id, group.id]);
    assert.equal(preview.digest.length, 64);
    assert.deepEqual(store.get("settings", preview.id), preview);
    report.agentId = moss.agentId;
    await assert.rejects(memories.previewForget(atlas.id, [privateChat.id]), /ownership/);
  } finally { store.close(); }
});

test("maintenance admission includes background programs and old tasks beyond the UI inventory limit", () => {
  const store = new WorkbenchStore(":memory:");
  try {
    store.transaction(() => {
      for (let index = 0; index < 1001; index++) store.put("tasks", { id: `finished-${index}`, status: "completed" });
      store.put("tasks", { id: "old-active-task", status: "running" });
    });
    assert.equal(store.hasUnfinishedWork(), true);
    store.put("tasks", { id: "old-active-task", status: "completed" });
    assert.equal(store.hasUnfinishedWork(), false);
    store.put("tasks", { id: "background", status: "completed", processes: [{ status: "unknown" }] });
    assert.equal(store.hasUnfinishedWork(), true);
    store.put("tasks", { id: "background", status: "completed", processes: [{ status: "killed" }] });
    assert.equal(store.hasUnfinishedWork(), false);
  } finally { store.close(); }
});

test("recovery preparation binds the reviewed Bot, conversation keys and native preview digest", async () => {
  const store = new WorkbenchStore(":memory:");
  const atlas = store.createBot({ name: "Atlas", agentId: "atlas" });
  const moss = store.createBot({ name: "Moss", agentId: "moss" });
  const conversation = store.privateConversation(atlas.id);
  const calls: unknown[] = [];
  const provider: MemoryProvider = {
    async health() { throw new Error("Not called"); }, async search() { throw new Error("Not called"); }, async get() { throw new Error("Not called"); },
    async previewForget(agentId) {
      return { agentId, dryRun: true, sessionIds: [], sessionResolutions: [], entryKeys: [], mixedLineageEntryKeys: [],
        untargetableEntryKeys: [], curatedWrites: [], artifacts: {}, refusals: [] };
    },
    async prepareForget(agentId, sessions, digest) {
      calls.push({ agentId, sessions, digest });
      return { id: "memory-recovery-synthetic", createdAt: 1, digest: "a".repeat(64), previewDigest: digest, files: 2, bytes: 8,
        scope: "kernel-and-selected-workspace" };
    },
  };
  try {
    const memories = new Memories(store, provider);
    const preview = await memories.previewForget(atlas.id, [conversation.id]);
    await assert.rejects(memories.prepareForget(moss.id, preview.id, preview.digest), /another Bot/);
    await assert.rejects(memories.prepareForget(atlas.id, preview.id, "b".repeat(64)), /changed/);
    assert.equal(calls.length, 0);
    const result = await memories.prepareForget(atlas.id, preview.id, preview.digest);
    assert.deepEqual(calls, [{ agentId: atlas.agentId, sessions: [store.engineSessionKey(conversation.id, atlas.id)], digest: preview.digest }]);
    assert.equal(result.recovery?.files, 2);
    assert.deepEqual(store.get<ForgetReview>("settings", preview.id), result);
    assert.equal(memories.recoveries(atlas.id).length, 1);
    assert.equal(memories.recoveries(moss.id).length, 0);
    assert.deepEqual(memories.recoveries(atlas.id)[0].conversationIds, [conversation.id]);
    assert.equal(JSON.stringify(memories.recoveries(atlas.id)).includes("sessionIds"), false);
    store.put("settings", { ...preview, report: { ...preview.report, entryKeys: ["changed"] } });
    await assert.rejects(memories.prepareForget(atlas.id, preview.id, preview.digest), /changed/);
    assert.equal(calls.length, 1);
  } finally { store.close(); }
});

test("native forgetting requires the exact reviewed selection and replays its durable product outcome", async () => {
  const store = new WorkbenchStore(":memory:");
  const bot = store.createBot({ name: "Atlas", agentId: "atlas" });
  const conversation = store.privateConversation(bot.id);
  let applies = 0;
  const provider: MemoryProvider = {
    async health() { throw new Error("Not called"); }, async search() { throw new Error("Not called"); }, async get() { throw new Error("Not called"); },
    async previewForget(agentId) {
      return { agentId, dryRun: true, sessionIds: ["native"], sessionResolutions: [{ sessionId: "native", source: "live" }],
        entryKeys: [], mixedLineageEntryKeys: [], untargetableEntryKeys: [], curatedWrites: [], artifacts: {}, refusals: [] };
    },
    async applyForget(agentId, sessions, digest) {
      applies++;
      assert.deepEqual(sessions, [store.engineSessionKey(conversation.id, bot.id)]);
      return { id: "memory-forget-synthetic", agentId, status: "completed", createdAt: 1, files: [],
        recovery: { id: "memory-recovery-synthetic", createdAt: 1, digest: "a".repeat(64), previewDigest: digest,
          files: 2, bytes: 8, scope: "kernel-and-selected-workspace" } };
    },
  };
  try {
    const memories = new Memories(store, provider);
    const review = await memories.previewForget(bot.id, [conversation.id]);
    await assert.rejects(memories.applyForget(bot.id, review.id, "a".repeat(64)), /changed/);
    assert.equal(applies, 0);
    const outcome = await memories.applyForget(bot.id, review.id, review.digest);
    assert.equal(outcome.outcome?.status, "completed");
    assert.deepEqual(await memories.applyForget(bot.id, review.id, review.digest), outcome);
    assert.equal(applies, 1);
  } finally { store.close(); }
});

test("startup recovers a lost product receipt from its exact native request without repeating apply", async () => {
  const store = new WorkbenchStore(":memory:");
  const bot = store.createBot({ name: "Atlas", agentId: "atlas" });
  const conversation = store.privateConversation(bot.id);
  let applies = 0;
  let native: { requestId: string; sessions: string[]; outcome: MemoryForgetOutcome } | undefined;
  const provider: MemoryProvider = {
    async health() { throw new Error("Not called"); }, async search() { throw new Error("Not called"); }, async get() { throw new Error("Not called"); },
    async previewForget(agentId) {
      return { agentId, dryRun: true, sessionIds: ["native"], sessionResolutions: [{ sessionId: "native", source: "live" }],
        entryKeys: [], mixedLineageEntryKeys: [], untargetableEntryKeys: [], curatedWrites: [], artifacts: {}, refusals: [] };
    },
    async applyForget(agentId, sessions, digest, requestId) {
      applies++;
      assert.ok(requestId);
      native = { requestId, sessions, outcome: {
        id: "memory-forget-synthetic", agentId, status: "completed", createdAt: 1, files: [],
        recovery: { id: "memory-recovery-synthetic", createdAt: 1, digest: "a".repeat(64), previewDigest: digest,
          files: 2, bytes: 8, scope: "kernel-and-selected-workspace" },
      } };
      // Simulates product death after native outcome durability, before the product commit.
      throw new Error("Product interrupted after native commit");
    },
    async forgetOutcome(agentId, sessions, digest, requestId) {
      if (native?.requestId !== requestId) return undefined;
      assert.deepEqual(sessions, native.sessions);
      assert.equal(agentId, native.outcome.agentId);
      assert.equal(digest, native.outcome.recovery.previewDigest);
      return native.outcome;
    },
  };
  try {
    const memories = new Memories(store, provider);
    const review = await memories.previewForget(bot.id, [conversation.id]);
    const unrelated = await memories.previewForget(bot.id, [conversation.id]);
    await assert.rejects(memories.applyForget(bot.id, review.id, review.digest), /interrupted/);
    assert.equal(store.get<ForgetReview>("settings", review.id)?.outcome, undefined);
    const restarted = new Memories(store, provider);
    await restarted.reconcileForgetOutcomes();
    assert.equal(restarted.recoveries(bot.id).length, 1);
    assert.equal(store.get<ForgetReview>("settings", unrelated.id)?.outcome, undefined);
    assert.equal((await restarted.applyForget(bot.id, review.id, review.digest)).outcome?.status, "completed");
    assert.equal(applies, 1);
  } finally { store.close(); }
});

test("a recovery copy is only copied for its own Bot, once per target, without activation", async () => {
  const store = new WorkbenchStore(":memory:");
  const atlas = store.createBot({ name: "Atlas", agentId: "atlas" });
  const moss = store.createBot({ name: "Moss", agentId: "moss" });
  const conversation = store.privateConversation(atlas.id);
  const restored: string[] = [];
  const provider: MemoryProvider = {
    async health() { throw new Error("Not called"); }, async search() { throw new Error("Not called"); }, async get() { throw new Error("Not called"); },
    async previewForget(agentId) {
      return { agentId, dryRun: true, sessionIds: [], sessionResolutions: [], entryKeys: [], mixedLineageEntryKeys: [],
        untargetableEntryKeys: [], curatedWrites: [], artifacts: {}, refusals: [] };
    },
    async prepareForget(agentId, sessions, digest) {
      return { id: "memory-recovery-synthetic", createdAt: 1, digest: "a".repeat(64), previewDigest: digest, files: 1, bytes: 4,
        scope: "kernel-and-selected-workspace" };
    },
    async restoreForget(recoveryId) {
      restored.push(recoveryId);
      return { id: "independent-copy", createdAt: Date.now(), source: recoveryId,
        target: "/synthetic/memory-restores/memory-recovery-synthetic", files: 1, bytes: 4 };
    },
  };
  try {
    const memories = new Memories(store, provider);
    const preview = await memories.previewForget(atlas.id, [conversation.id]);
    await assert.rejects(memories.restoreForget(atlas.id, preview.id), /another Bot/);
    await memories.prepareForget(atlas.id, preview.id, preview.digest);
    await assert.rejects(memories.restoreForget(moss.id, preview.id), /another Bot/);
    const result = await memories.restoreForget(atlas.id, preview.id);
    assert.equal(result.restores?.length, 1);
    assert.equal(result.restores?.[0].target, "/synthetic/memory-restores/memory-recovery-synthetic");
    const again = await memories.restoreForget(atlas.id, preview.id);
    assert.equal(again.restores?.length, 1, "The same target is never copied twice");
    assert.equal(restored.length, 1);
    assert.equal(memories.recoveries(atlas.id)[0].restores?.length, 1);
    assert.equal(JSON.stringify(result).includes("activated"), false);
  } finally { store.close(); }
});
