import type { Actor } from "@livingbot/contracts";
import { ThreadStoppedPayloadSchema } from "@livingbot/contracts";
import type { PrismaClient } from "@livingbot/db";
import { describe, expect, it, vi } from "vitest";
import type { ThreadTarget } from "./thread-target.js";
import { stopThreadRuns } from "./thread-target.js";

function fixture(pendingOnly = false, group = false, deleting = false) {
  let seq = 10;
  const writes: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async () => {
      writes.push("lock");
    }),
    botTaskSession: {
      update: vi.fn(async () => {
        writes.push("archive");
      }),
    },
    run: {
      updateMany: vi.fn(async () => {
        writes.push("stopping");
        return { count: 1 };
      }),
      updateManyAndReturn: vi.fn(async () => {
        writes.push("cancel");
        return pendingOnly
          ? []
          : [
              {
                id: "run-a",
                botId: "bot-a",
                sourceMessageId: "original",
                userId: "user",
                spaceId: "space",
              },
              ...(group
                ? [
                    {
                      id: "run-b",
                      botId: "bot-b",
                      sourceMessageId: "group-original",
                      userId: "user",
                      spaceId: "space",
                    },
                  ]
                : []),
            ];
      }),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ status: "cancelled" })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({ nextMessageSeq: 9 })),
      update: vi.fn(async () => ({ nextEventSeq: ++seq })),
    },
    message: {
      findMany: vi.fn(async () => [
        { id: "original", runId: "run-a" },
        { id: "answer", runId: "run-a" },
        { id: "claimed", runId: "run-a" },
        { id: "pending", runId: "completed-routine" },
        ...(group ? [{ id: "group-original", runId: "run-a" }] : []),
      ]),
    },
    steeringMessage: {
      findMany: vi.fn(async () => {
        writes.push("snapshot");
        return [
          ...(!pendingOnly
            ? [{ botId: "bot-a", messageId: "claimed", claimedAt: new Date() }]
            : []),
          { botId: "bot-a", messageId: "pending", claimedAt: null },
          ...(group ? [{ botId: "bot-b", messageId: "group-original", claimedAt: null }] : []),
        ];
      }),
      deleteMany: vi.fn(async () => {
        writes.push("clear");
        return { count: 2 };
      }),
    },
    externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    computer: { findMany: vi.fn(async () => []) },
    computerExecutionLease: { findMany: vi.fn(async () => []) },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(`event:${data.type}`);
        return data;
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  const prisma = {
    run: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
    botTaskSession: { update: vi.fn(async () => undefined) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    computer: { updateMany: vi.fn(async () => ({ count: 0 })) },
    computerExecutionLease: { updateMany: vi.fn(async () => ({ count: 0 })) },
  } as unknown as PrismaClient;
  const target = (
    group
      ? {
          kind: "group",
          groupId: "group",
          threadId: "thread",
          members: [],
          memberBotIds: ["bot-a", "bot-b"],
        }
      : {
          kind: "bot",
          botId: "bot-a",
          threadId: "thread",
          bot: { computer: null },
          ...(deleting ? { taskSessionId: "session" } : {}),
        }
  ) as ThreadTarget;
  const notify = vi.fn(async () => {});
  return {
    tx,
    writes,
    stop: () =>
      stopThreadRuns(
        {
          prisma,
          sandbox: {} as never,
          events: { notify } as never,
          ...(deleting ? { cancelNativeRuns: vi.fn(async () => {}) } : {}),
        },
        { spaceId: "space", userId: "user" } as Actor,
        target,
        deleting ? { archiveTaskSession: true } : {},
      ),
  };
}

describe("durable thread stop boundaries", () => {
  it("records the source, answers, claimed supplements and unassigned pending messages atomically", async () => {
    const { tx, writes, stop } = fixture();
    expect(await stop()).toEqual({ cancelledRunCount: 1, cancelledPendingMessageCount: 1 });
    const saved = tx.event.create.mock.calls
      .map(([arg]) => arg.data)
      .find((e) => e.type === "thread.stopped")!;
    const payload = ThreadStoppedPayloadSchema.parse(saved.payload);
    expect(new Set(payload.messageIds)).toEqual(
      new Set(["original", "answer", "claimed", "pending"]),
    );
    expect(payload.pendingMessageIds).toEqual(["pending"]);
    expect(payload.throughMessageSeq).toBe(8);
    expect(payload.runIds).toEqual(["run-a"]);
    expect(writes[0]).toBe("lock");
    expect(writes.indexOf("snapshot")).toBeLessThan(writes.indexOf("clear"));
    expect(tx.steeringMessage.deleteMany).toHaveBeenCalledWith({
      where: { botId: { in: ["bot-a"] }, message: { threadId: "thread" } },
    });
  });

  it("records a pending-only stop even when no run remains active", async () => {
    const { tx, stop } = fixture(true);
    expect(await stop()).toEqual({ cancelledRunCount: 0, cancelledPendingMessageCount: 1 });
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "thread.stopped",
        runId: undefined,
        payload: {
          version: 1,
          throughMessageSeq: 8,
          runIds: [],
          messageIds: ["pending"],
          pendingMessageIds: ["pending"],
        },
      }),
    });
  });

  it("records group ownership per bot even when the shared message displays another bot's run", async () => {
    const { tx, stop } = fixture(false, true);
    await stop();
    const saved = tx.event.create.mock.calls
      .map(([arg]) => arg.data)
      .filter((e) => e.type === "thread.stopped");
    const botB = saved.find((e) => e.botId === "bot-b")!;
    expect(ThreadStoppedPayloadSchema.parse(botB.payload)).toMatchObject({
      runIds: ["run-b"],
      messageIds: ["group-original"],
      pendingMessageIds: ["group-original"],
    });
  });
});

it("soft-deletes under the same thread lock as cancellation, preserving the conversation", async () => {
  const { tx, writes, stop } = fixture(false, false, true);
  // No previously cancelled runs need a retry in this fixture.
  tx.run.updateManyAndReturn
    .mockResolvedValueOnce([
      {
        id: "run-a",
        botId: "bot-a",
        sourceMessageId: "original",
        userId: "user",
        spaceId: "space",
      },
    ])
    .mockResolvedValueOnce([]);
  await stop();
  expect(writes[0]).toBe("lock");
  expect(writes[1]).toBe("archive");
  expect(tx.run.updateMany).toHaveBeenCalledWith({
    where: { id: { in: ["run-a"] }, taskSlotHeld: true },
    data: { resourceWaitReason: "stopping" },
  });
  expect(tx.botTaskSession.update).toHaveBeenCalledWith({
    where: { id: "session" },
    data: { archivedAt: expect.any(Date) },
  });
  expect(tx.run.updateManyAndReturn).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      where: {
        threadId: "thread",
        status: { in: ["cancelled", "failed"] },
        resourceWaitReason: { in: ["stopping", "unconfirmed"] },
      },
    }),
  );
});
