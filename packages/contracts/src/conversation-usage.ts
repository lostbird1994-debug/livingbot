import * as z from "zod";

export const ConversationUsageTotalsSchema = z.object({
  calls: z.number().int().nonnegative(),
  reportedCalls: z.number().int().nonnegative(),
  tokens: z.number().nonnegative().nullable(),
  knownTokens: z.number().nonnegative(),
  inputTokens: z.number().nonnegative().nullable(),
  outputTokens: z.number().nonnegative().nullable(),
  cacheReadTokens: z.number().nonnegative().nullable(),
  cacheHitRate: z.number().min(0).max(1).nullable(),
  tokensPerSecond: z.number().nonnegative().nullable(),
  modelDurationMs: z.number().nonnegative().nullable(),
});

export const ConversationUsageSchema = z.object({
  threadId: z.string(),
  total: ConversationUsageTotalsSchema,
  latest: z
    .object({
      runId: z.string(),
      status: z.string(),
      startedAt: z.string().nullable(),
      completedAt: z.string().nullable(),
      ...ConversationUsageTotalsSchema.shape,
    })
    .nullable(),
  context: z
    .object({
      tokens: z.number().int().nonnegative(),
      window: z.number().int().positive(),
      estimated: z.literal(true),
    })
    .nullable(),
});

export type ConversationUsage = z.infer<typeof ConversationUsageSchema>;
