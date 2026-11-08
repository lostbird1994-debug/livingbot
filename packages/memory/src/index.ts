import type {
  AdapterContext,
  MemoryCommitRequest,
  MemoryExportRequest,
  MemoryReadRequest,
  MemoryRemoveRequest,
  MemoryRevision,
  MemorySearchRequest,
  MemorySearchResult,
  MemorySnapshot,
  MemoryStore,
  PortableFile,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  contentEncryptionOf,
  MEMORY_SEARCH_VERSION,
  normalizeMemorySearch,
  Prisma,
  withTransactionRetry,
} from "@rakazo/db";

export class MarkdownMemoryStore implements MemoryStore {
  constructor(private readonly prisma: PrismaClient) {}

  describe() {
    return {
      id: "markdown",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, revisions: true, markdownPortable: true },
    };
  }

  async read(request: MemoryReadRequest, context: AdapterContext): Promise<MemorySnapshot> {
    const documents = await this.prisma.memoryDocument.findMany({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        scope: request.scope,
        ...(request.botId ? { botId: request.botId } : {}),
        ...(request.path ? { path: request.path } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
    return {
      documents: documents.map((doc) => ({
        id: doc.id,
        path: doc.path,
        content: doc.content,
        revision: doc.revision,
        updatedAt: doc.updatedAt.toISOString(),
      })),
    };
  }

  async search(
    request: MemorySearchRequest,
    context: AdapterContext,
  ): Promise<MemorySearchResult[]> {
    const q = normalizeMemorySearch(request.query.trim());
    if (!q || Array.from(q).length > 500)
      throw new Error("Memory query must contain 1–500 characters");
    const encryption = contentEncryptionOf(this.prisma);
    let documents: Array<{ id: string; path: string; content: string }>;
    if (encryption) {
      const tokenSets = (await encryption.memorySearchTokens(context.spaceId, q)).filter(
        (tokens) => tokens.length,
      );
      const indexed = tokenSets.map((tokens) => Prisma.sql`m."searchTokens" @> ${tokens}::int[]`);
      const candidate = indexed.length
        ? Prisma.sql`(${Prisma.join(indexed, " OR ")})`
        : Prisma.sql`FALSE`;
      const visible = Prisma.sql`m."spaceId" = ${context.spaceId} AND m."userId" = ${context.userId}
        ${request.scope === "all" ? Prisma.empty : Prisma.sql`AND m.scope = ${request.scope}`}
        ${request.botId ? Prisma.sql`AND m."botId" = ${request.botId}` : Prisma.empty}`;
      const rows = await this.prisma.$queryRaw<
        Array<{
          id: string;
          spaceId: string;
          userId: string;
          path: string;
          content: string;
        }>
      >(Prisma.sql`
        SELECT m.id, m."spaceId", m."userId", m.path, m.content
        FROM memory_documents m
        WHERE ${visible} AND m.id IN (
          SELECT m.id FROM memory_documents m
          WHERE ${visible} AND m."searchTokensVersion" = ${MEMORY_SEARCH_VERSION} AND ${candidate}
          UNION
          SELECT m.id FROM memory_documents m
          WHERE ${visible} AND (m."searchTokensVersion" <> ${MEMORY_SEARCH_VERSION}
            OR position(${q} in lower(normalize(m.path, NFKC))) > 0)
        )
        ORDER BY m."updatedAt" DESC, m.path ASC, m.id ASC
      `);
      documents = await encryption.openRows("MemoryDocument", rows);
    } else {
      documents = await this.prisma.memoryDocument.findMany({
        where: {
          spaceId: context.spaceId,
          userId: context.userId,
          ...(request.scope === "all" ? {} : { scope: request.scope }),
          ...(request.botId ? { botId: request.botId } : {}),
        },
        orderBy: [{ updatedAt: "desc" }, { path: "asc" }, { id: "asc" }],
      });
    }
    return documents
      .map((doc) => {
        const content = normalizeMemorySearch(doc.content);
        const path = normalizeMemorySearch(doc.path);
        if (!content.includes(q) && !path.includes(q)) return null;
        return {
          path: doc.path,
          snippet: snippet(doc.content, q),
          score:
            (path === q ? 5 : path.includes(q) ? 3 : 0) +
            (content.includes(q) ? 1 + Math.min(1, q.length / Math.max(1, content.length)) : 0),
        };
      })
      .filter((hit): hit is MemorySearchResult => hit !== null)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  }

  async commit(request: MemoryCommitRequest, context: AdapterContext): Promise<MemoryRevision> {
    // A save replaces the current content and appends its history atomically.
    // Conflicts retry the whole transaction so revision numbers use fresh state.
    return withTransactionRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const existing = await tx.memoryDocument.findFirst({
            where: {
              spaceId: context.spaceId,
              userId: context.userId,
              scope: request.scope,
              botId: request.botId ?? null,
              path: request.path,
            },
          });
          if (request.expectedRevision !== undefined) {
            const live = existing?.revision ?? 0;
            if (live !== request.expectedRevision) throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
          }
          if (existing) {
            // Seed/import paths may predate revision recording. Preserve the preimage in the
            // same transaction before any overwrite; never replace a recorded revision.
            const preimage = await tx.memoryRevision.findUnique({
              where: {
                documentId_revision: { documentId: existing.id, revision: existing.revision },
              },
              select: { id: true },
            });
            if (!preimage)
              await tx.memoryRevision.create({
                data: {
                  documentId: existing.id,
                  revision: existing.revision,
                  content: existing.content,
                },
              });
          }
          const doc = existing
            ? await tx.memoryDocument.update({
                where: { id: existing.id },
                data: { content: request.content, revision: existing.revision + 1 },
              })
            : await tx.memoryDocument.create({
                data: {
                  spaceId: context.spaceId,
                  userId: context.userId,
                  botId: request.botId,
                  scope: request.scope,
                  path: request.path,
                  content: request.content,
                },
              });
          await tx.memoryRevision.create({
            data: {
              documentId: doc.id,
              revision: doc.revision,
              content: request.content,
              sourceRunId: request.sourceRunId,
              sourceThreadId: request.sourceThreadId,
            },
          });
          return { id: doc.id, path: doc.path, revision: doc.revision, content: doc.content };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async remove(
    request: MemoryRemoveRequest,
    context: AdapterContext,
  ): Promise<{ removed: boolean }> {
    // Revisions cascade with the document row.
    const { count } = await this.prisma.memoryDocument.deleteMany({
      where: {
        ...(request.id ? { id: request.id } : {}),
        spaceId: context.spaceId,
        userId: context.userId,
        scope: request.scope,
        botId: request.botId ?? null,
        path: request.path,
      },
    });
    return { removed: count > 0 };
  }

  async *exportMarkdown(
    request: MemoryExportRequest,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const snapshot = await this.read(
      { scope: request.scope === "all" ? "user" : request.scope, botId: request.botId },
      context,
    );
    for (const doc of snapshot.documents) {
      yield { path: doc.path, content: new TextEncoder().encode(doc.content) };
    }
  }

  async importMarkdown(
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<MemoryRevision> {
    let last: MemoryRevision | undefined;
    for await (const file of files) {
      last = await this.commit(
        {
          scope: "user",
          path: file.path,
          content: new TextDecoder().decode(file.content),
        },
        context,
      );
    }
    if (!last) throw new Error("No memory files to import");
    return last;
  }
}

function snippet(content: string, q: string): string {
  const idx = normalizeMemorySearch(content).indexOf(q);
  if (idx < 0) return Array.from(content).slice(0, 140).join("");
  // NFKC/case folding can expand a grapheme. Translate the normalized hit back to
  // original boundaries so excerpts preserve spelling and never split an emoji.
  let normalizedOffset = 0;
  let start: number | undefined;
  let end = content.length;
  for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(content)) {
    normalizedOffset += normalizeMemorySearch(part.segment).length;
    if (start === undefined && normalizedOffset > idx) start = part.index;
    if (normalizedOffset >= idx + q.length) {
      end = part.index + part.segment.length;
      break;
    }
  }
  start ??= 0;
  return (
    Array.from(content.slice(0, start)).slice(-40).join("") +
    content.slice(start, end) +
    Array.from(content.slice(end)).slice(0, 80).join("")
  );
}
