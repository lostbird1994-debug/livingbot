import { useSyncExternalStore } from "react";

/**
 * Connectors a message can reach, chosen in the composer.
 *
 * Installed connectors no longer reach every bot: a run only discovers the ones
 * named here. The choice belongs to one message, so the composer clears it once
 * the send is accepted — the next message starts with nothing attached.
 *
 * State lives in a module map rather than React context because the send path
 * (use-composer-actions) and the picker (composer) sit in different trees.
 */
const scopes = new Map<string, string[]>();
const listeners = new Set<() => void>();
const EMPTY: string[] = [];

function emit() {
  for (const listener of listeners) listener();
}

export function scopeKeyForTarget(target: { botId?: string; groupId?: string; taskSessionId?: string; draftScope?: string }): string {
  if (target.taskSessionId || target.draftScope) return `task:${target.botId}:${target.taskSessionId ?? target.draftScope}`;
  if (target.groupId) return `group:${target.groupId}`;
  return `bot:${target.botId ?? ""}`;
}

export function readConnectorScope(key: string): string[] {
  if (!scopes.has(key) && key.startsWith("task:")) {
    try { const saved = JSON.parse(localStorage.getItem(`rakazo.taskConnectorScope.${key}`) ?? "[]");
      if (Array.isArray(saved) && saved.every(id => typeof id === "string")) scopes.set(key, saved);
    } catch { /* Selection remains empty when storage is unavailable. */ }
  }
  return scopes.get(key) ?? EMPTY;
}

export function writeConnectorScope(key: string, ids: string[]) {
  if (ids.length === 0) scopes.delete(key);
  else scopes.set(key, [...ids]);
  if (key.startsWith("task:")) try { localStorage.setItem(`rakazo.taskConnectorScope.${key}`, JSON.stringify(ids)); } catch {}
  emit();
}

export function clearConnectorScope(key: string) {
  if (!scopes.has(key)) return;
  scopes.delete(key);
  if (key.startsWith("task:")) try { localStorage.setItem(`rakazo.taskConnectorScope.${key}`, "[]"); } catch {}
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
