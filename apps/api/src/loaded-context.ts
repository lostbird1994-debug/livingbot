import { ORPCError } from "@orpc/server";
import type { MemoryStore } from "@rakazo/adapter-kit";
import {
  loadAgentScratchpadContext,
  MEMORY_DOCUMENT_MAX_CHARS,
  MEMORY_INDEX_MAX_CHARS,
  MEMORY_PROFILE_MAX_CHARS,
  MEMORY_TOTAL_MAX_CHARS,
  previewAgentMemoryContext,
  runIdentityInstruction,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { botRoleCard, excludesSharedProfile } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

/** An ordinary private-chat preview, never a claim about a previously sent model request. */
export async function loadedBotContext(
  deps: { prisma: PrismaClient; memory: MemoryStore },
  actor: Actor,
  botId: string,
  signal = new AbortController().signal,
) {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    select: { id: true, name: true, description: true, instructions: true, roleCard: true },
  });
  if (!bot) throw new ORPCError("NOT_FOUND");
  const [memory, scratchpad] = await Promise.all([
    previewAgentMemoryContext(
      deps.memory,
      bot.id,
      {
        ...actor,
        botId,
        operationId: "loaded-context-preview",
        traceId: "loaded-context-preview",
        signal,
      },
      { excludeSharedProfile: excludesSharedProfile(bot.roleCard) },
    ),
    loadAgentScratchpadContext(deps, { spaceId: actor.spaceId, botId }),
  ]);
  return {
    identity: runIdentityInstruction(bot, "user"),
    roleCard: botRoleCard(bot.roleCard),
    sharedProfileExcluded: excludesSharedProfile(bot.roleCard),
    memory,
    scratchpad: scratchpad ?? "",
    budgets: {
      document: MEMORY_DOCUMENT_MAX_CHARS,
      body: MEMORY_TOTAL_MAX_CHARS,
      shared: MEMORY_PROFILE_MAX_CHARS,
      index: MEMORY_INDEX_MAX_CHARS,
    },
  };
}
