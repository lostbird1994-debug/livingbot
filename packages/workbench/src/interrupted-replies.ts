import type { Block, Message } from "./contracts.ts";

const prose = (block: Block): block is Extract<Block, { kind: "text" | "reasoning" }> =>
  block.kind === "text" || block.kind === "reasoning";

/**
 * Subtract the already displayed prefix of this exact run, independently of
 * transient/native block IDs. This is a display offset, not content deduplication:
 * repeated wording after the offset is retained.
 */
function afterPrefix(blocks: Block[], prefix: Block[]): Block[] {
  const offsets = { text: 0, reasoning: 0 };
  for (const kind of ["text", "reasoning"] as const) {
    const before = prefix.filter(prose).filter((block) => block.kind === kind).map((block) => block.text).join("");
    const current = blocks.filter(prose).filter((block) => block.kind === kind).map((block) => block.text).join("");
    // A native checkpoint may temporarily contain less than the streamed prefix.
    // A genuine rewrite is shown in full rather than silently dropping its start.
    offsets[kind] = current.startsWith(before) ? before.length : before.startsWith(current) ? current.length : 0;
  }
  const shown = new Set(prefix.filter((block) => !prose(block)).map((block) => block.id));
  return blocks.flatMap((block): Block[] => {
    if (!prose(block)) return shown.has(block.id) ? [] : [block];
    const skipped = Math.min(offsets[block.kind], block.text.length);
    offsets[block.kind] -= skipped;
    return skipped < block.text.length ? [{ ...block, text: block.text.slice(skipped) }] : [];
  });
}

export function replyPartId(messageId: string, afterMessageId: string): string {
  return `reply-part:${encodeURIComponent(messageId)}:${encodeURIComponent(afterMessageId)}`;
}

export function replyPartOwner(id: string): string | undefined {
  const match = /^reply-part:([^:]+):[^:]+$/.exec(id);
  if (!match?.[1]) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
}

/** Reuse the existing transcript message shape on every client and after reopening. */
export function interruptedReplyParts(message: Message): Message[] {
  const cuts = message.interruptions;
  if (!cuts?.length || message.role !== "assistant") return [message];
  const { interruptions: _, ...base } = message;
  const parts: Message[] = [];
  for (let index = 0; index <= cuts.length; index++) {
    const previous = cuts[index - 1];
    const frozen = cuts[index];
    const blocks = frozen ? frozen.blocks.map((block) => {
      // Receipts are mutable even when the surrounding prose is frozen.
      if (prose(block)) return block;
      return message.blocks.find((current) => current.id === block.id) ?? block;
    }) : message.blocks;
    const remaining = previous ? afterPrefix(blocks, previous.blocks) : blocks;
    // An empty prefix is not a reply bubble. Keep the last part stable once it
    // starts; its identity is tied to the interruption, never a render counter.
    if (!remaining.length) continue;
    parts.push({
      ...base,
      id: previous ? replyPartId(message.id, previous.afterMessageId) : message.id,
      blocks: remaining,
      createdAt: previous ? previous.createdAt + 1 : message.createdAt,
      final: frozen ? true : message.final,
      ...(previous ? { clientNonce: undefined, turnTitle: undefined } : {}),
    });
  }
  return parts;
}
