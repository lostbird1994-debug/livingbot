/**
 * Chat backdrop, kept entirely on this device.
 *
 * The picture itself lives in IndexedDB (a Blob per target) because photos blow
 * past the localStorage quota; the three rendering knobs live in localStorage.
 * A "target" is either a bot id (that bot's private chat) or
 * {@link GLOBAL_BACKGROUND_TARGET}, which every chat without its own picture
 * falls back to. Nothing here talks to the server.
 */

/** Target key that holds the default picture for chats without their own. */
export const GLOBAL_BACKGROUND_TARGET = "global";

export const CHAT_BACKGROUND_SETTINGS_KEY = "rakazo.chatBackground.settings";

const DB_NAME = "rakazo.chatBackground";
const DB_VERSION = 1;
const IMAGE_STORE = "images";

/** Longest edge we keep for a backdrop; bigger only wastes decode time. */
const MAX_BACKDROP_EDGE = 1920;
const MAX_BACKDROP_QUALITY = 0.82;
/** Refuse absurd input before we spend time decoding it. */
const MAX_INPUT_BYTES = 32 * 1024 * 1024;

export type ChatBackgroundSettings = {
  /** How strongly the picture shows through the surface. */
  opacity: number;
  /** Backdrop blur in px, so busy photos cannot fight the transcript. */
  blur: number;
  /** Darkness of the scrim laid over the picture. */
  scrim: number;
};

export const CHAT_BACKGROUND_LIMITS = {
  opacity: { min: 0.15, max: 1, step: 0.05 },
  blur: { min: 0, max: 40, step: 1 },
  scrim: { min: 0, max: 0.85, step: 0.05 },
} as const;

export const DEFAULT_CHAT_BACKGROUND_SETTINGS: ChatBackgroundSettings = {
  opacity: 1,
  blur: 0,
  scrim: 0.15,
};

const listeners = new Set<() => void>();
/** Bumped on every change so hooks re-read IndexedDB and localStorage. */
let revision = 0;

function notify() {
  revision += 1;
  for (const listener of listeners) listener();
}

/** Subscribe to picture or knob changes, from either the settings panel or another tab. */
export function subscribeChatBackground(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getChatBackgroundRevision(): number {
  return revision;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function normalizeChatBackgroundSettings(
  raw: Partial<ChatBackgroundSettings> | null | undefined,
): ChatBackgroundSettings {
  const { opacity, blur, scrim } = CHAT_BACKGROUND_LIMITS;
  return {
    opacity: clamp(
      Number(raw?.opacity),
      opacity.min,
      opacity.max,
      DEFAULT_CHAT_BACKGROUND_SETTINGS.opacity,
    ),
    blur: clamp(Number(raw?.blur), blur.min, blur.max, DEFAULT_CHAT_BACKGROUND_SETTINGS.blur),
    scrim: clamp(Number(raw?.scrim), scrim.min, scrim.max, DEFAULT_CHAT_BACKGROUND_SETTINGS.scrim),
  };
}

function getLocalStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

let memorySettings: ChatBackgroundSettings | null = null;

/**
 * The snapshot hooks hand to `useSyncExternalStore`, so it must keep a stable
 * identity between changes; a freshly parsed object each call would loop.
 */
export function getChatBackgroundSettings(): ChatBackgroundSettings {
  if (memorySettings) return memorySettings;
  const storage = getLocalStorage();
  if (!storage) {
    memorySettings = DEFAULT_CHAT_BACKGROUND_SETTINGS;
    return memorySettings;
  }
  try {
    const stored = storage.getItem(CHAT_BACKGROUND_SETTINGS_KEY);
    memorySettings = stored
      ? normalizeChatBackgroundSettings(JSON.parse(stored) as Partial<ChatBackgroundSettings>)
      : DEFAULT_CHAT_BACKGROUND_SETTINGS;
  } catch {
    memorySettings = DEFAULT_CHAT_BACKGROUND_SETTINGS;
  }
  return memorySettings;
}

export function setChatBackgroundSettings(
  patch: Partial<ChatBackgroundSettings>,
): ChatBackgroundSettings {
  const next = normalizeChatBackgroundSettings({ ...getChatBackgroundSettings(), ...patch });
  memorySettings = next;
  const storage = getLocalStorage();
  if (storage) {
    try {
      storage.setItem(CHAT_BACKGROUND_SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // Quota or private mode: the in-memory value still applies for this session.
    }
  }
  notify();
  return next;
}

export function resetChatBackgroundSettings(): ChatBackgroundSettings {
  memorySettings = { ...DEFAULT_CHAT_BACKGROUND_SETTINGS };
  const storage = getLocalStorage();
  if (storage) {
    try {
      storage.removeItem(CHAT_BACKGROUND_SETTINGS_KEY);
    } catch {
      // Ignore: the default is already in memory.
    }
  }
  notify();
  return memorySettings;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IMAGE_STORE)) db.createObjectStore(IMAGE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | null> {
  return openDatabase().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const transaction = db.transaction(IMAGE_STORE, mode);
          const store = transaction.objectStore(IMAGE_STORE);
          const request = run(store);
          if (!request) {
            resolve(null);
            return;
          }
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          transaction.oncomplete = () => db.close();
          transaction.onabort = () => db.close();
        } catch {
          db.close();
          resolve(null);
        }
      }),
  );
}

/** Read the stored picture for one target, or null when it has none. */
export function readChatBackgroundImage(target: string): Promise<Blob | null> {
  return withStore<Blob | undefined>("readonly", (store) => store.get(target)).then(
    (value) => value ?? null,
  );
}

export async function saveChatBackgroundImage(target: string, blob: Blob): Promise<boolean> {
  const written = await withStore<IDBValidKey>("readwrite", (store) => store.put(blob, target));
  notify();
  return written !== null;
}

export async function removeChatBackgroundImage(target: string): Promise<void> {
  await withStore<undefined>("readwrite", (store) => store.delete(target));
  notify();
}

/** Targets that currently own a picture, useful for the settings panel's badges. */
export function listChatBackgroundTargets(): Promise<string[]> {
  return withStore<IDBValidKey[]>("readonly", (store) => store.getAllKeys()).then((keys) =>
    (keys ?? []).map(String),
  );
}

/**
 * Resolve which picture a chat should paint: its own first, then the global
 * default. Returns null when neither exists.
 */
export async function resolveChatBackgroundImage(
  botId: string | null,
): Promise<{ target: string; blob: Blob } | null> {
  if (botId) {
    const own = await readChatBackgroundImage(botId);
    if (own) return { target: botId, blob: own };
  }
  const shared = await readChatBackgroundImage(GLOBAL_BACKGROUND_TARGET);
  return shared ? { target: GLOBAL_BACKGROUND_TARGET, blob: shared } : null;
}

/**
 * Down-scale and re-encode a picked file so a phone photo does not sit in
 * IndexedDB at full size. Falls back to the original bytes when the browser
 * cannot decode it.
 */
export async function prepareChatBackgroundFile(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) {
    throw new Error("not-an-image");
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error("too-large");
  }
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const edge = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, MAX_BACKDROP_EDGE / edge);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const type of ["image/webp", "image/jpeg"] as const) {
      const encoded = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, type, MAX_BACKDROP_QUALITY),
      );
      if (encoded?.size) return encoded;
    }
    return file;
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}
