import { ThreadStoppedPayloadSchema } from "@livingbot/contracts";
import type { PrismaClient } from "./client.js";

export interface ThreadStopContext {
  stoppedAt: string;
  throughMessageSeq: number | null;
  cancelledMessageIds: string[];
}

/**
 * Read durable lifecycle records separately from compactable chat history.
 * Legacy run cancellations remain meaningful even without a batch snapshot.
 */
export async function loadThreadStopContext(
  prisma: PrismaClient,
  run: { threadId: string; botId: string },
  messages: ReadonlyArray<{ id: string; runId: string | null }>,
): Promise<ThreadStopContext | undefined> {
  const events = await prisma.event.findMany({
    where: {
      threadId: run.threadId,
      botId: run.botId,
      type: { in: ["thread.stopped", "run.cancelled"] },
    },
    orderBy: { seq: "asc" },
    select: { type: true, runId: true, payload: true, createdAt: true },
  });
  if (!events.length) return undefined;
  const messageIds = new Set<string>();
  const runIds = new Set<string>();
  let throughMessageSeq: number | null = null;
  for (const event of events) {
    if (event.type === "run.cancelled" && event.runId) runIds.add(event.runId);
    if (event.type !== "thread.stopped") continue;
    const payload = ThreadStoppedPayloadSchema.parse(event.payload);
    for (const id of payload.runIds) runIds.add(id);
    for (const id of payload.messageIds) messageIds.add(id);
    throughMessageSeq = payload.throughMessageSeq;
  }
  return {
    stoppedAt: events.at(-1)!.createdAt.toISOString(),
    throughMessageSeq,
    cancelledMessageIds: messages
      .filter(
        (message) => messageIds.has(message.id) || (message.runId && runIds.has(message.runId)),
      )
      .map((message) => message.id),
  };
}
