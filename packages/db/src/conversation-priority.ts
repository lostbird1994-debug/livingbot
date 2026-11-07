import type { PrismaClient } from "./client.js";
import { createPendingSteeringRun } from "./events.js";

/** Background checks yield to this bot's due conversation, without interrupting active work. */
export async function prioritizeConversation(
  prisma: PrismaClient,
  run: { id: string; spaceId: string; threadId: string; botId: string },
): Promise<{ blocked: boolean; continuationRunId: string | null }> {
  return prisma.$transaction(async (tx) => {
    // Serialize continuation creation with message consumption and run finalization.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    const continuationRunId = await createPendingSteeringRun(tx, run);
    const conversation = await tx.run.findFirst({
      where: {
        botId: run.botId,
        id: { not: run.id },
        trigger: { notIn: ["routine", "reaction"] },
        OR: [
          { status: { in: ["leased", "running"] } },
          { status: "queued", OR: [{ wakeAt: null }, { wakeAt: { lte: new Date() } }] },
        ],
      },
      select: { id: true },
    });
    return { blocked: conversation !== null, continuationRunId };
  });
}
