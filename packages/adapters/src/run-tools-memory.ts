import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import { HistoryReadInputSchema, HistorySearchInputSchema } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { readHistory, searchHistory } from "@rakazo/db";
import { sharedMemorySaveError } from "./builtin-tools.js";
import { redactConnectorPayload } from "./connector-safety.js";
import { MAX_RECALLED_MEMORIES } from "./history-compaction.js";
import { MEMORY_DOCUMENT_MAX_CHARS, normalizeMemoryPath } from "./memory-context.js";
import { appendMemoryFact } from "./memory-tools.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { charLength } from "./utf8.js";

/** One read returns at most the per-document prompt budget; the tool reports where to resume. */
const MEMORY_READ_MAX_CHARS = MEMORY_DOCUMENT_MAX_CHARS;
const MEMORY_SEARCH_MAX_RESULTS = 20;
/** One document may be rewritten up to this size; the prompt only ever inlines the first 20,000. */
const MEMORY_WRITE_MAX_CHARS = 200_000;

/** Cross-chat history requires a surviving direct human request in this app thread. */
export function historyMyChatsAllowed(
  run: { trigger: string; threadId: string },
  source: { role: string; threadId: string } | null,
  external: boolean,
): boolean {
  return (
    !external &&
    (run.trigger === "user" || run.trigger === "follow_up") &&
    source?.role === "user" &&
    source.threadId === run.threadId
  );
}

async function readHistoryTool(ctx: RunContext, call: ToolCall) {
  const { deps, run } = ctx;
  const { name, args } = call;
  const crossChat =
    name === "search_history"
      ? args.scope === "my_chats"
      : typeof args.threadId === "string" && args.threadId !== run.threadId;
  // Channel or webhook text claimed mid-turn revokes the grant for the rest of the run.
  const allowMyChats =
    crossChat && ctx.source.myChatsAllowed && !(await ctx.trust.receivedOutsideMessage());
  const scope = {
    spaceId: run.spaceId,
    userId: run.userId,
    threadId: run.threadId,
    botId: run.botId,
    channelId: ctx.source.channelId,
    searchBeforeSeq: ctx.source.historySearchBeforeSeq,
    allowMyChats,
    searchAt: run.createdAt,
  };
  const response =
    name === "search_history"
      ? await searchHistory(deps.prisma, scope, HistorySearchInputSchema.parse(args))
      : await readHistory(deps.prisma, scope, HistoryReadInputSchema.parse(args));
  const redacted = redactConnectorPayload(response, ctx.secrets);
  // Redaction can expand short synthetic credentials; never let Pi clip the JSON.
  if (Buffer.byteLength(JSON.stringify(redacted), "utf8") > 11_000) {
    return call.finish({
      untrusted: true,
      error:
        "Redacted history exceeds the response budget. Retry with limit 1 or a narrower linked run.",
    });
  }
  return call.finish(redacted);
}

