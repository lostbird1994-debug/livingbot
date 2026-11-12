import type { PrismaClient } from "./client.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS } from "./transaction-retry.js";

/** Reserve only this Bot's two independent task slots, across workers and restarts. */
export async function claimTaskSessionSlot(prisma: PrismaClient, runId: string, botId: string) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${botId} FOR UPDATE`;
    const current = await tx.run.findUniqueOrThrow({ where: { id: runId } });
    if (current.botId !== botId) return false;
    if (["completed", "failed", "cancelled"].includes(current.status)) return false;
    if (current.taskSlotHeld) return true;
    const held = await tx.run.count({ where: { botId, taskSlotHeld: true, id: { not: runId }, OR: [
      { status: { notIn: ["completed", "failed", "cancelled"] } },
      { resourceWaitReason: { in: ["unconfirmed", "stopping"] } },
    ] } });
    if (held >= 2) {
      await tx.run.updateMany({ where: { id: runId, status: "queued" },
        data: { resourceWaitReason: "task_slot", wakeAt: new Date(Date.now() + 2000) } });
      return false;
    }
    await tx.run.update({ where: { id: runId }, data: { taskSlotHeld: true, resourceWaitReason: null } });
    return true;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}
