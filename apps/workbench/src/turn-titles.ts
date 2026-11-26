import { readFile } from "node:fs/promises";
import {
  cleanTurnTitle,
  TURN_TITLE_INSTRUCTIONS,
  turnTitlePrompt,
} from "../../../packages/core/src/turn-title.ts";
import type { Message } from "../../../packages/workbench/src/contracts.ts";
import type { WorkbenchStore } from "../../../packages/workbench/src/store.ts";

/** One short call per turn; anything slower than this is a provider problem, not a title. */
const COMPLETION_TIMEOUT_MS = 25_000;

/** Turns one request names, in parallel. The rest follow on the next call. */
export const MAX_TURNS_PER_REQUEST = 3;

// A reasoning model spends its output budget thinking first; a small cap returns no title at all.
const MAX_OUTPUT_TOKENS = 1_024;

type Connection = {
  baseUrl: string;
  api: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
};

/**
 * The model the kernel itself runs on, read from the same configuration file the gateway reads.
 * Naming a turn is a one-line side call, so it goes straight to the provider instead of
 * occupying an agent session.
 */
export function defaultConnection(config: Record<string, unknown>): Connection | null {
  const agents = config.agents as
    | { defaults?: { model?: string | { primary?: string } } }
    | undefined;
  const selection = agents?.defaults?.model;
  const primary = typeof selection === "string" ? selection : (selection?.primary ?? "");
  const slash = primary.indexOf("/");
  if (slash <= 0) return null;
  const providerId = primary.slice(0, slash);
  const modelId = primary.slice(slash + 1);
  const providers = (config.models as { providers?: Record<string, unknown> } | undefined)
    ?.providers;
  const provider = providers?.[providerId] as
    | {
        baseUrl?: unknown;
        api?: unknown;
        apiKey?: unknown;
        headers?: unknown;
      }
    | undefined;
  if (!provider || typeof provider.baseUrl !== "string" || !provider.baseUrl) return null;
  if (typeof provider.api !== "string" || !provider.api) return null;
  if (typeof provider.apiKey !== "string" || !provider.apiKey) return null;
  const headers =
    provider.headers && typeof provider.headers === "object"
      ? Object.fromEntries(
          Object.entries(provider.headers as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
  return {
    baseUrl: provider.baseUrl,
    api: provider.api,
    apiKey: provider.apiKey,
    model: modelId,
    ...(headers && Object.keys(headers).length ? { headers } : {}),
  };
}

/** One completion against an OpenAI-compatible endpoint; other protocols simply skip. */
async function completeOnce(
  connection: Connection,
  prompt: string,
  fetcher: typeof fetch,
): Promise<string> {
  if (connection.api !== "openai-completions") return "";
  const endpoint = `${connection.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${connection.apiKey}`,
      ...(connection.headers ?? {}),
    },
    body: JSON.stringify({
      model: connection.model,
      messages: [
        { role: "system", content: TURN_TITLE_INSTRUCTIONS },
        { role: "user", content: prompt },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`title completion failed (${response.status})`);
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

/** What the assistant said back, until the next thing the person said. */
function replyText(messages: readonly Message[], index: number): string {
  const parts: string[] = [];
  for (const message of messages.slice(index + 1)) {
    if (message.role === "user") break;
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) {
      if (block.kind === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

function openingText(message: Message): string {
  return message.blocks
    .flatMap((block) =>
      block.kind === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n")
    .trim();
}

export type NamedTurn = { id: string; title: string };

/**
 * Names the turns the margin is showing that have no name yet — history included, since a turn
 * only needs its own message and reply. Failures leave the turn showing its opening words.
 */
export async function nameTurnTitles(
  options: {
    store: WorkbenchStore;
    conversationId: string;
    messageIds: readonly string[];
    fetcher?: typeof fetch;
  },
  config: Record<string, unknown>,
): Promise<NamedTurn[]> {
  const connection = defaultConnection(config);
  if (!connection) return [];
  const fetcher = options.fetcher ?? fetch;
  const all = options.store
    .find<Message>("messages", "conversationId", options.conversationId)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const wanted = new Set(options.messageIds.slice(0, MAX_TURNS_PER_REQUEST));
  const pending = [...all.entries()].filter(
    ([, message]) =>
      wanted.has(message.id) &&
      message.role === "user" &&
      !message.turnTitle &&
      openingText(message),
  );
  // They run together: three short calls cost about one.
  const results = await Promise.all(
    pending.map(async ([index, message]) => {
      try {
        const raw = await completeOnce(
          connection,
          turnTitlePrompt({ opening: openingText(message), reply: replyText(all, index) }),
          fetcher,
        );
        const title = cleanTurnTitle(raw);
        return title ? ({ id: message.id, title, message } as const) : null;
      } catch {
        // A provider hiccup is not worth retrying here; the next open asks again.
        return null;
      }
    }),
  );
  const named: NamedTurn[] = [];
  for (const result of results) {
    if (!result) continue;
    // Only the first name for a turn survives, so a slower reply cannot overwrite a newer one.
    const current = options.store.get<Message>("messages", result.id);
    if (
      !current ||
      current.conversationId !== options.conversationId ||
      current.role !== "user" ||
      current.turnTitle ||
      openingText(current) !== openingText(result.message)
    )
      continue;
    options.store.put("messages", {
      ...current,
      turnTitle: result.title,
      updatedAt: Date.now(),
    });
    named.push({ id: result.id, title: result.title });
  }
  return named;
}

/** Reads the kernel configuration the gateway is running on. */
export async function readKernelConfig(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
