import type { Actor } from "@livingbot/contracts";
import type { PrismaClient } from "@livingbot/db";
import { describe, expect, it, vi } from "vitest";
import { conversationUsage, usageTotals } from "./conversation-usage.js";

const row = {
  latest: false,
  calls: 2,
  reportedCalls: 2,
  tokens: 220,
  knownTokens: 220,
  inputTokens: 200,
  outputTokens: 20,
  cacheReadTokens: 150,
  generationDurationMs: 500,
  modelDurationMs: 10000,
};
describe("conversation usage", () => {
  it("uses weighted input cache share and generation time instead of run wall time", () => {
    expect(usageTotals(row)).toMatchObject({
      cacheHitRate: 0.75,
      tokensPerSecond: 40,
    });
  });
  it("keeps incomplete token totals and unmeasured speed unknown", () => {
    expect(
      usageTotals({
        ...row,
        tokens: null,
        reportedCalls: 1,
        generationDurationMs: null,
        cacheReadTokens: null,
      }),
    ).toMatchObject({
      tokens: null,
      knownTokens: 220,
      cacheHitRate: null,
      tokensPerSecond: null,
    });
    expect(usageTotals({ ...row, inputTokens: 0, cacheReadTokens: 0 }).cacheHitRate).toBeNull();
  });
  it("counts no calls as zero without claiming a speed or cache rate", () => {
    expect(usageTotals()).toMatchObject({
      calls: 0,
      tokens: 0,
      cacheHitRate: null,
      tokensPerSecond: null,
    });
  });
  it("scopes both ledger and runs to the actor, retaining parent run attribution", async () => {
    const query = vi.fn(async (_query: unknown) => [row, { ...row, latest: true }]);
    const prisma = {
      run: {
        findFirst: vi.fn(async () => ({
          id: "run-fixture",
          status: "completed",
          startedAt: new Date(1000),
          completedAt: new Date(2000),
        })),
      },
      $queryRaw: query,
      usageRecord: {
        findFirst: vi.fn(async () => ({
          contextTokens: 700,
          contextWindow: 1000,
        })),
      },
    } as unknown as PrismaClient;
    const actor = { spaceId: "space-fixture", userId: "user-fixture" } as Actor;
    const result = await conversationUsage(prisma, actor, "thread-fixture");
    expect(prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          threadId: "thread-fixture",
        },
      }),
    );
    const sql = query.mock.calls[0]![0] as unknown as {
      text: string;
      values: unknown[];
    };
    expect(sql.text).toContain('COALESCE(u."parentRunId",u."runId")');
    expect(sql.values).toEqual([
      "run-fixture",
      "thread-fixture",
      actor.spaceId,
      actor.userId,
      actor.spaceId,
      actor.userId,
    ]);
    expect(result).toMatchObject({
      latest: { runId: "run-fixture", tokens: 220, tokensPerSecond: 40 },
      total: { tokens: 220 },
      context: { tokens: 700, window: 1000, estimated: true },
    });
  });
});
