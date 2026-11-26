import { desktopBridge } from "./desktop";
import { persistLocalUiPreference } from "./local-ui-preferences";

/** Where a link the page hands over goes, and what a delivered file does when it is opened. */
export type LinkOpenMode = "system" | "in-app";
export type FileOpenMode = "preview" | "system";

export const LINK_OPEN_MODE_STORAGE_KEY = "rakazo.linkOpenMode";
export const FILE_OPEN_MODE_STORAGE_KEY = "rakazo.fileOpenMode";

const listeners = new Set<() => void>();
let linkMode: LinkOpenMode | null = null;
let fileMode: FileOpenMode | null = null;

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function normalizeLinkOpenMode(raw: string | null | undefined): LinkOpenMode {
  return raw?.trim().toLowerCase() === "in-app" ? "in-app" : "system";
}

export function normalizeFileOpenMode(raw: string | null | undefined): FileOpenMode {
  return raw?.trim().toLowerCase() === "system" ? "system" : "preview";
}

export function getLinkOpenMode(): LinkOpenMode {
  if (linkMode) return linkMode;
  try {
    return normalizeLinkOpenMode(getLocalStorage()?.getItem(LINK_OPEN_MODE_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function getFileOpenMode(): FileOpenMode {
  if (fileMode) return fileMode;
  try {
    return normalizeFileOpenMode(getLocalStorage()?.getItem(FILE_OPEN_MODE_STORAGE_KEY));
  } catch {
    return "preview";
  }
}

/**
 * The shell opens links, and it acts on whichever window is current, so this only tells it
 * which one the person chose.
 */
export function applyLinkOpenMode(mode: LinkOpenMode): void {
  void desktopBridge()?.links?.setMode(mode);
}

export function setLinkOpenMode(mode: LinkOpenMode): LinkOpenMode {
  linkMode = normalizeLinkOpenMode(mode);
  persistLocalUiPreference("rakazo.linkOpenMode", linkMode);
  persistLocally(LINK_OPEN_MODE_STORAGE_KEY, linkMode);
  applyLinkOpenMode(linkMode);
  notify();
  return linkMode;
}

export function setFileOpenMode(mode: FileOpenMode): FileOpenMode {
  fileMode = normalizeFileOpenMode(mode);
  persistLocalUiPreference("rakazo.fileOpenMode", fileMode);
  persistLocally(FILE_OPEN_MODE_STORAGE_KEY, fileMode);
  notify();
  return fileMode;
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

export function subscribeOpeningPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
