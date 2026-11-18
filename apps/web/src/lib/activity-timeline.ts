import type { MessageBlock } from "@livingbot/contracts";
import { isToolActivityBlock } from "@livingbot/core";

/** Prose before an operation belongs to its process; the trailing answer stays outside. */
export type ActivitySegment =
  | { kind: "block"; block: MessageBlock }
  | { kind: "activity"; blocks: MessageBlock[] };

export function groupActivityBlocks(blocks: readonly MessageBlock[]): ActivitySegment[] {
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
  for (const block of blocks) {
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
