import { useSyncExternalStore } from "react";

/**
 * Connectors a message can reach, chosen in the composer.
 *
 * Installed connectors no longer reach every bot: a run only discovers the ones
 * named here. The choice sticks to the session it was made in, and a session
 * without a choice of its own opens with whatever the last one left behind, so
 * a connector switched on stays on until it is switched off again.
 *
 * State lives in a module map rather than React context because the send path
 * (use-composer-actions) and the picker (composer) sit in different trees.
 */
const scopes = new Map<string, string[]>();
const listeners = new Set<() => void>();
const EMPTY: string[] = [];
const PREFIX = "rakazo.connectorScope.";
/** Selections saved before the choice outlived a send. */
const LEGACY_PREFIX = "rakazo.taskConnectorScope.";
const LAST = "rakazo.connectorScopeLast";

function emit() {
  for (const listener of listeners) listener();
}

function readIds(key: string): string[] | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (Array.isArray(saved) && saved.every((id) => typeof id === "string"))
      return saved as string[];
  } catch {
    /* Unreadable storage leaves the session on the last choice. */
  }
  return null;
}

function writeIds(key: string, ids: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    /* The choice still applies to this run when storage is unavailable. */
  }
}

export function scopeKeyForTarget(target: {
  botId?: string;
  groupId?: string;
  taskSessionId?: string;
  draftScope?: string;
}): string {
  if (target.taskSessionId || target.draftScope)
    return `task:${target.botId}:${target.taskSessionId ?? target.draftScope}`;
  if (target.groupId) return `group:${target.groupId}`;
  return `bot:${target.botId ?? ""}`;
}

export function readConnectorScope(key: string): string[] {
  const cached = scopes.get(key);
  if (cached) return cached;
  const saved = readIds(PREFIX + key) ?? readIds(LEGACY_PREFIX + key) ?? readIds(LAST) ?? EMPTY;
  scopes.set(key, saved);
  return saved;
}

export function writeConnectorScope(key: string, ids: string[]) {
  const next = [...ids];
  scopes.set(key, next);
  writeIds(PREFIX + key, next);
  writeIds(LAST, next);
  emit();
}

export function useConnectorScope(key: string): [string[], (ids: string[]) => void] {
  const ids = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => readConnectorScope(key),
    () => EMPTY,
  );
  return [ids, (next: string[]) => writeConnectorScope(key, next)];
}
