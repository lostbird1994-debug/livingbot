import { ORPCError } from "@orpc/server";
import type { Actor, RoutineRunCursor } from "@rakazo/contracts";
import { MemoryOrganizationChangeSchema, RunStatus } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

/** Run records and durable tool receipts survive restarts, including silent checks. */
export async function memoryOrganizationDiary(
  prisma: PrismaClient,
  actor: Actor,
  routineId: string,
  before?: RoutineRunCursor,
) {
  const routine = await prisma.routine.findFirst({
    where: {
      id: routineId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      memoryMaintenance: true,
      bot: { archivedAt: null },
    },
    select: { id: true },
  });
  if (!routine) throw new ORPCError("NOT_FOUND");
  const rows = await prisma.run.findMany({
    where: {
      routineId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      ...(before
        ? {
            OR: [
              { createdAt: { lt: new Date(before.createdAt) } },
              { createdAt: new Date(before.createdAt), id: { lt: before.id } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      status: true,
      error: true,
      createdAt: true,
      completedAt: true,
      modelId: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 21,
  });
  const runs = rows.slice(0, 20);
  const events = runs.length
    ? await prisma.event.findMany({
        where: {
          spaceId: actor.spaceId,
          runId: { in: runs.map((run) => run.id) },
          type: "effect.recorded",
        },
        select: { runId: true, payload: true },
        orderBy: { seq: "asc" },
      })
    : [];
  const last = runs.at(-1);
  return {
    nextCursor:
      rows.length > 20 && last ? { id: last.id, createdAt: last.createdAt.toISOString() } : null,
    runs: runs.map((run) => {
      const receipts = events.filter((event) => event.runId === run.id);
      return {
        ...run,
        status: RunStatus.parse(run.status),
        createdAt: run.createdAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
        unchanged: receipts.some(({ payload }) => {
          return (
            payload !== null &&
            typeof payload === "object" &&
            !Array.isArray(payload) &&
            payload.tool === "memory_organization" &&
            payload.status === "unchanged"
          );
        }),
        changes: receipts.flatMap(({ payload }) => {
          const parsed = MemoryOrganizationChangeSchema.safeParse(payload);
          if (!parsed.success) return [];
          const { tool: _tool, ...change } = parsed.data;
          return [change];
        }),
      };
    }),
  };
}
