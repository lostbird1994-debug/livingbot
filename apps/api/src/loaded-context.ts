import { loadBotContextPreview } from "@livingbot/adapters";
import type { Actor } from "@livingbot/contracts";
import { IsolationError } from "@livingbot/db";
import { ORPCError } from "@orpc/server";

export async function loadedBotContext(
  deps: Parameters<typeof loadBotContextPreview>[0],
  actor: Actor,
  botId: string,
  signal = new AbortController().signal,
) {
  await deps.botWorkspace?.refresh(actor, botId);
  try {
    return await loadBotContextPreview(deps, actor, botId, signal);
  } catch (error) {
    if (error instanceof IsolationError) throw new ORPCError("NOT_FOUND");
    throw error;
  }
}
