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
import type { BotWorkspaceProfiles, NativeBootstrapPreview } from "@rakazo/adapters";

/** An ordinary private-chat preview, never a claim about a previously sent model request. */
export async function loadedBotContext(
  deps: {
    prisma: PrismaClient; memory: MemoryStore; botWorkspace?: BotWorkspaceProfiles;
    nativeContextPreview?: (actor: Actor, botId: string) => Promise<NativeBootstrapPreview>;
  },
  actor: Actor,
  botId: string,
  signal = new AbortController().signal,
) {
  await deps.botWorkspace?.refresh(actor, botId);
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    select: { id: true, name: true, description: true, instructions: true, roleCard: true },
  });
  if (!bot) throw new ORPCError("NOT_FOUND");
  if (deps.nativeContextPreview) {
    const [native, scratchpad] = await Promise.all([
      deps.nativeContextPreview(actor, botId),
      loadAgentScratchpadContext(deps, { spaceId: actor.spaceId, botId }),
    ]);
    const memoryDocs = native.documents.filter(doc =>
      doc.name === "MEMORY.md" || doc.scope === "user");
    const body = memoryDocs.map(doc => doc.excerpt).filter(Boolean).join("\n\n");
    return {
      nativeContext: native,
      identity: native.documents.filter(doc => doc.scope === "bot" &&
        ["IDENTITY.md", "SOUL.md", "AGENTS.md", "USER.md"].includes(doc.name))
        .map(doc => doc.excerpt).join("\n\n"),
      roleCard: botRoleCard(bot.roleCard), sharedProfileExcluded: false,
      scratchpad: scratchpad ?? "",
      memory: {
        context: body, body, index: "",
        documents: memoryDocs.map(doc => ({
          scope: doc.scope, path: doc.name.replace(/^工作区共享\//, ""), revision: 0,
          totalChars: doc.totalChars, shownChars: doc.shownChars, excerpt: doc.excerpt,
        })),
      },
      budgets: {
        document: native.budgets.document, body: native.budgets.total,
        shared: native.budgets.total, index: 0,
      },
    };
  }
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
