import type { MemoryDocument } from "./domain.js";
import { MEMORY_INDEX_PATH } from "./domain.js";

/** The heading seeded when a bot is created, before it has learned anything. */
export function initialBotMemory(name: string): string {
  return `# ${name}\n\n`;
}

export function isEmptyBotMemory(doc: Pick<MemoryDocument, "path" | "content">): boolean {
  if (!doc.content.trim()) return true;
  if (doc.path !== MEMORY_INDEX_PATH) return false;
  // Match the seed's complete shape, including its trailing blank line. The bot
  // may have been renamed since creation, so its current name is not a baseline.
  const heading = doc.content.split("\n")[0] ?? "";
  return heading.startsWith("# ") && doc.content === initialBotMemory(heading.slice(2));
}
/** Reserved proposal artifacts remain available to human memory management, not agent recall. */
export const MEMORY_REVIEW_DIRECTORY = "memory/reviews/";

export function isMemoryReviewPath(path: string): boolean {
  return path
    .trim()
    .normalize("NFKC")
    .replace(/^\.?\//, "")
    .toLowerCase()
    .startsWith(MEMORY_REVIEW_DIRECTORY);
}
