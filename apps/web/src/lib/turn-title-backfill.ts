import type { ThreadMessage } from "@livingbot/contracts";
import { useEffect, useMemo, useRef } from "react";

/**
 * Turns one request asks about. A naming call is a short model call, so they go in small
 * batches: the next batch follows once the transcript comes back with these named.
 */
const TURNS_PER_REQUEST = 3;

/** Turns the margin shows that still carry no name of their own. */
export function missingTurnTitles(messages: readonly ThreadMessage[]): string[] {
  const missing: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" || message.turnTitle) continue;
    missing.push(message.id);
  }
  return missing;
}

/**
 * Fills in names for turns that predate the margin: a chat opened once asks for its visible
 * unnamed turns, a few at a time, and asks again only for turns it has not asked about yet.
 * `onNamed` refreshes the transcript so the names that came back can be shown.
 */
export function useTurnTitleBackfill(
  messages: readonly ThreadMessage[],
  request: (messageIds: string[]) => Promise<unknown>,
  onNamed?: () => void,
  enabled = true,
): void {
  const requestRef = useRef(request);
  const namedRef = useRef(onNamed);
  useEffect(() => {
    requestRef.current = request;
    namedRef.current = onNamed;
  }, [request, onNamed]);
  const asked = useRef(new Set<string>());
  const missing = useMemo(() => missingTurnTitles(messages), [messages]);
  useEffect(() => {
    if (!enabled) return;
    const ids = missing.filter((id) => !asked.current.has(id)).slice(0, TURNS_PER_REQUEST);
    if (!ids.length) return;
    for (const id of ids) asked.current.add(id);
    void requestRef.current(ids).then(
      () => {
        // The transcript changed (or the server said nothing was left to name): look again.
        namedRef.current?.();
      },
      () => {
        // A failed request may be retried the next time the transcript changes.
        for (const id of ids) asked.current.delete(id);
      },
    );
  }, [missing, enabled]);
}
