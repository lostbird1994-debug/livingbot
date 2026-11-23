import type { Message } from "../../../packages/workbench/src/contracts.ts";

/**
 * Two messages can share a millisecond, so creation time alone is not an
 * order. The user's input always precedes the reply it produced, and the
 * remaining ties stay deterministic instead of depending on tab arrival.
 */
export function orderMessages(messages: Message[]): Message[] {
  return [...messages].sort((left, right) => left.createdAt - right.createdAt ||
    (left.role === "user" ? 0 : 1) - (right.role === "user" ? 0 : 1) ||
    left.id.localeCompare(right.id));
}
