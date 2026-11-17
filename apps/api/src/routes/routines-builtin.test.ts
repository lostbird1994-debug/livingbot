import type { Actor } from "@livingbot/contracts";
import { appContract } from "@livingbot/contracts";
import { createRouterClient, implement } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import type { RouterContext } from "./context.js";
import { routinesRoutes } from "./routines.js";

function setup(kind: string | null = "daily-review") {
  const existing = {
    id: "routine",
    botId: "bot",
    builtinKind: kind,
    memoryMaintenance: false,
    spaceId: "space",
    userId: "user",
    name: "Daily review",
    prompt: "Review",
    crons: kind === "context-audit" ? [] : ["0 18 * * *"],
    usageTrigger:
      kind === "context-audit" ? { kind: "human-messages", count: 50, action: "ask" } : null,
    timezone: "UTC",
    active: true,
    notify: false,
    requireOutput: false,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    watch: null,
    watchState: null,
    lastRunAt: null,
    nextRunAt: new Date("2026-11-17T10:00:00Z"),
    createdAt: new Date("2026-11-16T10:00:00Z"),
  };
  const remove = vi.fn();
  const update = vi.fn().mockImplementation(async ({ data }) => ({
    ...existing,
    ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
  }));
  const getBot = vi.fn().mockResolvedValue({ id: "bot", thread: null });
  const taskCreate = vi.fn().mockResolvedValue({ id: "task" });
  const runCreate = vi.fn().mockResolvedValue({ id: "run" });
  const findRun = vi.fn().mockResolvedValue(null);
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    routine: {
      findFirst: vi.fn().mockResolvedValue(existing),
      findUnique: vi.fn().mockResolvedValue(existing),
      delete: remove,
      update,
    },
    task: { create: taskCreate },
    run: { create: runCreate, findFirst: findRun },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((work) => work(prisma));
  const authed = implement(appContract).$context<{ actor: Actor }>();
  const router = routinesRoutes({
    authed,
    repos: { getBot },
    deps: {
      prisma,
      jobs: { cancel: vi.fn(), enqueue },
    },
    agentSkills: { listWithContent: vi.fn().mockResolvedValue([]) },
  } as unknown as RouterContext);
  const actor = { spaceId: "space", userId: "user" } as Actor;
  return {
    client: createRouterClient(router, { context: { actor } }),
    existing,
    remove,
    update,
    getBot,
    prisma,
    taskCreate,
    runCreate,
    findRun,
    enqueue,
  };
}
describe("built-in routine API protection", () => {
  it.each(["daily-review", "memory-organization", "context-audit", "workspace-organization"])(
    "rejects deletion of %s before any write",
    async (kind) => {
      const f = setup(kind);
      await expect(f.client.routines.remove({ routineId: "routine" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(f.remove).not.toHaveBeenCalled();
    },
  );
  it.each([
    { prompt: "Change behavior" },
    { name: "Rename" },
    { crons: ["* * * * *"] },
    { modelProvider: "example", modelId: "example" },
    { notify: true },
    { watch: null },
  ])("rejects changes beyond the toggle: %j", async (patch) => {
    const f = setup();
    await expect(
      f.client.routines.update({ routineId: "routine", ...patch }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.update).not.toHaveBeenCalled();
    expect(f.getBot).not.toHaveBeenCalled();
  });
});

it.each(["daily-review", "memory-organization", "context-audit", "workspace-organization"])(
  "manually tests a paused %s through the ordinary run path without enabling it",
  async (kind) => {
    const f = setup(kind);
    f.existing.active = false;
    f.existing.memoryMaintenance = kind === "memory-organization";
    f.getBot.mockResolvedValue({ id: "bot", thread: { id: "thread" } });
    const result = await f.client.routines.testRun({
      routineId: "routine",
      clientNonce: "manual-test",
    });
    expect(result).toEqual({ runId: "run" });
    expect(f.prisma.routine.findFirst).toHaveBeenCalledWith({
      where: { id: "routine", spaceId: "space", userId: "user" },
    });
    expect(f.getBot).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: "space", userId: "user" }),
      "bot",
    );
    expect(f.taskCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ prompt: "Review", status: "queued", threadId: "thread" }),
    });
    expect(f.runCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        routineId: "routine",
        trigger: "routine",
        status: "queued",
        clientNonce: "routine-run:user:manual-test",
      }),
      select: { id: true, status: true },
    });
    expect(f.enqueue).toHaveBeenCalledOnce();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.existing.active).toBe(false);
  },
);

it("reuses a system test run for the same nonce", async () => {
  const f = setup();
  f.getBot.mockResolvedValue({ id: "bot", thread: { id: "thread" } });
  f.findRun.mockResolvedValue({ id: "existing-run" });
  await expect(
    f.client.routines.testRun({ routineId: "routine", clientNonce: "repeat" }),
  ).resolves.toEqual({ runId: "existing-run" });
  expect(f.taskCreate).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
});

it("refuses system test runs when ownership or Bot access is missing", async () => {
  const f = setup();
  f.prisma.routine.findFirst.mockResolvedValueOnce(null);
  await expect(f.client.routines.testRun({ routineId: "routine" })).rejects.toThrow();
  f.getBot.mockRejectedValueOnce(new Error("Bot access denied"));
  await expect(f.client.routines.testRun({ routineId: "routine" })).rejects.toThrow(
    "Bot access denied",
  );
  expect(f.taskCreate).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
});

it("allows the owner to disable a built-in without changing its definition", async () => {
  const f = setup();
  const result = await f.client.routines.update({ routineId: "routine", active: false });
  expect(result).toMatchObject({
    builtinKind: "daily-review",
    active: false,
    prompt: "Review",
    nextRunAt: null,
  });
  expect(f.update).toHaveBeenCalledOnce();
  expect(f.remove).not.toHaveBeenCalled();
});

it("enables the usage-based audit without a calendar schedule and resets its counting baseline", async () => {
  const f = setup("context-audit");
  f.existing.active = false;

  const result = await f.client.routines.update({ routineId: "routine", active: true });
  expect(result).toMatchObject({
    builtinKind: "context-audit",
    active: true,
    crons: [],
    nextRunAt: null,
    usageTrigger: { kind: "human-messages", count: 50, action: "ask" },
  });
  expect(f.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ usageSince: expect.any(Date) }) }),
  );
});
