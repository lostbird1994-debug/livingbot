import { useSyncExternalStore } from "react";
import { persistLocalUiPreference } from "./local-ui-preferences";

const ENABLED_KEY = "rakazo.showTurnTitles";
const COUNT_KEY = "rakazo.turnTitleCount";
const listeners = new Set<() => void>();
let enabledChoice: boolean | undefined;
let countChoice: number | undefined;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function normalizeCount(value: number): number {
  return Number.isInteger(value) ? Math.max(5, Math.min(25, value)) : 25;
}

export function getTurnTitlesEnabled(): boolean {
  return enabledChoice ?? read(ENABLED_KEY) !== "off";
}

export function getTurnTitleCount(): number {
  const cached = read(COUNT_KEY);
  return countChoice ?? (cached === null ? 25 : normalizeCount(Number(cached)));
}

function save(key: typeof ENABLED_KEY | typeof COUNT_KEY, value: string): void {
  persistLocalUiPreference(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    /* The session choice still applies. */
  }
  for (const listener of listeners) listener();
}

export function setTurnTitlesEnabled(enabled: boolean): void {
  enabledChoice = enabled;
  save(ENABLED_KEY, enabled ? "on" : "off");
}

export function setTurnTitleCount(count: number): void {
  countChoice = normalizeCount(count);
  save(COUNT_KEY, String(countChoice));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTurnRailPreference() {
  const enabled = useSyncExternalStore(subscribe, getTurnTitlesEnabled, () => true);
  const count = useSyncExternalStore(subscribe, getTurnTitleCount, () => 25);
  return { enabled, count };
}
