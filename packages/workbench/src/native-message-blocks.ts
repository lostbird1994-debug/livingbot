import type { Block } from "./contracts.ts";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Native durable records are authoritative model-message boundaries, not run terminals. */
export function nativeMessageBlocks(record: Record<string, unknown>, sourceId: string): Block[] {
  const metadata = object(record.__openclaw);
  const native = { messageId: sourceId, ...(typeof metadata.seq === "number" ? { seq: metadata.seq } : {}) };
  const content = typeof record.content === "string" ? [{ type: "text", text: record.content }] : Array.isArray(record.content) ? record.content : [];
  return content.flatMap((item, index): Block[] => {
    const block = object(item);
    const id = `native:${sourceId}:${index}`;
    if (block.type === "thinking" || block.type === "reasoning") {
      const text = block.thinking ?? block.text;
      return typeof text === "string" && text ? [{ id, kind: "reasoning", text, native }] : [];
    }
    if (block.type === "text" && typeof block.text === "string" && block.text)
      return [{ id, kind: "text", text: block.text, native }];
    if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
      const args = object(block.arguments);
      return [{ id: `tool:${block.id}`, kind: "tool", name: block.name,
        title: typeof args.description === "string" ? args.description : block.name,
        phase: "start", native }];
    }
    return [];
  });
}

/** Merge by native identity and tool-call boundaries; never deduplicate prose by its wording. */
export function mergeNativeMessage(existing: Block[], incoming: Block[]): Block[] {
  if (!incoming.length) return existing;
  const ids = new Set(incoming.map((block) => block.id));
  const source = incoming[0].native!;
  const seen = existing.some((block) => block.native?.messageId === source.messageId);
  const newer = source.seq !== undefined && existing.some((block) => (block.native?.seq ?? -1) > source.seq!);
  let start = existing.findIndex((block) => ids.has(block.id));
  if (!seen && !newer) {
    if (start < 0) start = existing.length;
    while (start > 0) {
      const before = existing[start - 1];
      if (before.native || !["text", "reasoning"].includes(before.kind)) break;
      start--;
    }
  }
  const remove = new Set<string>();
  if (!seen && !newer) {
    let end = existing.findIndex((block, index) => index >= start && ids.has(block.id));
    if (end < 0) end = existing.length;
    for (let i = start; i < end; i++) {
      if (!existing[i].native && ["text", "reasoning"].includes(existing[i].kind)) remove.add(existing[i].id);
    }
  }
  const replacements = incoming.map((block) => {
    const previous = existing.find((candidate) => candidate.id === block.id);
    return block.kind === "tool" && previous?.kind === "tool" ? { ...block, ...previous, native: block.native } : block;
  });
  const kept = existing.filter((block) => !remove.has(block.id) && !ids.has(block.id));
  const canonical = [...kept.filter((block) => block.native), ...replacements];
  canonical.sort((a, b) => (a.native?.seq ?? 0) - (b.native?.seq ?? 0));
  return [...canonical, ...kept.filter((block) => !block.native)];
}
