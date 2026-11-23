import type { Block } from "./contracts.ts";

/** OpenClaw auto-reply protocol: only the exact whole reply is a control token. */
export function isSilentReply(text: string): boolean {
  return text.trim().toUpperCase() === "NO_REPLY";
}

export function hasReplyContent(blocks: Block[], silent = false): boolean {
  return blocks.some((block) => block.kind === "text"
    ? !silent && Boolean(block.text.trim()) && !isSilentReply(block.text)
    : block.kind !== "reasoning" && block.kind !== "tool");
}
