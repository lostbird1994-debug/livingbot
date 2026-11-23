import type { MessageBlock } from "@livingbot/contracts";
import { isToolActivityBlock } from "@livingbot/core";

/** Preserve WorkBuddy-style longest-body and last-body anchors outside folded execution. */
export type ActivitySegment =
  | { kind: "block"; block: MessageBlock }
  | { kind: "activity"; blocks: MessageBlock[] };

export function groupActivityBlocks(blocks: readonly MessageBlock[]): ActivitySegment[] {
  const texts = blocks.flatMap((block, index) => block.kind === "text" && !block.preview && block.text.trim()
    ? [{ index, size: block.text.trim().length }] : []);
  const largest = Math.max(0, ...texts.map((item) => item.size));
  const anchors = new Set(texts.filter((item) => item.size === largest || item === texts.at(-1)).map((item) => item.index));
  const segments: ActivitySegment[] = [];
  let run: MessageBlock[] = [];
  const flush = () => {
    const lastActivity = run.findLastIndex(isToolActivityBlock);
    if (lastActivity !== -1) {
      segments.push({ kind: "activity", blocks: run.slice(0, lastActivity + 1) });
    }
    for (const block of run.slice(lastActivity + 1)) segments.push({ kind: "block", block });
    run = [];
  };
  for (const [index, block] of blocks.entries()) {
    if ((block.kind === "text" && block.preview) || anchors.has(index)) { flush(); segments.push({ kind: "block", block }); continue; }
    if (isToolActivityBlock(block) || block.kind === "text" || block.kind === "progress") {
      run.push(block);
      continue;
    }
    flush();
    segments.push({ kind: "block", block });
  }
  flush();
  return segments;
}

/** Reasoning has its own inner disclosure; operations alone already provide a status line. */
export function needsTimeline(segment: ActivitySegment): boolean {
  return (
    segment.kind === "activity" &&
    (segment.blocks.length > 1 || segment.blocks[0]?.kind === "reasoning")
  );
}
