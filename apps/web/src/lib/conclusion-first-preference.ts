import { useSyncExternalStore } from "react";
import { persistLocalUiPreference } from "./local-ui-preferences";

const key = "livingbot.conclusionFirst";
const listeners = new Set<() => void>();
let enabled = true;

export function getConclusionFirstPreference() {
  return enabled;
}

export function setConclusionFirstPreference(value: boolean) {
  enabled = value;
  try {
    localStorage.setItem(key, value ? "on" : "off");
  } catch {
    // The persisted preference endpoint remains authoritative.
  }
  persistLocalUiPreference(key, value ? "on" : "off");
  for (const listener of listeners) listener();
}

export function hydrateConclusionFirstPreference(value: string) {
  enabled = value !== "off";
  for (const listener of listeners) listener();
}

export function useConclusionFirstPreference() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getConclusionFirstPreference,
    () => true,
  );
}
