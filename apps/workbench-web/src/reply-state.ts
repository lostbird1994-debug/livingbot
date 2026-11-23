import type { Block, TaskStatus } from "../../../packages/workbench/src/contracts.ts";

export type ReplyActivity = TaskStatus | "background" | "unconfirmed";

/**
 * A reply document is only "in progress" while its own task can still act.
 * After an interrupt, stop or failure the process is history: it must not keep
 * claiming that the Bot is working, and it must not re-open on reload.
 */
export function processView(final: boolean, activity?: ReplyActivity): { open: boolean; label: string } {
  if (final) return { open: false, label: "执行过程" };
  switch (activity) {
    case "queued": case "running": case "waiting": return { open: true, label: "正在工作" };
    case "stopping": return { open: true, label: "正在停止" };
    case "interrupted": return { open: false, label: "执行已中断" };
    case "failed": return { open: false, label: "执行失败" };
    case "cancelled": return { open: false, label: "已停止" };
    case "completed": return { open: false, label: "结果未完整保存" };
    default: return { open: false, label: "结果未确认" };
  }
}

/** Only the last active reasoning stage opens itself; earlier ones stay folded. */
export function reasoningOpen(live: boolean, index: number, total: number): boolean {
  return live && index === total - 1;
}

/**
 * A reasoning stage ends when anything follows it, or when its turn is no longer
 * live. Completion drives the fold: finished stages close, the active one stays
 * open. The reader can still reopen a finished stage by hand.
 */
export function reasoningComplete(live: boolean, index: number, total: number): boolean {
  return !live || index < total - 1;
}

/**
 * A reply is live only while its own task can still act. A finished, failed,
 * stopped or interrupted task is history: nothing inside it may keep animating.
 */
export function replyLive(final: boolean, activity?: ReplyActivity): boolean {
  if (final) return false;
  return activity === "queued" || activity === "running" || activity === "waiting" || activity === "stopping";
}

/**
 * Inside a group only the last step is the active one. Earlier steps ended when
 * the next one started, so their thinking must close even mid-task.
 */
export function stepLive(live: boolean, index: number, total: number): boolean {
  return live && index === total - 1;
}

/** Reasoning and tool steps can fold into a group; narration cannot. */
export function foldableBlock(block: Block): boolean {
  return block.kind === "reasoning" || block.kind === "tool";
}

export type ProcessSegment =
  | { kind: "block"; block: Block }
  | { kind: "group"; id: string; blocks: Block[] };

/**
 * Consecutive foldable blocks form one group, and narration breaks it, so a
 * sentence written between two steps stays visible instead of disappearing into
 * the fold. A single foldable block stays inline: one step is not a group.
 */
export function computeSegments(blocks: Block[]): ProcessSegment[] {
  const segments: ProcessSegment[] = [];
  let run: Block[] = [];
  const flush = () => {
    if (run.length === 1) segments.push({ kind: "block", block: run[0]! });
    else if (run.length > 1) segments.push({ kind: "group", id: `${run[0]!.id}~${run[run.length - 1]!.id}`, blocks: [...run] });
    run = [];
  };
  for (const block of blocks) {
    if (foldableBlock(block)) { run.push(block); continue; }
    flush();
    segments.push({ kind: "block", block });
  }
  flush();
  return segments;
}

/** Rendering cost used by the fold budget: text size is the honest proxy. */
export function blockCost(block: Block): number {
  if (block.kind === "reasoning" || block.kind === "text") return block.text.length;
  if (block.kind === "tool") return block.title.length + (block.detail?.length ?? 0);
  return 0;
}

/**
 * How many trailing items to render. Mirrors the measured budget of the original
 * viewer: at most 15 items and about 24576 characters per batch, taken from the
 * end so the newest step is always present. An oversized last item is never
 * hidden; it renders alone.
 */
export function visibleStart(costs: number[], batch = 15, budget = 24_576): number {
  let count = 0;
  let chars = 0;
  let index = costs.length;
  while (index > 0) {
    const cost = Math.max(0, costs[index - 1] ?? 0);
    if (count >= batch || chars + cost > budget) break;
    chars += cost;
    count += 1;
    index -= 1;
  }
  return count === 0 && costs.length > 0 ? costs.length - 1 : index;
}

/** Groups fold themselves unless they are the live tail of the process. */
export function segmentOpen(segment: ProcessSegment, index: number, total: number, live: boolean): boolean {
  return live && index === total - 1 && (segment.kind === "group" || segment.block.kind === "reasoning" || segment.block.kind === "tool");
}

/**
 * Consecutive narration blocks belong to one thought. Rendering them separately
 * fragments a run into dozens of one-line paragraphs, so they are merged with a
 * single blank line, keeping the first block's identity for React.
 */
export function mergeNarration(blocks: Block[]): Block[] {
  const merged: Block[] = [];
  for (const block of blocks) {
    const last = merged.at(-1);
    if (block.kind === "text" && last?.kind === "text") {
      merged[merged.length - 1] = { ...last, text: `${last.text}\n\n${block.text}` };
      continue;
    }
    merged.push(block);
  }
  return merged;
}

/**
 * One line for a folded turn: how many tool calls and how many narration pieces
 * it holds, so a collapsed process still says what happened.
 */
export function processSummary(blocks: Block[]): string {
  const tools = blocks.filter((block) => block.kind === "tool" && block.name !== "dispatch_action").length;
  const narration = blocks.filter((block) => block.kind === "text").length;
  const parts = [tools > 0 ? `${tools} 项操作` : "", narration > 0 ? `${narration} 段说明` : ""].filter(Boolean);
  return parts.join(" · ");
}

/** Tool phases that deserve their own word; everything else falls back below. */
const phases: Record<string, string> = {};

export function phaseLabel(phase: string, live: boolean): string {
  return phases[phase] ?? (live ? "进行中" : "已结束");
}
