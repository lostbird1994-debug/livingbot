import { ORPCError } from "@orpc/server";
import { chiefMemoryRoutine } from "@livingbot/adapters";
import type { Actor } from "@livingbot/contracts";
import type { PrismaClient } from "@livingbot/db";
import { lockSpaceSettings, withTransactionRetry } from "@livingbot/db";
import { mapRoutine } from "./routines.js";

const blockedTools = ["read_memory", "organize_memory"];
export async function listMemoryOrganizers(prisma: PrismaClient, actor: Actor) {
  const rows = await prisma.routine.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      memoryMaintenance: true,
      bot: { archivedAt: null },
    },
    include: {
      bot: {
        select: {
          name: true,
          spawnKey: true,
          modelId: true,
          disabledBuiltinTools: true,
        },
      },
    },
    orderBy: [{ botId: "asc" }, { id: "asc" }],
  });
  const eligible = (row: (typeof rows)[number]) =>
    !row.bot.disabledBuiltinTools.some((tool) => blockedTools.includes(tool));
  const explicit = await prisma.routine.findFirst({
    where: { spaceId: actor.spaceId, userId: actor.userId, sharedMemoryOrganizer: true },
    select: { id: true },
  });
  const chief = chiefMemoryRoutine(rows);
  const owner = explicit?.id ?? (chief?.active && eligible(chief) ? chief.id : null);
  return {
    sharedRoutineId: owner,
    routines: rows.map((row) => ({
      routine: mapRoutine(row),
      botName: row.bot.name,
      botModelId: row.bot.modelId,
      canOrganize: eligible(row),
      shared: owner === row.id,
    })),
  };
}

export async function selectSharedMemoryOrganizer(
  prisma: PrismaClient,
  actor: Actor,
  routineId: string,
) {
  await withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceSettings(tx, actor);
        // Scoped read and all writes share a serializable transaction. The partial unique index
        // prevents two API instances from assigning two owners to the same member and space.
        const row = await tx.routine.findFirst({
          where: {
            id: routineId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            memoryMaintenance: true,
            bot: { archivedAt: null },
          },
          select: { id: true, bot: { select: { disabledBuiltinTools: true } } },
        });
        if (!row) throw new ORPCError("NOT_FOUND");
        if (row.bot.disabledBuiltinTools.some((tool) => blockedTools.includes(tool)))
          throw new ORPCError("BAD_REQUEST", { message: "Enable this bot's memory tools first." });
        await tx.routine.updateMany({
          where: { spaceId: actor.spaceId, userId: actor.userId, sharedMemoryOrganizer: true },
          data: { sharedMemoryOrganizer: false },
        });
        await tx.routine.update({
          where: { id: row.id },
          data: { sharedMemoryOrganizer: true },
        });
      },
      { isolationLevel: "Serializable" },
    ),
  );
  return { ok: true as const };
}
