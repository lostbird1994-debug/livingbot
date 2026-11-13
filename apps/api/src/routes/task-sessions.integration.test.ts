import { randomUUID } from "node:crypto";
import type { Actor } from "@livingbot/contracts";
import type { PrismaClient } from "@livingbot/db";
import { claimTaskSessionSlot, createDb, runAsSystem, runAsTenant } from "@livingbot/db";
import { acquireDedicatedScreenLeaseFence, ComputerBusyError } from "@livingbot/adapters";
import { publishTaskSessionReceipts } from "../../../../packages/adapters/src/task-session-receipts.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveThreadTarget, sendThreadMessage } from "../thread-target.js";
import type { RouterContext } from "./context.js";
import { taskSessionsRoutes } from "./task-sessions.js";

vi.mock("./shared.js", async importOriginal => ({ ...await importOriginal<object>(),
  modelSetup: async () => ({ needsModel: false, model: { provider: "synthetic", modelId: "test" } }),
  botsRunOwnModels: async () => true,
}));
const databaseUrl = process.env.TASK_DATABASE_URL;
// No shared harness teardown: the whole isolated cluster is stopped and moved to Trash.
describe.skipIf(!databaseUrl)("independent task database integration", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let actor: Actor;
  let botId: string;
  let mainThreadId: string;
  let computerId: string;
  let start: (input: any) => Promise<any>;
  let list: (input: any) => Promise<any>;
  const jobs = { enqueue: vi.fn(async () => undefined) };
  const events = { notify: vi.fn(async () => undefined) };
  let a: any;
  let b: any;
  let c: any;
  beforeAll(async () => {
    if (!databaseUrl?.includes("task_fixture") || !databaseUrl.includes("rakazo-parallel-20261112")) throw Error("Requires the isolated rehearsal cluster");
    db = createDb(databaseUrl, { applicationName: "independent-task-rehearsal", encryptContent: true }); prisma = db.prisma;
    const owner = await runAsSystem("read restored fixture owner", () => prisma.bot.findFirstOrThrow({ where: { archivedAt: null }, select: { spaceId: true, userId: true } }));
    actor = { ...owner, email: "fixture@example.test", isDeploymentOwner: false };
    const suffix = randomUUID(); botId = `task-fixture-${suffix}`; computerId = `computer-${suffix}`; mainThreadId = `main-${suffix}`;
    await runAsSystem("create synthetic independent task fixture", async () => {
      await prisma.computer.create({ data: { id: computerId, ...owner, scope: "dedicated", scopeKey: `scope-${suffix}`, homeKey: `home-${suffix}`, kind: "desktop", providerRef: "fixture", state: "running" } });
      await prisma.bot.create({ data: { id: botId, ...owner, name: "Parallel fixture", color: "white", computerId,
        modelProvider: "synthetic", modelId: "test", thread: { create: { id: mainThreadId, ...owner } } } });
    });
    const handler = new Proxy({}, { get: () => ({ handler: (fn: unknown) => fn }) });
    const ctx = { deps: { prisma, jobs, events, independentTasksAvailable: async () => true, env: { agentRuntime: "openclaw" } }, authed: { taskSessions: handler } } as unknown as RouterContext;
    const routes = taskSessionsRoutes(ctx).taskSessions as any;
    start = input => runAsTenant(actor, () => routes.start({ context: { actor }, input }));
    list = input => runAsTenant(actor, () => routes.list({ context: { actor }, input }));
  });
  afterAll(async () => { await db?.prisma.$disconnect(); await db?.pool.end(); });
  it("atomically starts once under concurrent retries, encrypts the title, and preserves the legacy main thread", async () => {
    const input = { botId, text: "A synthetic task", clientNonce: randomUUID() };
    const pair = await Promise.all([start(input), start(input)]); [a] = pair;
    expect(pair[0].session.id).toBe(pair[1].session.id);
    expect(await runAsTenant(actor, () => prisma.run.count({ where: { threadId: a.session.threadId } }))).toBe(1);
    const main = await runAsTenant(actor, () => resolveThreadTarget(prisma, actor, { botId }));
    expect(main.threadId).toBe(mainThreadId);
    const raw = await runAsSystem("verify ciphertext at rest", () => db.pool.query<{ title: string }>('SELECT title FROM bot_task_sessions WHERE id=$1', [a.session.id]));
    expect(raw.rows[0]?.title).not.toBe("A synthetic task");
    expect(raw.rows[0]?.title).toBeTruthy();
    expect((await list({ botId }))[0].title).toBe("A synthetic task");
  });
  it("rejects forged task, Bot and tenant targets without falling back to main", async () => {
    await expect(runAsTenant(actor, () => resolveThreadTarget(prisma, actor, { botId, taskSessionId: "missing" }))).rejects.toThrow();
    await expect(runAsTenant(actor, () => resolveThreadTarget(prisma, { ...actor, userId: "different-owner" }, { botId, taskSessionId: a.session.id }))).rejects.toThrow();
    await expect(runAsTenant({ ...actor, spaceId: "different-space" }, () => prisma.botTaskSession.findUnique({ where: { id: a.session.id } }))).resolves.toBeNull();
  });
  it("admits exactly two slots and retains uncertain work after its timer expires", async () => {
    b = await start({ botId, text: "B synthetic task", clientNonce: randomUUID() });
    c = await start({ botId, text: "C synthetic task", clientNonce: randomUUID() });
    const reservations = await runAsTenant(actor, () => Promise.all([a,b,c].map(task => claimTaskSessionSlot(prisma, task.runId, botId))));
    expect(reservations.filter(Boolean)).toHaveLength(2);
    const waiting = await runAsTenant(actor, () => prisma.run.findUniqueOrThrow({ where: { id: c.runId } }));
    expect(waiting.resourceWaitReason).toBe("task_slot");
    await runAsTenant(actor, () => prisma.run.update({ where: { id: a.runId }, data: { status: "failed", resourceWaitReason: "unconfirmed" } }));
    expect(await runAsTenant(actor, () => claimTaskSessionSlot(prisma, c.runId, botId))).toBe(false);
    await runAsTenant(actor, () => prisma.run.update({ where: { id: a.runId }, data: { status: "completed", resourceWaitReason: null } }));
    expect(await runAsTenant(actor, () => claimTaskSessionSlot(prisma, c.runId, botId))).toBe(true);
  });
  it("routes a supplement only to its active task", async () => {
    await runAsTenant(actor, () => prisma.run.update({ where: { id: b.runId }, data: { status: "running" } }));
    const target = await runAsTenant(actor, () => resolveThreadTarget(prisma, actor, { botId, taskSessionId: b.session.id }));
    await runAsTenant(actor, () => sendThreadMessage({ prisma, jobs, events } as any, actor, target, { text: "B supplement", clientNonce: randomUUID() }));
    const steering = await runAsTenant(actor, () => prisma.steeringMessage.findMany({ where: { botId } }));
    expect(steering).toHaveLength(1); expect(steering[0]?.runId).toBe(b.runId);
    const messages = await runAsTenant(actor, () => prisma.message.count({ where: { threadId: c.session.threadId } }));
    expect(messages).toBe(1);
  });
  it("serializes shared computer work and refuses to steal an expired uncertain owner", async () => {
    await runAsTenant(actor, async () => {
      for (const task of [b,c]) await prisma.run.update({ where: { id: task.runId }, data: { status: "running", leaseOwner: "fixture-worker", leaseFence: 1, leaseExpiresAt: new Date(Date.now()+60000) } });
      const lease = await acquireDedicatedScreenLeaseFence(prisma, { computerId, botId, runId: b.runId, workerId: "fixture-worker", runFence: 1 });
      expect(lease.runId).toBe(b.runId);
      await prisma.computerExecutionLease.updateMany({ where: { runId: b.runId }, data: { expiresAt: new Date(0) } });
      await prisma.run.update({ where: { id: b.runId }, data: { resourceWaitReason: "unconfirmed", status: "failed" } });
      await expect(acquireDedicatedScreenLeaseFence(prisma, { computerId, botId, runId: c.runId, workerId: "fixture-worker", runFence: 1 })).rejects.toBeInstanceOf(ComputerBusyError);
      await prisma.run.update({ where: { id: b.runId }, data: { resourceWaitReason: null, status: "cancelled" } });
      expect((await acquireDedicatedScreenLeaseFence(prisma, { computerId, botId, runId: c.runId, workerId: "fixture-worker", runFence: 1 })).runId).toBe(c.runId);
    });
  });
  it("publishes one durable main-chat receipt under repeated and overlapping reconciliation", async () => {
    await publishTaskSessionReceipts({ prisma, events } as any);
    await Promise.all([publishTaskSessionReceipts({ prisma, events } as any), publishTaskSessionReceipts({ prisma, events } as any)]);
    const receipts = await runAsTenant(actor, () => prisma.taskSessionReceipt.findMany({ where: { runId: a.runId } }));
    expect(receipts).toHaveLength(1);
    const cards = await runAsTenant(actor, () => prisma.message.findMany({ where: { threadId: mainThreadId, clientNonce: `task-result:${a.runId}` } }));
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(cards[0]?.blocks)).toContain(a.session.id);
  });
});
