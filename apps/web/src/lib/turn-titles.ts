import type { ThreadMessage } from "@livingbot/contracts";

/** One turn in the chat's margin: the message that opened it and the name it shows. */
export type ChatTurn = { id: string; title: string };

/** Longest fallback title that still reads inside the margin column. */
const MAX_FALLBACK_CHARS = 24;

/**
 * A turn is a message the person sent plus everything until the next one. Only those open a
 * turn, so the margin never lists a routine's or a peer bot's output as something to navigate to.
 *
 * `preview` is the message's own opening words, used for turns the naming call has not reached
 * yet — a turn always has a name, so the margin never shows an empty row waiting on the model.
 */
export function chatTurns(
  messages: readonly ThreadMessage[],
  preview: (message: ThreadMessage) => string,
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const title = message.turnTitle ?? clampTitle(preview(message));
    if (!title) continue;
    turns.push({ id: message.id, title });
  }
  return turns;
}

function clampTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "";
  const characters = Array.from(line);
  return characters.length > MAX_FALLBACK_CHARS
    ? characters.slice(0, MAX_FALLBACK_CHARS).join("")
    : line;
}