/** Memory documents, semantic memory and thread history. */
export const memoryTools: ToolHandlers = {
  async read_memory(ctx, call) {
    const { args } = call;
    const wanted = String(args.path ?? "").trim();
    if (!wanted) {
      return call.finish({
        error: "path is required, for example MEMORY.md.",
        paths: (await listMemoryDocuments(ctx)).map((document) => document.path),
      });
    }
    const document = await findMemoryDocument(ctx, wanted);
    if (!document) {
      return call.finish({
        error: `No memory document at "${wanted}".`,
        paths: (await listMemoryDocuments(ctx)).map((entry) => `${entry.scope}:${entry.path}`),
      });
    }
    const characters = Array.from(document.content);
    const totalChars = characters.length;
    const offset = clampOffset(args.offset, totalChars);
    const maxChars = Math.min(
      MEMORY_READ_MAX_CHARS,
      positiveInteger(args.max_chars) ?? MEMORY_READ_MAX_CHARS,
    );
    const slice = characters.slice(offset, offset + maxChars).join("");
    const nextOffset = offset + charLength(slice);
    return call.finish({
      path: document.path,
      scope: document.scope,
      revision: document.revision,
      totalChars,
      offset,
      truncated: nextOffset < totalChars,
      ...(nextOffset < totalChars ? { nextOffset } : {}),
      content: redactSecrets(slice, ctx.secrets),
    });
  },
  async search_memory(ctx, call) {
    const { deps, bot, context } = ctx;
    const { args } = call;
    const query = String(args.query ?? "").trim();
    if (!query) return call.finish({ error: "query is required." });
    const limit = Math.min(MEMORY_SEARCH_MAX_RESULTS, positiveInteger(args.limit) ?? 8);
    // The store filters by botId, so user-scope documents need their own query.
    const [botHits, userHits] = await Promise.all([
      deps.memory.search({ query, scope: "bot", botId: bot.id }, context),
      deps.memory.search({ query, scope: "user" }, context),
    ]);
    const results = [
      ...userHits.map((hit) => ({ ...hit, scope: "user" as const })),
      ...botHits.map((hit) => ({ ...hit, scope: "bot" as const })),
    ]
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, limit)
      .map((hit) => ({
        scope: hit.scope,
        path: hit.path,
        score: hit.score,
        snippet: redactSecrets(hit.snippet, ctx.secrets),
      }));
    return call.finish({ query, matches: results.length, results });
  },
  async write_memory(ctx, call) {
    const { deps, runId, bot, thread, context } = ctx;
    const { args } = call;
    const path = String(args.path ?? "").trim();
    const content = String(args.content ?? "");
    if (!path) return call.finish({ error: "path is required, for example MEMORY.md." });
    if (!content.trim()) {
      return call.finish({
        error:
          "An empty document would erase what the next run reads. Write nothing instead, or say what should be removed.",
      });
    }
    if (charLength(content) > MEMORY_WRITE_MAX_CHARS) {
      return call.finish({
        error: `That is ${charLength(content)} characters; one document may hold ${MEMORY_WRITE_MAX_CHARS}.`,
      });
    }
    const snapshot = await deps.memory.read({ scope: "bot", botId: bot.id, path }, context);
    const existing = snapshot.documents[0];
    const expectedRevision = Number(args.expected_revision ?? existing?.revision ?? 0);
    if (existing && expectedRevision !== existing.revision) {
      return call.finish({
        error: `That document changed since you read it. Read it again; it is at revision ${existing.revision}.`,
        revision: existing.revision,
      });
    }
    const saved = await deps.memory
      .commit(
        {
          scope: "bot",
          botId: bot.id,
          path,
          content,
          expectedRevision,
          sourceRunId: runId,
          sourceThreadId: thread.id,
        },
        context,
      )
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        if (message === MEMORY_REVISION_CONFLICT_ERROR) return null;
        throw error;
      });
    if (!saved) {
      return call.finish({
        error: "Another write landed first. Read the document again before rewriting it.",
      });
    }
    return call.finish({
      ok: true,
      path: saved.path,
      revision: saved.revision,
      chars: charLength(content),
    });
  },
  async remember(ctx, call) {
    const { deps, runId, bot, thread, context } = ctx;
    const { args } = call;
    const path = String(args.path ?? "").trim() || "MEMORY.md";
    // A fact is added to the document, never replaces it. A concurrent save
    // changes the revision, so re-read and append again.
    for (let attempt = 1; ; attempt += 1) {
      const snapshot = await deps.memory.read({ scope: "bot", botId: bot.id, path }, context);
      const existing = snapshot.documents[0];
      const content = appendMemoryFact(existing?.content ?? "", String(args.content ?? ""));
      if (content === (existing?.content ?? "")) return call.finish({ ok: true });
      try {
        await deps.memory.commit(
          {
            scope: "bot",
            botId: bot.id,
            path,
            content,
            expectedRevision: existing?.revision ?? 0,
            sourceRunId: runId,
            sourceThreadId: thread.id,
          },
          context,
        );
        return call.finish({ ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message !== MEMORY_REVISION_CONFLICT_ERROR || attempt >= 3) throw error;
      }
    }
  },
  async save_shared_memory(ctx, call) {
    const { deps, runId, thread, context } = ctx;
    const { args } = call;
    const invalid = sharedMemorySaveError(args);
    if (invalid) return call.finish({ error: invalid });
    const path = String(args.path ?? "").trim();
    // The save replaces the whole document. Pass the revision just read so a
    // concurrent edit is rejected instead of overwritten.
    const snapshot = await deps.memory.read({ scope: "user", path }, context);
    const expectedRevision = snapshot.documents[0]?.revision ?? 0;
    try {
      const saved = await deps.memory.commit(
        {
          scope: "user",
          path,
          content: String(args.content ?? ""),
          expectedRevision,
          sourceRunId: runId,
          sourceThreadId: thread.id,
        },
        context,
      );
      return call.finish({ ok: true, path: saved.path, revision: saved.revision });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save shared memory.";
      if (message === MEMORY_REVISION_CONFLICT_ERROR) return call.finish({ error: message });
      throw error;
    }
  },
  async recall_memory(ctx, call) {
    const { bot, thread, context } = ctx;
    const { args } = call;
    return ctx.memory.semantic!.recall(
      {
        query: String(args.query ?? ""),
        scope: ctx.memory.scope!,
        botId: bot.id,
        ...(thread.historyCompactedUpToSeq == null
          ? {}
          : { historyGeneration: thread.historyCompactionGeneration }),
        limit: MAX_RECALLED_MEMORIES,
      },
      context,
    );
  },
  search_history: readHistoryTool,
  read_history: readHistoryTool,
  async save_memory(ctx, call) {
    const { bot, context } = ctx;
    const { args } = call;
    return call.finish(
      await ctx.memory.semantic!.save(
        {
          content: String(args.content ?? ""),
          scope: ctx.memory.scope!,
          botId: bot.id,
          source: { kind: "durable" },
        },
        context,
      ),
    );
  },
  async forget_memory(ctx, call) {
    const { bot, context } = ctx;
    const { args } = call;
    if (!ctx.memory.semantic?.forget) {
      return call.finish({
        error: "This memory provider does not support forgetting individual facts.",
      });
    }
    return call.finish(
      await ctx.memory.semantic.forget(
        {
          id: String(args.id ?? ""),
          scope: ctx.memory.scope!,
          botId: bot.id,
          ...(typeof args.entity === "string" && args.entity.trim()
            ? { entity: args.entity.trim() }
            : {}),
          ...(typeof args.reason === "string" && args.reason.trim()
            ? { reason: args.reason.trim() }
            : {}),
        },
        context,
      ),
    );
  },
};

