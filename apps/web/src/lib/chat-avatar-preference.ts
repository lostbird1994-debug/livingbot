import { persistLocalUiPreference } from "./local-ui-preferences";

const STORAGE_KEY = "rakazo.chatAvatar";

const listeners = new Set<() => void>();
let memoryChoice: boolean | null = null;

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** The chat's own avatar shows unless it was switched off in appearance settings. */
export function getChatAvatarVisible(): boolean {
  if (memoryChoice !== null) return memoryChoice;
  try {
    return getLocalStorage()?.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setChatAvatarVisible(visible: boolean): void {
  memoryChoice = visible;
  persistLocalUiPreference("rakazo.chatAvatar", visible ? "on" : "off");
  try {
    getLocalStorage()?.setItem(STORAGE_KEY, visible ? "on" : "off");
  } catch {
    // Quota or private mode: the in-memory choice still applies this session.
  }
  for (const listener of listeners) listener();
}

export function subscribeChatAvatar(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
