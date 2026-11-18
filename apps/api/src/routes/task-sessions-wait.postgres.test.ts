import { randomUUID } from "node:crypto";
import type { Actor } from "@livingbot/contracts";
import type { PrismaClient } from "@livingbot/db";
import {
  asSystem,
  claimTaskSessionSlot,
  createDb,
  registerTaskWork,
  runAsTenant,
  writeTaskWork,
} from "@livingbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveThreadTarget, sendThreadMessage } from "../thread-target.js";
import type { RouterContext } from "./context.js";
import { taskSessionsRoutes } from "./task-sessions.js";

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  modelSetup: async () => ({
    needsModel: false,
    model: { provider: "synthetic", modelId: "test" },
  }),
  botsRunOwnModels: async () => true,
}));

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;

/** A conversation whose turn already ended, with whatever wait its row was left holding. */
describePostgres("a finished turn's wait (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let routes: any;
  const jobs = { enqueue: vi.fn(async () => undefined) };
  const events = { notify: vi.fn(async () => undefined) };
  const spaces: string[] = [];
  const botIds: string[] = [];

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    const handler = new Proxy({}, { get: () => ({ handler: (fn: unknown) => fn }) });
    routes = taskSessionsRoutes({
      deps: { prisma, jobs, events },
      authed: { taskSessions: handler },
    } as unknown as RouterContext).taskSessions;
  });

  afterAll(async () => {
    if (prisma) {
      for (const where of [
        () => system.externalEffect.deleteMany({ where: { spaceId: { in: spaces } } }),
        () => system.steeringMessage.deleteMany({ where: { botId: { in: botIds } } }),
        () => system.event.deleteMany({ where: { spaceId: { in: spaces } } }),
        () => system.message.deleteMany({ where: { botId: { in: botIds } } }),
        () => system.run.deleteMany({ where: { spaceId: { in: spaces } } }),
        () => system.task.deleteMany({ where: { spaceId: { in: spaces } } }),
        () => system.botTaskSession.deleteMany({ where: { spaceId: { in: spaces } } }),
        () => system.thread.deleteMany({ where: { spaceId: { in: spaces } } }),
        () => system.bot.deleteMany({ where: { spaceId: { in: spaces } } }),
        () => system.computer.deleteMany({ where: { spaceId: { in: spaces } } }),
        () => system.space.deleteMany({ where: { id: { in: spaces } } }),
        () => system.organization.deleteMany({ where: { id: { in: spaces } } }),
        () => system.user.deleteMany({ where: { id: { in: spaces } } }),
      ])
        await where().catch(() => undefined);
      await prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function finishedTask(options: { status?: string; waitReason?: string | null } = {}) {
    const spaceId = randomUUID();
    const userId = spaceId;
    spaces.push(spaceId);
    const botId = `bot-${spaceId}`;
    botIds.push(botId);
    const mainThreadId = `main-${spaceId}`;
    const threadId = `task-${spaceId}`;
    const sessionId = `session-${spaceId}`;
    const taskId = `work-${spaceId}`;
    const runId = `run-${spaceId}`;
    const status = options.status ?? "completed";
    await system.user.create({
      data: {
        id: userId,
        name: "Wait fixture",
        email: `${userId}@example.test`,
        emailVerified: true,
      },
    });
    await system.organization.create({
      data: { id: spaceId, name: "Wait fixture", slug: spaceId, createdAt: new Date() },
    });
    await system.space.create({ data: { id: spaceId, organizationId: spaceId, name: "Fixture" } });
    const computer = await system.computer.create({
      data: { spaceId, userId, scopeKey: spaceId, homeKey: spaceId, kind: "fake" },
    });
    await system.bot.create({
      data: {
        id: botId,
        spaceId,
        userId,
        name: "Wait fixture",
        color: "test",
        computerId: computer.id,
        modelProvider: "synthetic",
        modelId: "test",
      },
    });
    await system.thread.create({ data: { id: mainThreadId, spaceId, userId, botId } });
    // A task conversation gets its own thread, which carries the Bot as its task owner.
    await system.thread.create({ data: { id: threadId, spaceId, userId, taskBotId: botId } });
    await system.botTaskSession.create({
      data: {
        id: sessionId,
        spaceId,
        userId,
        botId,
        mainThreadId,
        threadId,
        title: "Contract review",
        clientNonce: randomUUID(),
      },
    });
    await system.task.create({
      data: { id: taskId, spaceId, botId, threadId, userId, prompt: "fixture", status },
    });
    await system.run.create({
      data: {
        id: runId,
        spaceId,
        botId,
        threadId,
        taskId,
        userId,
        status,
        trigger: "user",
        resourceWaitReason: options.waitReason ?? null,
        ...(status === "completed" ? { completedAt: new Date() } : {}),
      },
    });
    const actor: Actor = {
      spaceId,
      userId,
      email: `${userId}@example.test`,
      isDeploymentOwner: false,
    };
    return {
      actor,
      spaceId,
      userId,
      botId,
      threadId,
      sessionId,
      taskId,
      runId,
      computerId: computer.id,
    };
  }

  const call = <T>(fixture: { actor: Actor }, run: () => Promise<T>) =>
    runAsTenant(fixture.actor, run);
  const list = (fixture: any) =>
    call(fixture, () =>
      routes.list({ context: { actor: fixture.actor }, input: { botId: fixture.botId } }),
    );
  const active = (fixture: any) =>
    call(fixture, () =>
      routes.activeRuns({ context: { actor: fixture.actor }, input: { botId: fixture.botId } }),
    );

  it("settles the unknown execution state its finished turn no longer holds", async () => {
    const fixture = await finishedTask({ waitReason: "unconfirmed" });

    expect(await list(fixture)).toMatchObject([{ status: "completed", resourceWaitReason: null }]);
    expect(await active(fixture)).toEqual([]);

    const target = await call(fixture, () =>
      resolveThreadTarget(prisma, fixture.actor, {
        botId: fixture.botId,
        taskSessionId: fixture.sessionId,
      }),
    );
    await expect(
      call(fixture, () =>
        sendThreadMessage({ prisma, jobs, events } as any, fixture.actor, target, {
          text: "After verifying the result",
          clientNonce: randomUUID(),
        }),
      ),
    ).resolves.toBeTruthy();
  });

  it("keeps work a finished turn handed off listed, and still asks to verify unknown work", async () => {
    const fixture = await finishedTask({ status: "running" });
    const scope = {
      spaceId: fixture.spaceId,
      userId: fixture.userId,
      botId: fixture.botId,
      threadId: fixture.threadId,
    };
    const { work } = await call(fixture, () =>
      registerTaskWork(prisma, scope, fixture.runId, randomUUID(), {
        name: "Fixture handoff work",
        computerId: fixture.computerId,
        start: "fixture start",
        poll: "fixture poll",
        cancel: "fixture cancel",
      }),
    );
    // The turn ends; the host keeps running what the turn handed it, so no run-level marker stays.
    await call(fixture, () =>
      prisma.run.update({
        where: { id: fixture.runId },
        data: { status: "completed", completedAt: new Date(), resourceWaitReason: null },
      }),
    );

    expect(await active(fixture)).toMatchObject([
      { id: fixture.runId, taskSessionId: fixture.sessionId, status: "running" },
    ]);
    expect(await list(fixture)).toMatchObject([{ status: "running", resourceWaitReason: null }]);

    const uncertain = await call(fixture, () =>
      writeTaskWork(prisma, scope, work, "unconfirmed", {}),
    );
    expect(uncertain).not.toBeNull();
    expect(await list(fixture)).toMatchObject([{ resourceWaitReason: "unconfirmed" }]);
    expect(await active(fixture)).toMatchObject([{ status: "unconfirmed" }]);

    // A stop the user asks for has somewhere to land: the work the finished turn left behind.
    expect(
      await call(fixture, () =>
        writeTaskWork(prisma, scope, uncertain!, "stopping", { stopRequested: true }),
      ),
    ).not.toBeNull();
    expect(await active(fixture)).toMatchObject([{ status: "stopping" }]);
  });

  it("does not let a finished run's leftover unknown state hold a task slot", async () => {
    const fixture = await finishedTask({ status: "queued" });
    // Two conversations this Bot already finished still carry the wait and the slot they held.
    await call(fixture, async () => {
      for (const runId of [`stale-a-${fixture.spaceId}`, `stale-b-${fixture.spaceId}`]) {
        await prisma.run.create({
          data: {
            id: runId,
            spaceId: fixture.spaceId,
            botId: fixture.botId,
            threadId: fixture.threadId,
            taskId: fixture.taskId,
            userId: fixture.userId,
            status: "completed",
            trigger: "user",
            resourceWaitReason: "unconfirmed",
            taskSlotHeld: true,
            completedAt: new Date(),
          },
        });
      }
    });

    expect(
      await call(fixture, () => claimTaskSessionSlot(prisma, fixture.runId, fixture.botId)),
    ).toBe(true);
  });
});