type ScopedMemoryDocument = {
  id: string;
  path: string;
  content: string;
  revision: number;
  updatedAt?: string;
  scope: "bot" | "user";
};

async function listMemoryDocuments(ctx: RunContext): Promise<ScopedMemoryDocument[]> {
  const { deps, bot, context } = ctx;
  const [botMemory, userMemory] = await Promise.all([
    deps.memory.read({ scope: "bot", botId: bot.id }, context),
    deps.memory.read({ scope: "user" }, context),
  ]);
  return [
    ...userMemory.documents.map((document) => ({ ...document, scope: "user" as const })),
    ...botMemory.documents.map((document) => ({ ...document, scope: "bot" as const })),
  ];
}

async function findMemoryDocument(
  ctx: RunContext,
  wanted: string,
): Promise<ScopedMemoryDocument | null> {
  const { deps, bot, context } = ctx;
  const path = wanted.trim();
  const botSnapshot = await deps.memory.read({ scope: "bot", botId: bot.id, path }, context);
  const botHit = botSnapshot.documents[0];
  if (botHit) return { ...botHit, scope: "bot" };
  const userSnapshot = await deps.memory.read({ scope: "user", path }, context);
  const userHit = userSnapshot.documents[0];
  if (userHit) return { ...userHit, scope: "user" };
  // The caller is a model, so accept a different case or a leading "./" before giving up.
  const wantedKey = normalizeMemoryPath(path);
  const documents = await listMemoryDocuments(ctx);
  return documents.find((document) => normalizeMemoryPath(document.path) === wantedKey) ?? null;
}

function clampOffset(value: unknown, total: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.floor(parsed), total);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}
