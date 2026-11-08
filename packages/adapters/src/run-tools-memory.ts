import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import {
  HistoryReadInputSchema,
  HistorySearchInputSchema,
  isMemoryReviewPath,
} from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { readHistory, searchHistory } from "@rakazo/db";
import { sharedMemorySaveError } from "./builtin-tools.js";
import { redactConnectorPayload } from "./connector-safety.js";
import { MAX_RECALLED_MEMORIES } from "./history-compaction.js";
import { normalizeMemoryPath } from "./memory-context.js";
import { MemoryConsolidationDecision, renderMemoryProposal } from "./memory-maintenance.js";
import { appendMemoryFact } from "./memory-tools.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { charLength } from "./utf8.js";

/** Leave room for JSON metadata and escaping below the runtime's 12,000-character limit. */
const MEMORY_READ_MAX_CHARS = 8_000;
const MEMORY_RESULT_MAX_BYTES = 11_000;
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
  async propose_memory_consolidation(ctx, call) {
    if (!ctx.source.memoryMaintenance || ctx.source.messagingChannelRun)
      return call.finish({ error: "Only a restricted maintenance run may save proposals." });
    const parsed = MemoryConsolidationDecision.safeParse(call.args);
    if (!parsed.success) return call.finish({ error: "Invalid source revision or line ranges." });
    const wanted = scopedPath(parsed.data.path);
    if (wanted.scope === "user")
      return call.finish({ error: "Only this bot's summary may be reviewed." });
    const source = await findMemoryDocument(ctx, `bot:${wanted.path}`);
    if (!source || !["memory.md", "user.md"].includes(normalizeMemoryPath(source.path)))
      return call.finish({ error: "Read this bot's MEMORY.md or USER.md first." });
    const coverage = ctx.source.memoryReadCoverage?.get(source.id);
    if (
      !coverage ||
      coverage.revision !== source.revision ||
      coverage.ranges.length !== 1 ||
      coverage.ranges[0]![0] !== 0 ||
      coverage.ranges[0]![1] !== coverage.total
    )
      return call.finish({
        error: "Read every page of the current source revision before proposing.",
      });
    try {
      const proposal = renderMemoryProposal(source, { ...parsed.data, path: source.path });
      const existing = await findMemoryDocument(ctx, `bot:${proposal.path}`);
      if (existing)
        return call.finish({ status: "already_proposed", path: `bot:${existing.path}` });
      const saved = await ctx.deps.memory.commit(
        {
          scope: "bot",
          botId: ctx.bot.id,
          ...proposal,
          expectedRevision: 0,
          sourceRunId: ctx.runId,
          sourceThreadId: ctx.thread.id,
        },
        ctx.context,
      );
      return call.finish({
        status: "proposed",
        path: `bot:${saved.path}`,
        sourceRevision: source.revision,
        sourceUnchanged: true,
      });
    } catch (error) {
      return call.finish({
        error: error instanceof Error ? error.message : "Could not save proposal.",
      });
    }
  },
  async read_memory(ctx, call) {
    const { args } = call;
    const wanted = String(args.path ?? "").trim();
    const requestedPath = scopedPath(wanted).path;
    if (isMemoryReviewPath(requestedPath))
      return call.finish({
        error: "Review artifacts are available only in human memory management.",
      });
    if (!requestedPath || requestedPath.endsWith("/")) {
      return call.finish(await listMemoryDirectory(ctx, wanted, args.offset));
    }
    const document = await findMemoryDocument(ctx, wanted);
    if (!document) {
      return call.finish({
        error: `No memory document at "${wanted}".`,
        hint: 'Use read_memory(path="") to list documents, or a directory path to browse.',
      });
    }
    // Redact before paging, so a secret crossing a page boundary cannot leak in two pieces.
    // Offsets refer to this redacted view, including any replacement-length changes.
    const characters = Array.from(redactSecrets(document.content, ctx.secrets));
    const totalChars = characters.length;
    const offset = clampOffset(args.offset, totalChars);
    const maxChars = Math.min(
      MEMORY_READ_MAX_CHARS,
      positiveInteger(args.max_chars) ?? MEMORY_READ_MAX_CHARS,
    );
    const page = (length: number) => {
      const nextOffset = offset + length;
      return {
        path: document.path,
        scope: document.scope,
        revision: document.revision,
        totalChars,
        offset,
        truncated: nextOffset < totalChars,
        ...(nextOffset < totalChars ? { nextOffset } : {}),
        content: characters.slice(offset, nextOffset).join(""),
      };
    };
    let low = 0;
    let high = Math.min(maxChars, totalChars - offset);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(JSON.stringify(page(mid)), "utf8") <= MEMORY_RESULT_MAX_BYTES)
        low = mid;
      else high = mid - 1;
    }
    const result = page(low);
    if (
      Buffer.byteLength(JSON.stringify(result), "utf8") > MEMORY_RESULT_MAX_BYTES ||
      (low === 0 && offset < totalChars)
    ) {
      return call.finish({ error: "Document metadata exceeds the read budget." });
    }
    if (ctx.source.memoryMaintenance) {
      ctx.source.memoryReadCoverage ??= new Map();
      const reads = ctx.source.memoryReadCoverage;
      const previous = reads.get(document.id);
      const ranges: Array<[number, number]> = [
        ...(previous?.revision === document.revision && previous.total === totalChars
          ? previous.ranges
          : []),
        [offset, offset + low],
      ];
      ranges.sort((a, b) => a[0] - b[0]);
      const merged: Array<[number, number]> = [];
      for (const range of ranges) {
        const last = merged.at(-1);
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else merged.push([...range]);
      }
      reads.set(document.id, { revision: document.revision, total: totalChars, ranges: merged });
    }
    return call.finish(result);
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
      .filter((hit) => !isMemoryReviewPath(hit.path))
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
    const requested = String(args.path ?? "").trim();
    const qualified = scopedPath(requested);
    if (qualified.scope === "user") {
      return call.finish({ error: "write_memory can only write bot memory." });
    }
    const path = qualified.path;
    if (isMemoryReviewPath(path))
      return call.finish({
        error: "Review paths are reserved for the maintenance proposal writer.",
      });
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
    const existing = await findMemoryDocument(ctx, `bot:${path}`);
    const expectedRevision = args.expected_revision ?? 0;
    if (
      !Number.isInteger(expectedRevision) ||
      Number(expectedRevision) < 0 ||
      (existing && args.expected_revision === undefined)
    ) {
      return call.finish({
        error:
          "Read the existing document and pass its expected_revision; use 0 only when creating.",
      });
    }
    if ((existing?.revision ?? 0) !== expectedRevision) {
      return call.finish({
        error: "That document changed since you read it. Read it again before rewriting.",
        revision: existing?.revision ?? 0,
      });
    }
    const saved = await deps.memory
      .commit(
        {
          scope: "bot",
          botId: bot.id,
          path: existing?.path ?? path,
          content,
          expectedRevision: Number(expectedRevision),
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
    const requested = scopedPath(String(args.path ?? ""));
    if (isMemoryReviewPath(requested.path))
      return call.finish({
        error: "Review paths are reserved for the maintenance proposal writer.",
      });
    if (requested.scope === "bot") {
      return call.finish({ error: "save_shared_memory can only write shared memory." });
    }
    const existing = await findMemoryDocument(ctx, `user:${requested.path}`);
    const path = existing?.path ?? requested.path;
    const expectedRevision = args.expected_revision ?? 0;
    if (
      !Number.isInteger(expectedRevision) ||
      Number(expectedRevision) < 0 ||
      (existing && args.expected_revision === undefined)
    ) {
      return call.finish({
        error: "Read the shared document and pass its expected_revision; use 0 only when creating.",
      });
    }
    if ((existing?.revision ?? 0) !== expectedRevision) {
      return call.finish({ error: MEMORY_REVISION_CONFLICT_ERROR });
    }
    try {
      const saved = await deps.memory.commit(
        {
          scope: "user",
          path,
          content: String(args.content ?? ""),
          expectedRevision: Number(expectedRevision),
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
  const { path, scope } = scopedPath(wanted);
  const botSnapshot =
    scope === "user"
      ? { documents: [] }
      : await deps.memory.read({ scope: "bot", botId: bot.id, path }, context);
  const botHit = botSnapshot.documents[0];
  if (botHit) return { ...botHit, scope: "bot" };
  const userSnapshot =
    scope === "bot" ? { documents: [] } : await deps.memory.read({ scope: "user", path }, context);
  const userHit = userSnapshot.documents[0];
  if (userHit) return { ...userHit, scope: "user" };
  // The caller is a model, so accept a different case or a leading "./" before giving up.
  const wantedKey = normalizeMemoryPath(path);
  const documents = await listMemoryDocuments(ctx);
  return (
    documents.find(
      (document) =>
        (!scope || document.scope === scope) && normalizeMemoryPath(document.path) === wantedKey,
    ) ?? null
  );
}

function scopedPath(wanted: string): { scope?: "bot" | "user"; path: string } {
  const match = /^(bot|user):(.*)$/i.exec(wanted.trim());
  return match
    ? { scope: match[1]!.toLowerCase() as "bot" | "user", path: match[2]!.trim() }
    : { path: wanted.trim() };
}

async function listMemoryDirectory(ctx: RunContext, wanted: string, rawOffset: unknown) {
  const { scope, path } = scopedPath(wanted);
  const prefix = normalizeMemoryPath(path);
  const documents = (await listMemoryDocuments(ctx))
    .filter(
      (document) =>
        !isMemoryReviewPath(document.path) &&
        (!scope || document.scope === scope) &&
        normalizeMemoryPath(document.path).startsWith(prefix),
    )
    .sort((a, b) => `${a.scope}:${a.path}`.localeCompare(`${b.scope}:${b.path}`));
  const offset = clampOffset(rawOffset, documents.length);
  const entries: Array<{ path: string; revision: number; chars: number }> = [];
  let nextOffset = offset;
  for (const document of documents.slice(offset, offset + 20)) {
    const entry = {
      path: `${document.scope}:${document.path}`,
      revision: document.revision,
      chars: charLength(document.content),
    };
    if (Buffer.byteLength(JSON.stringify({ entries: [...entries, entry] }), "utf8") > 9_000) break;
    entries.push(entry);
    nextOffset += 1;
  }
  if (!entries.length && offset < documents.length) {
    return { error: "A document path exceeds the directory response budget." };
  }
  return {
    kind: "directory",
    totalDocuments: documents.length,
    offset,
    entries,
    ...(nextOffset < documents.length ? { nextOffset } : {}),
  };
}

function clampOffset(value: unknown, total: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.floor(parsed), total);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : undefined;
}
