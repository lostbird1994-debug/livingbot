/** Durable native preferences; localStorage is only the current origin's paint cache. */
export const LOCAL_UI_KEYS = [
  "rakazo.uiAppearance", "rakazo.showToolActivity", "rakazo.responseStreaming",
  "rakazo.loadRemoteImages", "rakazo.composerEnterToSend", "rakazo.botsSidebarDensity", "rakazo.uiLocale", "rakazo.chatAvatar",
  "rakazo.showTurnTitles", "rakazo.turnTitleCount",
  "rakazo.appTextSize", "rakazo.chatWidth", "rakazo.linkOpenMode", "rakazo.fileOpenMode",
  "livingbot.conclusionFirst",
] as const;
type Key = typeof LOCAL_UI_KEYS[number];
let save: ((patch: Record<string, string>) => Promise<unknown>) | undefined;
let onError: ((error: unknown) => void) | undefined;
let applying = false;
let revision = 0;
const changed = new Map<string, number>();
const choices = new Map<Key, string>();
const unbound = new Set<Key>();
const pending = new Map<string, Promise<unknown>>();
export const uiPreferenceRevision = () => revision;

export function persistLocalUiPreference(key: Key, value: string): void {
  if (applying) return;
  changed.set(key, ++revision);
  choices.set(key, value);
  if (!save) { unbound.add(key); return; }
  unbound.delete(key);
  const writer = save;
  const next = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(() => writer({ [key]: value }));
  pending.set(key, next);
  void next.catch((error) => onError?.(error)).finally(() => {
    if (pending.get(key) === next) pending.delete(key);
  });
}

export async function flushLocalUiPreferences(): Promise<void> {
  await Promise.all([...pending.values()]);
}

export function hydrateLocalUiPreferences(
  preferences: Record<string, unknown>,
  writer: (patch: Record<string, string>) => Promise<unknown>,
  apply: (key: Key, value: string) => void,
  failed: (error: unknown) => void,
  readRevision = revision,
): void {
  save = writer;
  onError = failed;
  for (const key of LOCAL_UI_KEYS) {
    if (pending.has(key)) continue;
    if (unbound.has(key) || (changed.get(key) ?? 0) > readRevision) {
      const latest = choices.get(key);
      if (latest !== undefined) persistLocalUiPreference(key, latest);
      continue;
    }
    const value = preferences[key];
    if (typeof value === "string") {
      applying = true;
      try { apply(key, value); } finally { applying = false; }
    } else if (!Object.hasOwn(preferences, key)) {
      // Seed only an actual cached choice, never synthesize a default over saved state.
      try {
        const cached = localStorage.getItem(key);
        if (cached !== null) persistLocalUiPreference(key, cached);
      } catch { /* Cache unavailable; the database remains authoritative. */ }
    }
  }
}
