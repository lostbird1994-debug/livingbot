import { ORPCError } from "@orpc/server";
import type {
  Actor,
  ConversationFindFilters,
  ConversationFindItem,
  MessageBlock,
} from "@rakazo/contracts";
import {
  inferAttachmentMimeType,
  localDocumentReferences,
  plainTextFromMarkdown,
  snippetAroundMatch,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

const BATCH = 100,
  SCAN_BUDGET = 1000,
  PAGE = 30;
function matches(text: string, query: string) {
  const normalized = text.normalize("NFKC").toLowerCase();
  return query
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .split(/\s+/)
    .every((term) => normalized.includes(term));
}
function fileType(name: string, mime: string) {
  if (mime.startsWith("image/")) return "image";
  if (/\.(xlsx?|csv|tsv|ods)$/i.test(name)) return "spreadsheet";
  if (/\.(docx?|pdf|pptx?|txt|md|html?|rtf|odt)$/i.test(name)) return "document";
  return "other";
}
/** Keyset scans decrypted messages, so short Chinese terms and old encrypted history also match.
 * A bounded scan returns its continuation even when it found nothing; it never reports a false end. */
export async function findConversationHistory(
  prisma: PrismaClient,
  actor: Actor,
  threadId: string,
  input: ConversationFindFilters,
  signal?: AbortSignal,
) {
  if (input.from && input.to && input.from > input.to)
    throw new ORPCError("BAD_REQUEST", { message: "结束日期不能早于开始日期。" });
  const items: ConversationFindItem[] = [];
  let before = input.before;
  for (let scanned = 0; scanned < SCAN_BUDGET; ) {
    signal?.throwIfAborted();
    const rows = await prisma.message.findMany({
      where: {
        threadId,
        thread: { spaceId: actor.spaceId, userId: actor.userId },
        role: input.sender === "all" ? { in: ["user", "bot"] } : input.sender,
        ...(before === undefined ? {} : { seq: { lt: before } }),
        ...(!input.from && !input.to
          ? {}
          : {
              createdAt: {
                ...(input.from ? { gte: new Date(input.from) } : {}),
                ...(input.to ? { lte: new Date(input.to) } : {}),
              },
            }),
      },
      orderBy: { seq: "desc" },
      take: BATCH,
      select: { id: true, seq: true, role: true, botId: true, blocks: true, createdAt: true },
    });
    if (!rows.length) return { items, nextBefore: null };
    const botIds = [...new Set(rows.flatMap((row) => (row.botId ? [row.botId] : [])))];
    const bots = botIds.length
      ? await prisma.bot.findMany({
          where: { id: { in: botIds }, spaceId: actor.spaceId, userId: actor.userId },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(bots.map((bot) => [bot.id, bot.name]));
    for (const row of rows) {
      scanned++;
      before = row.seq;
      const role = row.role as "user" | "bot";
      const common = {
        messageId: row.id,
        seq: row.seq,
        role,
        senderName: role === "user" ? "我" : (names.get(row.botId ?? "") ?? "Bot"),
        createdAt: row.createdAt.toISOString(),
      };
      const blocks = row.blocks as MessageBlock[];
      if (input.mode === "messages") {
        const markdown = blocks
          .filter((b) => b.kind === "text")
          .map((b) => b.text)
          .join("\n");
        const text = plainTextFromMarkdown(markdown, { maxSource: markdown.length });
        if (text && matches(text, input.query))
          items.push({
            ...common,
            kind: "message",
            id: row.id,
            snippet: input.query.trim()
              ? snippetAroundMatch(text, input.query.trim())
              : text.slice(0, 240),
          });
      } else {
        const seen = new Set<string>();
        for (const [index, block] of blocks.entries()) {
          if (block.kind !== "file" && block.kind !== "image") continue;
          if (seen.has(block.artifactId)) continue;
          seen.add(block.artifactId);
          if (
            matches(block.name, input.query) &&
            (input.fileType === "all" || fileType(block.name, block.mimeType) === input.fileType)
          )
            items.push({
              ...common,
              id: `${row.id}:${index}`,
              kind: "file",
              artifactId: block.artifactId,
              name: block.name,
              mimeType: block.mimeType,
              ...(block.kind === "file" ? { size: block.size } : {}),
            });
        }
        // References and attachments are separate identities: never merge by filename.
        for (const block of blocks) {
          if (block.kind !== "text" || role !== "bot") continue;
          for (const ref of localDocumentReferences(block.text)) {
            if (seen.has(ref.path)) continue;
            seen.add(ref.path);
            const name = ref.path.split("/").at(-1)!;
            const mimeType = inferAttachmentMimeType(name) ?? "application/octet-stream";
            if (
              matches(name, input.query) &&
              (input.fileType === "all" || fileType(name, mimeType) === input.fileType)
            )
              items.push({
                ...common,
                id: `${row.id}:${ref.path}`,
                kind: "file",
                path: ref.path,
                name,
                mimeType,
              });
          }
        }
      }
      if (items.length >= PAGE) return { items, nextBefore: before };
    }
    if (rows.length < BATCH) return { items, nextBefore: null };
  }
  return { items, nextBefore: before ?? null };
}
