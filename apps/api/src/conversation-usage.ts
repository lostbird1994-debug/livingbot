import type { Actor, ConversationUsage } from "@livingbot/contracts";
import type { PrismaClient } from "@livingbot/db";
import { Prisma } from "@livingbot/db";

type Totals = ConversationUsage["total"];
type Aggregate = {
  latest: boolean;
  calls: number;
  reportedCalls: number;
  tokens: number | null;
  knownTokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  generationDurationMs: number | null;
  modelDurationMs: number | null;
};

export function usageTotals(row?: Aggregate): Totals {
  if (!row)
    return {
      calls: 0,
      reportedCalls: 0,
      tokens: 0,
      knownTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheHitRate: null,
      tokensPerSecond: null,
      modelDurationMs: null,
    };
  return {
    calls: row.calls,
    reportedCalls: row.reportedCalls,
    tokens: row.tokens,
    knownTokens: row.knownTokens,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheHitRate:
      row.cacheReadTokens !== null &&
      row.inputTokens !== null &&
      row.inputTokens > 0 &&
      row.cacheReadTokens <= row.inputTokens
        ? row.cacheReadTokens / row.inputTokens
        : null,
    tokensPerSecond:
      row.generationDurationMs !== null && row.generationDurationMs > 0 && row.outputTokens !== null
        ? (row.outputTokens * 1000) / row.generationDurationMs
        : null,
    modelDurationMs: row.modelDurationMs,
  };
}

/** Aggregate the whole ledger, not usage.list's recent 100 rows. Target is authorized by caller. */
export async function conversationUsage(
  prisma: PrismaClient,
  actor: Actor,
  threadId: string,
): Promise<ConversationUsage> {
  const run = await prisma.run.findFirst({
    where: { spaceId: actor.spaceId, userId: actor.userId, threadId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, status: true, startedAt: true, completedAt: true },
  });
  // Explicit tenant predicates also protect raw SQL; parent attribution includes subagent spend.
  const rows = await prisma.$queryRaw<Aggregate[]>(Prisma.sql`
    WITH scoped AS (
      SELECT u.*,
        COALESCE(u."parentRunId",u."runId") = ${run?.id ?? ""} AS "isLatest",
        COALESCE(u."totalTokens",
          u."inputTokens" + u."outputTokens" + u."cacheReadTokens" + u."cacheWriteTokens"
        ) AS measured_total,
        CASE WHEN u."totalTokens" IS NOT NULL AND u."outputTokens" IS NOT NULL
          AND u."totalTokens" >= u."outputTokens"
          THEN u."totalTokens" - u."outputTokens"
          ELSE u."inputTokens" + u."cacheReadTokens" + u."cacheWriteTokens"
        END AS prompt
      FROM usage_records u
      JOIN runs r ON r.id = COALESCE(u."parentRunId",u."runId")
      WHERE r."threadId" = ${threadId}
        AND r."spaceId" = ${actor.spaceId} AND r."userId" = ${actor.userId}
        AND u."spaceId" = ${actor.spaceId} AND u."userId" = ${actor.userId}
    ), grouped AS (
      SELECT false AS latest, * FROM scoped
      UNION ALL SELECT true AS latest, s.* FROM scoped s WHERE s."isLatest"
    )
    SELECT g.latest,
      count(*)::int AS calls,
      count(measured_total)::int AS "reportedCalls",
      CASE WHEN count(measured_total) = count(*) THEN sum(measured_total)::float8 END AS tokens,
      coalesce(sum(measured_total),0)::float8 AS "knownTokens",
      CASE WHEN count(prompt) = count(*) THEN sum(prompt)::float8 END AS "inputTokens",
      CASE WHEN count("outputTokens") = count(*) THEN sum("outputTokens")::float8 END AS "outputTokens",
      CASE WHEN count("cacheReadTokens") = count(*) THEN sum("cacheReadTokens")::float8 END AS "cacheReadTokens",
      CASE WHEN count(CASE WHEN "generationDurationMs" > 0 THEN 1 END) = count(*)
        THEN sum("generationDurationMs")::float8 END AS "generationDurationMs",
      CASE WHEN count("modelDurationMs") = count(*) THEN sum("modelDurationMs")::float8 END AS "modelDurationMs"
    FROM grouped g GROUP BY g.latest
  `);
  const context = run
    ? await prisma.usageRecord.findFirst({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          runId: run.id,
          agentId: null,
          operationKind: { in: ["answer", "retrieval"] },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { contextTokens: true, contextWindow: true },
      })
    : null;
  return {
    threadId,
    total: usageTotals(rows.find((row) => !row.latest)),
    latest: run
      ? {
          runId: run.id,
          status: run.status,
          startedAt: run.startedAt?.toISOString() ?? null,
          completedAt: run.completedAt?.toISOString() ?? null,
          ...usageTotals(rows.find((row) => row.latest)),
        }
      : null,
    context:
      context?.contextTokens !== null &&
      context?.contextTokens !== undefined &&
      context.contextWindow !== null &&
      context.contextWindow > 0
        ? {
            tokens: context.contextTokens,
            window: context.contextWindow,
            estimated: true,
          }
        : null,
  };
}
