import type { MessageBlock } from "@livingbot/contracts";
import type { PrismaClient, ThreadEvents } from "@livingbot/db";
import { appendEventInTransaction, createThreadMessageInTransaction, runAsSystem, runAsTenant,
  THREAD_LOCK_TRANSACTION_OPTIONS } from "@livingbot/db";

/** The terminal Run is the durable delivery intent. Receipt and card commit together. */
export async function publishTaskSessionReceipts(deps: { prisma: PrismaClient; events: ThreadEvents }) {
  const runs = await runAsSystem("find undelivered independent task results", () => deps.prisma.run.findMany({
    where: { thread: { taskBotId: { not: null } }, status: { in: ["completed", "failed", "cancelled"] },
      OR: [{ resourceWaitReason: null }, { resourceWaitReason: { notIn: ["unconfirmed", "stopping"] } }], taskSessionReceipt: null },
    orderBy: { createdAt: "asc" }, take: 100,
  }));
  for (const run of runs) await runAsTenant(run, async () => {
    const result = await deps.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR UPDATE`;
      const current = await tx.run.findUniqueOrThrow({ where: { id: run.id } });
      if (!["completed", "failed", "cancelled"].includes(current.status) ||
        ["unconfirmed", "stopping"].includes(current.resourceWaitReason ?? "") ||
        await tx.taskSessionReceipt.findUnique({ where: { runId: run.id } })) return null;
      const session = await tx.botTaskSession.findUniqueOrThrow({ where: { threadId: run.threadId } });
      const output = await tx.message.findFirst({ where: { threadId: run.threadId, runId: run.id, role: "bot" }, orderBy: { seq: "desc" } });
      const blocks = Array.isArray(output?.blocks) ? output.blocks as MessageBlock[] : [];
      const summary = blocks.filter((block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text")
        .map(block => block.text).join("\n").slice(0, 400);
      const status = current.status === "completed" ? "已完成" : current.status === "cancelled" ? "已停止" : "失败";
      const message = await createThreadMessageInTransaction(tx, { threadId: session.mainThreadId, role: "bot", botId: session.botId,
        blocks: [{ kind: "text", text: `**${session.title} · ${status}**` },
          { kind: "text", text: summary || (current.status === "failed" ? "本轮任务未完成，请打开任务查看详情。" : "本轮执行记录已保留。") },
          { kind: "text", text: `[查看结果](/app/${encodeURIComponent(session.botId)}?task=${encodeURIComponent(session.id)})` }, ...blocks.filter(block => ["file", "image", "artifact"].includes(block.kind))],
        clientNonce: `task-result:${run.id}`, markUnread: true });
      await tx.taskSessionReceipt.create({ data: { runId: run.id, taskSessionId: session.id, messageId: message.id } });
      await tx.botTaskSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
      const event = await appendEventInTransaction(tx, { spaceId: run.spaceId, threadId: session.mainThreadId, botId: session.botId,
        type: "thread.message.created", payload: { messageId: message.id, seq: message.seq, role: "bot", blocks: message.blocks, taskResult: { taskSessionId: session.id, runId: run.id, title: session.title, status: current.status } } });
      return { threadId: session.mainThreadId, seq: event.seq };
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
    if (result) await deps.events.notify(result.threadId, result.seq);
  });
}
