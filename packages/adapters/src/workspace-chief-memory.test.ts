import type { Actor } from "@livingbot/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  assignSharedMemoryToWorkspaceChiefs,
  ensureChiefMemoryOrganization,
  ownsSharedMemoryOrganization,
} from "./memory-organization.js";

const member = { spaceId: "space", userId: "user" };
const actor = member as Actor;
function fixture() {
  const ordinary = {
    id: "ordinary-routine",
    botId: "ordinary",
    active: true,
    sharedMemoryOrganizer: true,
    bot: { name: "Assistant", spawnKey: null, disabledBuiltinTools: [] as string[] },
  };
  const chief = {
    id: "chief-routine",
    botId: "chief",
    active: true,
    sharedMemoryOrganizer: false,
    bot: {
      name: "Renamed steward",
      spawnKey: "onboarding:first",
      disabledBuiltinTools: [] as string[],
    },
  };
  const rows = [ordinary, chief];
  const routine = {
    findMany: vi.fn().mockResolvedValue(rows),
    findFirst: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(chief),
    updateMany: vi.fn(async () => {
      rows.forEach((r) => {
        r.sharedMemoryOrganizer = false;
      });
    }),
    update: vi.fn(async ({ where, data }) => {
      Object.assign(rows.find((r) => r.id === where.id)!, data);
    }),
  };
  const tx = {
    routine,
    $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
    bot: { findFirst: vi.fn().mockResolvedValue({ id: "chief", disabledBuiltinTools: [] }) },
    user: { findUnique: vi.fn().mockResolvedValue({ timezone: "Asia/Shanghai" }) },
  };
  const prisma = {
    routine: { findMany: vi.fn().mockResolvedValue([member]), findFirst: routine.findFirst },
    $transaction: vi.fn(async (operation) => operation(tx)),
  };
  return { ordinary, chief, rows, routine, tx, prisma };
}

describe("Chief shared-memory assignment", () => {
  it("changes only the scoped owner flags and is idempotent", async () => {
    const { prisma, routine, chief } = fixture();
    expect(await assignSharedMemoryToWorkspaceChiefs(prisma as never)).toEqual({
      changed: 1,
      unchanged: 0,
      missingChief: 0,
      unavailableChief: 0,
    });
    expect(routine.updateMany).toHaveBeenCalledWith({
      where: { ...member, sharedMemoryOrganizer: true },
      data: { sharedMemoryOrganizer: false },
    });
    expect(routine.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: chief.id },
      data: { sharedMemoryOrganizer: true },
    });
    expect(await assignSharedMemoryToWorkspaceChiefs(prisma as never)).toMatchObject({
      changed: 0,
      unchanged: 1,
    });
    expect(routine.update).toHaveBeenCalledTimes(1);
  });
  it.each(["missing", "paused", "disabled"])(
    "does not select another bot when Chief is %s",
    async (kind) => {
      const { prisma, routine, chief, ordinary } = fixture();
      if (kind === "missing") routine.findMany.mockResolvedValue([ordinary]);
      if (kind === "paused") chief.active = false;
      if (kind === "disabled") chief.bot.disabledBuiltinTools = ["organize_memory"];
      const result = await assignSharedMemoryToWorkspaceChiefs(prisma as never);
      expect(result[kind === "missing" ? "missingChief" : "unavailableChief"]).toBe(1);
      expect(routine.update).not.toHaveBeenCalled();
      expect(routine.updateMany).not.toHaveBeenCalled();
    },
  );
  it("defaults runtime ownership to the renamed Chief, not the first bot", async () => {
    const { routine, chief } = fixture();
    const prisma = { routine };
    expect(
      await ownsSharedMemoryOrganization(prisma as never, { ...member, botId: "ordinary" }),
    ).toBe(false);
    expect(await ownsSharedMemoryOrganization(prisma as never, { ...member, botId: "chief" })).toBe(
      true,
    );
    chief.active = false;
    expect(await ownsSharedMemoryOrganization(prisma as never, { ...member, botId: "chief" })).toBe(
      false,
    );
  });
});

describe("new onboarding Chief", () => {
  it("creates a daily local-time routine and default owner without an immediate model call", async () => {
    const { prisma, routine, tx } = fixture();
    const now = new Date("2026-11-08T12:00:00Z");
    await ensureChiefMemoryOrganization(prisma as never, actor, "chief", now);
    expect(tx.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ...member, id: "chief", archivedAt: null, spawnKey: "onboarding:first" },
      }),
    );
    expect(routine.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          ...member,
          botId: "chief",
          active: true,
          memoryMaintenance: true,
          crons: ["0 18 * * *"],
          timezone: "Asia/Shanghai",
          nextRunAt: new Date("2026-11-09T10:00:00Z"),
        }),
        update: {},
      }),
    );
    expect(routine.update).toHaveBeenCalledWith({
      where: { id: "chief-routine" },
      data: { sharedMemoryOrganizer: true },
    });
  });
  it("preserves existing schedules, pause states, models and a manual shared owner on retries", async () => {
    const { prisma, routine } = fixture();
    routine.findFirst.mockResolvedValue({ id: "manual-owner" } as never);
    await ensureChiefMemoryOrganization(prisma as never, actor, "chief");
    expect(routine.upsert.mock.calls[0]?.[0].update).toEqual({});
    expect(routine.update).not.toHaveBeenCalled();
  });
  it.each(["missing", "disabled"])("leaves an unavailable %s bot alone", async (kind) => {
    const { prisma, tx, routine } = fixture();
    tx.bot.findFirst.mockResolvedValue(
      kind === "missing"
        ? (null as never)
        : ({ id: "chief", disabledBuiltinTools: ["read_memory"] } as never),
    );
    await ensureChiefMemoryOrganization(prisma as never, actor, "chief");
    expect(routine.upsert).not.toHaveBeenCalled();
  });
});
