import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { memoryOrganizationDiary } from "./memory-organization-diary.js";
import {
  listMemoryOrganizers,
  selectSharedMemoryOrganizer,
} from "./memory-organization-settings.js";

const actor = { spaceId: "space", userId: "user" } as Actor;
function fixture() {
  const row = {
    id: "routine",
    botId: "bot",
    name: "Organizer",
    prompt: "instructions",
    active: true,
    memoryMaintenance: true,
    sharedMemoryOrganizer: false,
    crons: ["0 18 * * *"],
    timezone: "UTC",
    notify: false,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    watch: null,
    watchState: null,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date("2026-01-01"),
    bot: {
      name: "Example bot",
      spawnKey: "onboarding:first",
      modelId: "example-model",
      disabledBuiltinTools: [],
    },
  };
  const routine = {
    findMany: vi.fn().mockResolvedValue([row]),
    findFirst: vi.fn().mockResolvedValue(row),
    updateMany: vi.fn(),
    update: vi.fn(),
  };
  const prisma = {
    routine,
    run: { findMany: vi.fn().mockResolvedValue([]) },
    event: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (operation) =>
      operation({
        routine,
        $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
      }),
    ),
  };
  return { prisma, row, routine };
}
describe("memory organizer settings", () => {
  it("uses the same owner for the visible setting and paused explicit assignment", async () => {
    const { prisma, row, routine } = fixture();
    routine.findMany.mockResolvedValue([
      { ...row, id: "first" },
      { ...row, id: "paused", active: false, sharedMemoryOrganizer: true },
    ]);
    routine.findFirst.mockResolvedValue({ id: "paused" } as never);
    const result = await listMemoryOrganizers(prisma as never, actor);
    expect(result.sharedRoutineId).toBe("paused");
    expect(result.routines[1]).toMatchObject({
      shared: true,
      routine: { active: false, prompt: "instructions" },
    });
    expect(routine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ...actor, memoryMaintenance: true, bot: { archivedAt: null } },
      }),
    );
  });
  it("defaults to the renamed Chief even when an ordinary bot sorts first", async () => {
    const { prisma, routine, row } = fixture();
    routine.findMany.mockResolvedValue([
      { ...row, id: "ordinary", bot: { ...row.bot, spawnKey: null } },
      row,
    ]);
    routine.findFirst.mockResolvedValue(null);
    expect((await listMemoryOrganizers(prisma as never, actor)).sharedRoutineId).toBe("routine");
  });
  it.each(["missing", "paused", "disabled"])(
    "shows no implicit owner when Chief is %s",
    async (kind) => {
      const { prisma, routine, row } = fixture();
      routine.findFirst.mockResolvedValue(null);
      routine.findMany.mockResolvedValue([
        {
          ...row,
          active: kind !== "paused",
          bot: {
            ...row.bot,
            spawnKey: kind === "missing" ? null : "onboarding:first",
            disabledBuiltinTools: kind === "disabled" ? ["organize_memory"] : [],
          },
        },
      ]);
      expect((await listMemoryOrganizers(prisma as never, actor)).sharedRoutineId).toBeNull();
    },
  );
  it("switches only this member's assignment in one serializable transaction", async () => {
    const { prisma, routine } = fixture();
    await selectSharedMemoryOrganizer(prisma as never, actor, "routine");
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(routine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "routine", ...actor, memoryMaintenance: true, bot: { archivedAt: null } },
      }),
    );
    expect(routine.updateMany).toHaveBeenCalledWith({
      where: { ...actor, sharedMemoryOrganizer: true },
      data: { sharedMemoryOrganizer: false },
    });
    expect(routine.update).toHaveBeenCalledWith({
      where: { id: "routine" },
      data: { sharedMemoryOrganizer: true },
    });
    // Assignment leaves the selected model, ordinary bot instructions and memory untouched.
  });
  it.each(["missing", "disabled"])(
    "rejects an unavailable %s organizer before writes",
    async (kind) => {
      const { prisma, row, routine } = fixture();
      routine.findFirst.mockResolvedValue(
        kind === "missing"
          ? null
          : { ...row, bot: { ...row.bot, disabledBuiltinTools: ["organize_memory"] } },
      );
      await expect(
        selectSharedMemoryOrganizer(prisma as never, actor, "other"),
      ).rejects.toMatchObject({ code: kind === "missing" ? "NOT_FOUND" : "BAD_REQUEST" });
      expect(routine.updateMany).not.toHaveBeenCalled();
      expect(routine.update).not.toHaveBeenCalled();
    },
  );
});
describe("memory organization diary", () => {
  it("does not reveal another member's run or document receipts", async () => {
    const { prisma, routine } = fixture();
    routine.findFirst.mockResolvedValue(null);
    await expect(memoryOrganizationDiary(prisma as never, actor, "other")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(prisma.run.findMany).not.toHaveBeenCalled();
    expect(prisma.event.findMany).not.toHaveBeenCalled();
  });
  it("shows original versions, verified archives, failures and silent checks from durable receipts", async () => {
    const { prisma } = fixture();
    const run = {
      id: "run",
      status: "completed",
      error: null,
      createdAt: new Date("2026-01-01"),
      completedAt: new Date("2026-01-01"),
      modelId: "chosen-model",
    };
    prisma.run.findMany.mockResolvedValue([run, { ...run, id: "skip" }] as never);
    prisma.event.findMany.mockResolvedValue([
      {
        runId: "run",
        payload: {
          tool: "organize_memory",
          status: "applied",
          path: "user:USER.md",
          sourceRevision: 2,
          revision: 3,
          savedCharacters: 700,
          archive: "user:memory/archive/source.v2.md",
        },
      },
      {
        runId: "run",
        payload: {
          tool: "organize_memory",
          status: "failed",
          path: "bot:MEMORY.md",
          error: "Revision conflict",
        },
      },
      { runId: "run", payload: { tool: "another_tool", secret: "excluded" } },
      { runId: "skip", payload: { tool: "memory_organization", status: "unchanged" } },
    ] as never);
    const result = await memoryOrganizationDiary(prisma as never, actor, "routine");
    expect(result.runs[0]?.changes).toHaveLength(2);
    expect(result.runs[0]?.changes[0]).toMatchObject({
      status: "applied",
      sourceRevision: 2,
      revision: 3,
      savedCharacters: 700,
    });
    expect(result.runs[1]?.unchanged).toBe(true);
    expect(JSON.stringify(result)).not.toContain("excluded");
    expect(prisma.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "space", runId: { in: ["run", "skip"] }, type: "effect.recorded" },
      }),
    );
  });
  it("pages runs by creation time and id with a bounded page", async () => {
    const { prisma } = fixture();
    prisma.run.findMany.mockResolvedValue(
      Array.from({ length: 21 }, (_, n) => ({
        id: `run-${n}`,
        status: "completed",
        error: null,
        createdAt: new Date("2026-01-01"),
        completedAt: null,
        modelId: null,
      })) as never,
    );
    const result = await memoryOrganizationDiary(prisma as never, actor, "routine", {
      id: "cursor",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    expect(result.runs).toHaveLength(20);
    expect(result.nextCursor?.id).toBe("run-19");
    expect(prisma.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 21,
        where: expect.objectContaining({ ...actor, routineId: "routine", OR: expect.any(Array) }),
      }),
    );
  });
});
