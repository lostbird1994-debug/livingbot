import type { Actor } from "@livingbot/contracts";
import { describe, expect, it, vi } from "vitest";
import type * as ThreadTargetModule from "../thread-target.js";
import { resolveThreadTarget, stopThreadRuns } from "../thread-target.js";
import type { RouterContext } from "./context.js";
import { taskSessionsRoutes } from "./task-sessions.js";

vi.mock("../thread-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ThreadTargetModule>()),
  stopThreadRuns: vi.fn(async () => ({ cancelledRunCount: 1, cancelledPendingMessageCount: 0 })),
}));

function fixture() {
  const actor = { userId: "owner", spaceId: "space", email: "owner@example.test" } as Actor;
  const row = {
    id: "session",
    botId: "bot",
    threadId: "task-thread",
    mainThreadId: "main",
    title: "Original",
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
  };
  const bot = { id: "bot", thread: { id: "main" } };
  const prisma = {
    bot: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === bot.id && where.userId === actor.userId && where.spaceId === actor.spaceId
          ? bot
          : null,
      ),
    },
    botTaskSession: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === row.id &&
        where.botId === row.botId &&
        where.userId === actor.userId &&
        where.spaceId === actor.spaceId &&
        (where.archivedAt === undefined || !row.archivedAt)
          ? row
          : null,
      ),
      findFirstOrThrow: vi.fn(async () => row),
      update: vi.fn(async ({ data }) => Object.assign(row, data)),
    },
    run: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    externalEffect: { findMany: vi.fn(async () => []) },
    thread: { findUniqueOrThrow: vi.fn(async () => ({ unread: false })) },
  };
  const procedures = new Proxy({}, { get: () => ({ handler: (fn: unknown) => fn }) });
  const routes = taskSessionsRoutes({
    deps: { prisma },
    authed: { taskSessions: procedures },
  } as unknown as RouterContext).taskSessions;
  // Route handlers are extracted through the test composition root above.
  const call = (name: "rename" | "delete" | "archive", input: object, requester = actor) =>
    (routes[name] as unknown as (args: object) => Promise<unknown>)({
      context: { actor: requester },
      input,
    });
  return { actor, prisma, row, call };
}

describe("conversation management authorization", () => {
  it("renames only the selected conversation and keeps deleted history restorable", async () => {
    const { call, row, prisma } = fixture();
    const target = { botId: "bot", taskSessionId: "session" };
    await call("rename", { ...target, title: "Travel plans" });
    expect(row.title).toBe("Travel plans");
    expect(prisma.botTaskSession.update).toHaveBeenCalledWith({
      where: { id: "session" },
      data: { title: "Travel plans" },
    });
    await call("delete", target);
    expect(stopThreadRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ threadId: "task-thread", taskSessionId: "session" }),
      { archiveTaskSession: true },
    );
    Object.assign(row, { archivedAt: new Date() });
    await expect(resolveThreadTarget(prisma as never, fixture().actor, target)).rejects.toThrow();
    await call("archive", { ...target, archived: false });
    expect(row.archivedAt).toBeNull();
    await expect(
      resolveThreadTarget(prisma as never, fixture().actor, target),
    ).resolves.toMatchObject({ threadId: "task-thread" });
  });

  it.each(["rename", "delete", "archive"] as const)(
    "rejects forged owners, spaces, bots and sessions for %s",
    async (name) => {
      const { call, actor, prisma } = fixture();
      const target = { botId: "bot", taskSessionId: "session", title: "Changed", archived: false };
      await expect(call(name, target, { ...actor, userId: "other" })).rejects.toThrow();
      await expect(call(name, target, { ...actor, spaceId: "other" })).rejects.toThrow();
      await expect(call(name, { ...target, botId: "other" })).rejects.toThrow();
      await expect(call(name, { ...target, taskSessionId: "other" })).rejects.toThrow();
      expect(prisma.botTaskSession.update).not.toHaveBeenCalled();
    },
  );
});
