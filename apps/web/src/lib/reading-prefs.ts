import { persistLocalUiPreference } from "./local-ui-preferences";
import { CHAT_WIDTH_MEASURE } from "./transcript-layout";

/** How large the interface reads, and how wide the conversation column runs. */
export type AppTextSize = "small" | "default" | "large" | "largest";
export type ChatWidth = "narrow" | "default" | "wide";

export const APP_TEXT_SIZE_STORAGE_KEY = "rakazo.appTextSize";
export const CHAT_WIDTH_STORAGE_KEY = "rakazo.chatWidth";

/** Page-style zoom, so text and the controls beside it grow together instead of wrapping. */
const TEXT_SIZE_ZOOM: Record<AppTextSize, string> = {
  small: "0.9",
  default: "1",
  large: "1.1",
  largest: "1.25",
};

/** The measure the transcript and composer share; the default keeps a line near 46 characters. */
const CHAT_MEASURE = CHAT_WIDTH_MEASURE;

const listeners = new Set<() => void>();
let textSize: AppTextSize | null = null;
let chatWidth: ChatWidth | null = null;

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function normalizeAppTextSize(raw: string | null | undefined): AppTextSize {
  const value = raw?.trim().toLowerCase();
  return value === "small" || value === "large" || value === "largest" ? value : "default";
}

export function normalizeChatWidth(raw: string | null | undefined): ChatWidth {
  const value = raw?.trim().toLowerCase();
  return value === "narrow" || value === "wide" ? value : "default";
}

export function getAppTextSize(): AppTextSize {
  if (textSize) return textSize;
  try {
    return normalizeAppTextSize(getLocalStorage()?.getItem(APP_TEXT_SIZE_STORAGE_KEY));
  } catch {
    return "default";
  }
}

export function getChatWidth(): ChatWidth {
  if (chatWidth) return chatWidth;
  try {
    return normalizeChatWidth(getLocalStorage()?.getItem(CHAT_WIDTH_STORAGE_KEY));
  } catch {
    return "default";
  }
}

/**
 * The zoom property lays the page out scaled, which is how a browser's own zoom reads: text and
 * the controls beside it grow together, and viewport units keep their meaning inside it.
 */
export function applyAppTextSize(size: AppTextSize): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("zoom", TEXT_SIZE_ZOOM[size]);
}

export function applyChatWidth(width: ChatWidth): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--rk-chat-measure", CHAT_MEASURE[width]);
}

export function setAppTextSize(size: AppTextSize): AppTextSize {
  textSize = normalizeAppTextSize(size);
  persistLocalUiPreference("rakazo.appTextSize", textSize);
  persistLocally(APP_TEXT_SIZE_STORAGE_KEY, textSize);
  applyAppTextSize(textSize);
  notify();
  return textSize;
}

export function setChatWidth(width: ChatWidth): ChatWidth {
  chatWidth = normalizeChatWidth(width);
  persistLocalUiPreference("rakazo.chatWidth", chatWidth);
  persistLocally(CHAT_WIDTH_STORAGE_KEY, chatWidth);
  applyChatWidth(chatWidth);
  notify();
  return chatWidth;
}

function persistLocally(key: string, value: string) {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // A blocked cache only costs the next paint, since the saved preference reloads it.
  }
}

function notify() {
  for (const listener of listeners) listener();
}

export function subscribeReadingPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
