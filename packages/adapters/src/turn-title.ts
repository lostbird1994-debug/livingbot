import type { AgentRunRequest, AgentRuntime } from "@livingbot/adapter-kit";
import type { MessageBlock } from "@livingbot/contracts";
import {
  blocksToAgentHistoryText,
  cleanTurnTitle,
  escapePromptData,
  MAX_TURN_TITLE_INPUT_CHARS,
  TURN_TITLE_INSTRUCTIONS,
  turnTitlePrompt,
} from "@livingbot/core";
import type { PrismaClient } from "@livingbot/db";
import { recordUsage } from "@livingbot/db";
import { getLogger } from "@livingbot/logging";
import { resolveDeploymentModel } from "./deployment-model.js";

export { cleanTurnTitle, MAX_TURN_TITLE_CHARS } from "@livingbot/core";

async function resolveTitleModel(
  deps: GenerateTurnTitleDeps,
  scope: { userId: string; spaceId: string; botId: string },
): Promise<AgentRunRequest["model"]> {
  if (deps.resolveModel) return deps.resolveModel(scope);
  const deployment = resolveDeploymentModel();
  if (deps.deploymentModelConfigured) {
    // Provider must come from the same resolver as the key, not a hardcoded one.
    return { provider: deployment.provider, id: deployment.model, apiKey: deps.deploymentModelKey };
  }
  const settings = await deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  return {
    provider: settings?.defaultModelProvider ?? "scripted",
    id: settings?.defaultModelId ?? "scripted",
    apiKey: undefined,
  };
}

export interface GenerateTurnTitleDeps {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  deploymentModelKey?: string;
  deploymentModelConfigured?: boolean;
  resolveModel?: (scope: {
    userId: string;
    spaceId: string;
    botId: string;
  }) => Promise<AgentRunRequest["model"]>;
}

function messageText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocksToAgentHistoryText(blocks as MessageBlock[]).trim();
}

/**
 * Names one turn once its reply exists, and writes the name on the message that opened the turn.
 * Routine and background work never arrives here: those turns have no one waiting to read a name.
 */
export async function generateTurnTitle(
  deps: GenerateTurnTitleDeps,
  input: { threadId: string; messageId: string },
): Promise<string | null> {
  const thread = await deps.prisma.thread.findUnique({
    where: { id: input.threadId },
    select: { id: true, spaceId: true, userId: true, botId: true, taskBotId: true },
  });
  if (!thread) return null;
  // An independent task owns its thread through taskBotId, so botId is null there.
  const botId = thread.botId ?? thread.taskBotId;
  if (!botId) return null;
  const anchor = await deps.prisma.message.findFirst({
    where: { id: input.messageId, threadId: thread.id },
    select: { id: true, seq: true, blocks: true, turnTitle: true },
  });
  // Already named by an earlier attempt: naming is idempotent per turn.
  if (!anchor || anchor.turnTitle) return null;
  const run = await deps.prisma.run.findFirst({
    where: { threadId: thread.id, sourceMessageId: anchor.id },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (!run) return null;
  const replies = await deps.prisma.message.findMany({
    where: { threadId: thread.id, runId: run.id, seq: { gt: anchor.seq } },
    orderBy: { seq: "asc" },
    take: 12,
    select: { blocks: true },
  });
  const opening = messageText(anchor.blocks).slice(0, MAX_TURN_TITLE_INPUT_CHARS);
  const reply = replies
    .map((row) => messageText(row.blocks))
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_TURN_TITLE_INPUT_CHARS);
  if (!opening && !reply) return null;

  const model = await resolveTitleModel(deps, {
    userId: thread.userId,
    spaceId: thread.spaceId,
    botId,
  });
  // "scripted" means nothing is configured and the runtime would echo canned text.
  if (model.provider === "scripted") return null;

  const operationId = `title:${anchor.id}`;
  const prompt = turnTitlePrompt({
    opening: escapePromptData(opening),
    ...(reply ? { reply: escapePromptData(reply) } : {}),
  });

  let raw = "";
  for await (const event of deps.runtime.run(
    {
      botId,
      threadId: thread.id,
      runId: operationId,
      usageOperationKind: "title",
      onUsage: async (event) => {
        await recordUsage(deps.prisma, event, {
          spaceId: thread.spaceId,
          userId: thread.userId,
          botId,
          operationId,
          operationKind: "title",
        });
      },
      prompt,
      instructions: TURN_TITLE_INSTRUCTIONS,
      history: [],
      tools: [],
      model,
      allowSilentEmpty: true,
    },
    {
      operationId,
      traceId: operationId,
      spaceId: thread.spaceId,
      userId: thread.userId,
      signal: AbortSignal.timeout(30_000),
    },
  )) {
    if (event.type === "usage" && !event.accounted) {
      await recordUsage(deps.prisma, event, {
        spaceId: thread.spaceId,
        userId: thread.userId,
        botId,
        operationId,
        operationKind: "title",
      });
    }
    if (event.type === "done" && event.text) raw = event.text;
  }

  const title = cleanTurnTitle(raw);
  if (!title) {
    getLogger().warn("turn.title produced no usable title", { "message.id": anchor.id });
    return null;
  }
  // Only the first name for a turn survives, so a retry cannot overwrite a newer one.
  await deps.prisma.message.updateMany({
    where: { id: anchor.id, turnTitle: null },
    data: { turnTitle: title },
  });
  return title;
}
