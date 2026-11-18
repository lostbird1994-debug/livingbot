import type { Prisma, PrismaClient } from "./client.js";

/**
 * `unconfirmed` means the underlying execution state is unknown, so the turn waits for the
 * user to verify before anything is submitted again. A finished turn cannot be waiting on
 * that: its outcome is settled. The evidence that something may already have run belongs to
 * the conversation-owned work, which keeps its own row after the turn ends.
 *
 * `background_work` is deliberately different: work a finished turn handed to the host keeps
 * running, so a completed run may still legitimately wait on it.
 */
export function effectiveWaitReason(
  status: string,
  reason: string | null | undefined,
): string | null {
  if (!reason) return null;
  return status === "completed" && reason === "unconfirmed" ? null : reason;
}

/**
 * Runs a session still has to settle, as a Prisma filter: an unknown execution state, or a
 * stop the engine has not acknowledged. A completed run that kept a stale `unconfirmed`
 * (written before its turn finished) is not one of them.
 */
export const UNRESOLVED_RUN_WAIT = {
  OR: [
    { resourceWaitReason: "unconfirmed", status: { not: "completed" } },
    { resourceWaitReason: "stopping" },
  ],
} satisfies Prisma.RunWhereInput;

/**
 * Records that the engine could not report what a turn's execution did. Only a turn that can
 * still be resumed or verified takes this wait: a finished or superseded run is never marked,
 * so a late callback from an old fence cannot reopen a conversation a later turn already closed.
 */
export async function markExecutionStateUnconfirmed(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    userId: string;
    runId: string;
    leaseFence: number;
    error: string;
  },
): Promise<boolean> {
  const changed = await prisma.run.updateMany({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      userId: input.userId,
      leaseFence: input.leaseFence,
      status: { in: ["running", "cancelled", "waiting_input"] },
    },
    data: { error: input.error, resourceWaitReason: "unconfirmed" },
  });
  return changed.count === 1;
}
