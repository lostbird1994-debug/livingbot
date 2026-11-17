import { randomUUID } from "node:crypto";
import type { PrismaClient } from "./client.js";
import { ciphertextKeyId, decryptText, encryptText } from "./content-crypto.js";
import { contentEncryptionOf } from "./content-encryption.js";

/** A model invocation may end while these conversation-owned operations continue. */
export const TASK_WORK_KIND = "task_work_v1";
export const TASK_WORK_ACTIVE = [
  "work_starting",
  "work_running",
  "work_polling",
  "work_stopping",
  "work_unconfirmed",
];
export type TaskWorkState =
  | "starting"
  | "running"
  | "polling"
  | "stopping"
  | "unconfirmed"
  | "completed"
  | "failed"
  | "cancelled";
export interface TaskWorkScope {
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
}
export interface TaskWorkDefinition {
  name: string;
  computerId: string;
  cwd?: string;
  start: string;
  poll: string;
  cancel: string;
}
export interface TaskWorkReceipt {
  handle?: string;
  summary?: string;
  stopRequested?: boolean;
  completionRunId?: string;
}
export interface TaskWork {
  id: string;
  runId: string;
  state: TaskWorkState;
  updatedAt: Date;
  definition: TaskWorkDefinition;
  receipt: TaskWorkReceipt;
}

async function seal(
  prisma: PrismaClient,
  row: { id: string; runId: string; spaceId: string },
  column: string,
  value: unknown,
) {
  const encryption = contentEncryptionOf(prisma);
  const text = JSON.stringify(value);
  return {
    ...(column === "result"
      ? { delivered: Boolean((value as TaskWorkReceipt).completionRunId) }
      : {}),
    data: encryption?.ring.encryptWrites
      ? encryptText(
          await encryption.ring.current(row.spaceId),
          { table: "external_effects", column, rowId: row.id, owner: row.runId },
          text,
        )
      : text,
  };
}
async function open<T>(
  prisma: PrismaClient,
  row: { id: string; runId: string },
  column: string,
  value: unknown,
): Promise<T> {
  const data = (value as { data: string }).data;
  const id = ciphertextKeyId(data);
  if (!id) return JSON.parse(data) as T;
  const encryption = contentEncryptionOf(prisma);
  if (!encryption) throw new Error("Task work encryption is unavailable");
  return JSON.parse(
    decryptText(
      await encryption.ring.byId(id),
      { table: "external_effects", column, rowId: row.id, owner: row.runId },
      data,
    ),
  ) as T;
}
type Row = {
  id: string;
  spaceId: string;
  runId: string;
  status: string;
  request: unknown;
  result: unknown;
  updatedAt: Date;
};
async function decode(prisma: PrismaClient, row: Row): Promise<TaskWork> {
  return {
    id: row.id,
    runId: row.runId,
    state: row.status.slice(5) as TaskWorkState,
    updatedAt: row.updatedAt,
    definition: await open<TaskWorkDefinition>(prisma, row, "request", row.request),
    receipt: await open<TaskWorkReceipt>(prisma, row, "result", row.result),
  };
}
function owned(scope: TaskWorkScope) {
  return {
    spaceId: scope.spaceId,
    kind: TASK_WORK_KIND,
    run: { userId: scope.userId, botId: scope.botId, threadId: scope.threadId },
  };
}

/** The caller must persist before launch. A repeated call returns the same operation, never launches it twice. */
export async function registerTaskWork(
  prisma: PrismaClient,
  scope: TaskWorkScope,
  runId: string,
  effectKey: string,
  definition: TaskWorkDefinition,
) {
  const idempotencyKey = `task-work:${effectKey}`;
  const prior = await prisma.externalEffect.findFirst({
    where: { ...owned(scope), idempotencyKey },
  });
  if (prior) return { work: await decode(prisma, prior), created: false };
  const row = { id: randomUUID(), runId, spaceId: scope.spaceId };
  const request = {
    ...(await seal(prisma, row, "request", definition)),
    computerId: definition.computerId,
  };
  const result = await seal(prisma, row, "result", {});
  return prisma.$transaction(async (tx) => {
    // Same order as finalization and cancellation: the thread, then its run.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${scope.threadId} FOR UPDATE`;
    const run = await tx.run.findFirst({
      where: {
        id: runId,
        spaceId: scope.spaceId,
        userId: scope.userId,
        botId: scope.botId,
        threadId: scope.threadId,
        status: "running",
      },
    });
    if (!run) throw new Error("Task stopped before work registration");
    const existing = await tx.externalEffect.findFirst({
      where: { ...owned(scope), idempotencyKey },
    });
    if (existing) return { work: await decode(prisma, existing), created: false };
    const saved = await tx.externalEffect.create({
      data: {
        ...row,
        kind: TASK_WORK_KIND,
        idempotencyKey,
        status: "work_starting",
        request,
        result,
      },
    });
    await tx.run.update({ where: { id: runId }, data: { resourceWaitReason: "background_work" } });
    return { work: await decode(prisma, saved), created: true };
  });
}

export async function listTaskWork(
  prisma: PrismaClient,
  scope: TaskWorkScope,
  options: { activeOnly?: boolean; id?: string } = {},
) {
  const rows = await prisma.externalEffect.findMany({
    where: {
      ...owned(scope),
      ...(options.id ? { id: options.id } : {}),
      ...(options.activeOnly ? { status: { in: TASK_WORK_ACTIVE } } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
  return Promise.all(rows.map((row) => decode(prisma, row)));
}

/** Compare-and-swap fences observation and cancellation; late polls cannot overwrite a stop request. */
export async function writeTaskWork(
  prisma: PrismaClient,
  scope: TaskWorkScope,
  work: TaskWork,
  state: TaskWorkState,
  receipt: TaskWorkReceipt,
) {
  const result = await seal(prisma, { ...work, spaceId: scope.spaceId }, "result", receipt);
  const updatedAt = new Date(Math.max(Date.now(), work.updatedAt.getTime() + 1));
  const changed = await prisma.externalEffect.updateMany({
    where: {
      ...owned(scope),
      id: work.id,
      status: `work_${work.state}`,
      updatedAt: work.updatedAt,
    },
    data: { status: `work_${state}`, result, updatedAt },
  });
  return changed.count === 1 ? { ...work, state, receipt, updatedAt } : null;
}

export async function requestTaskWorkStop(
  prisma: PrismaClient,
  scope: TaskWorkScope,
  work: TaskWork,
) {
  return writeTaskWork(prisma, scope, work, "stopping", { ...work.receipt, stopRequested: true });
}
