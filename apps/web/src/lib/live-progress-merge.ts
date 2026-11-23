import type { ThreadMessage } from "@livingbot/contracts";

/**
 * A running turn has two records at once: the durable assistant message, which
 * already holds the tools and reasoning the service stored, and the ephemeral
 * `progress:` bubble that carries what is still streaming. Showing both gives
 * the person a finished card and an empty "working" card for one answer.
 *
 * Fold them into the live bubble, keeping the stored blocks first so the tools
 * stay visible while the turn runs. The final message replaces the live bubble
 * once the run ends, so this only shapes the in-flight view.
 */
export function mergeLiveProgress(messages: ThreadMessage[]): ThreadMessage[] {
  const live = new Map<string, ThreadMessage>();
  for (const message of messages) {
    if (isProgress(message) && message.runId) live.set(message.runId, message);
  }
  if (!live.size) return messages;
  // The stored row it replaces must be known before the walk: it can come first.
  const absorbed = new Set<string>();
  for (const message of messages) {
    if (!isProgress(message) || !message.runId) continue;
    const stored = storedFor(messages, message.runId);
    if (stored) absorbed.add(stored.id);
  }
  if (!absorbed.size) return messages;
  const result: ThreadMessage[] = [];
  for (const message of messages) {
    if (absorbed.has(message.id)) continue;
    if (!isProgress(message)) {
      result.push(message);
      continue;
    }
    const stored = message.runId ? storedFor(messages, message.runId) : undefined;
    if (!stored) {
      result.push(message);
      continue;
    }
    result.push({
      ...message,
      blocks: dedupeBlocks([...stored.blocks, ...message.blocks]),
    });
  }
  return result;
}

function isProgress(message: ThreadMessage): boolean {
  return message.id.startsWith("progress:");
}

function storedFor(messages: ThreadMessage[], runId: string): ThreadMessage | undefined {
  return messages.find((message) => message.id.startsWith("engine:") && message.runId === runId);
}

/** The live bubble can repeat a block the stored message already has. */
function dedupeBlocks(blocks: ThreadMessage["blocks"]): ThreadMessage["blocks"] {
  const seen = new Set<string>();
  return blocks.filter((block) => {
    // Presentation-only blocks such as chart specs carry no id to compare.
    const id = (block as { id?: unknown }).id;
    if (typeof id !== "string") return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
