/** Device audio preferences: old global switches never opt in a bot implicitly. */
export type BotVoicePreferences = {
  wakeEnabled: boolean;
  notifyEnabled: boolean;
  aliases: string[];
};

const PREFIX = "rakazo:bot-voice:";
const watchers = new Set<() => void>();
let revision = 0;
let persisted: Record<string, unknown> | undefined;
let persist: ((patch: Record<string, BotVoicePreferences>) => Promise<unknown>) | undefined;

/** Reuse the local workbench's existing settings/preferences record and HTTP writer. */
export function hydrateBotVoicePreferences(
  preferences: Record<string, unknown>,
  save: (patch: Record<string, BotVoicePreferences>) => Promise<unknown>,
): void {
  persisted = { ...preferences };
  persist = save;
  changed();
}

function changed() {
  revision += 1;
  for (const watcher of [...watchers]) watcher();
}

export function readBotVoicePreferences(botId: string): BotVoicePreferences {
  try {
    const key = `${PREFIX}${botId}`;
    const value =
      persisted && Object.hasOwn(persisted, key)
        ? persisted[key]
        : JSON.parse(window.localStorage.getItem(key) ?? "{}");
    if (!value || typeof value !== "object") throw new Error("Invalid voice preferences");
    return {
      wakeEnabled: value.wakeEnabled === true,
      notifyEnabled: value.notifyEnabled === true,
      aliases: Array.isArray(value.aliases)
        ? value.aliases.filter((item: unknown): item is string => typeof item === "string")
        : [],
    };
  } catch {
    return { wakeEnabled: false, notifyEnabled: false, aliases: [] };
  }
}

export function writeBotVoicePreferences(
  botId: string,
  value: BotVoicePreferences,
): void | Promise<void> {
  const key = `${PREFIX}${botId}`;
  if (persist) {
    // Patch one existing key so saving one bot cannot replace another bot's settings.
    return persist({ [key]: value }).then(() => {
      persisted = { ...persisted, [key]: value };
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // The workbench has acknowledged the durable write; this cache is optional.
      }
      changed();
    });
  }
  window.localStorage.setItem(key, JSON.stringify(value));
  changed();
}

export function voicePreferencesRevision(): number {
  return revision;
}

export function subscribeVoiceAssistantPrefs(watcher: () => void): () => void {
  watchers.add(watcher);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(PREFIX)) changed();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    watchers.delete(watcher);
    window.removeEventListener("storage", onStorage);
  };
}
