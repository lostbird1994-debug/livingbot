/** Device audio preferences: old global switches never opt in a bot implicitly. */
export type BotVoicePreferences = {
  wakeEnabled: boolean;
  notifyEnabled: boolean;
  aliases: string[];
};

const PREFIX = "rakazo:bot-voice:";
const watchers = new Set<() => void>();
let revision = 0;

function changed() {
  revision += 1;
  for (const watcher of [...watchers]) watcher();
}

export function readBotVoicePreferences(botId: string): BotVoicePreferences {
  try {
    const value = JSON.parse(window.localStorage.getItem(`${PREFIX}${botId}`) ?? "{}");
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

export function writeBotVoicePreferences(botId: string, value: BotVoicePreferences): void {
  window.localStorage.setItem(`${PREFIX}${botId}`, JSON.stringify(value));
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
