/**
 * Chat backdrop, kept entirely on this device.
 *
 * The picture lives in IndexedDB (a Blob per bot) because photos blow past the
 * localStorage quota; the three rendering knobs live in localStorage keyed by
 * the same bot id, so tuning one chat never disturbs another. Nothing here
 * talks to the server.
 */

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

/** Subscribe to picture or knob changes, from the Bot panel or another tab. */
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

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Parsed settings for every bot, cached against the raw stored string so the
 * snapshot `useSyncExternalStore` reads keeps a stable identity between edits.
 */
let cache: { raw: string | null; value: Record<string, ChatBackgroundSettings> } | null = null;

function readAllSettings(): Record<string, ChatBackgroundSettings> {
  const storage = getLocalStorage();
  let raw: string | null = null;
  try {
    raw = storage?.getItem(CHAT_BACKGROUND_SETTINGS_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (cache && cache.raw === raw) return cache.value;

  const value: Record<string, ChatBackgroundSettings> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [key, entry] of Object.entries(parsed ?? {})) {
        if (entry && typeof entry === "object") {
          value[key] = normalizeChatBackgroundSettings(entry as Partial<ChatBackgroundSettings>);
        }
      }
    } catch {
      // Unreadable settings fall back to defaults rather than blocking the panel.
    }
  }
  cache = { raw, value };
  return value;
}

function writeAllSettings(next: Record<string, ChatBackgroundSettings>) {
  const raw = JSON.stringify(next);
  const storage = getLocalStorage();
  if (storage) {
    try {
      storage.setItem(CHAT_BACKGROUND_SETTINGS_KEY, raw);
    } catch {
      // Quota or private mode: the in-memory cache still drives this session.
    }
  }
  cache = { raw: storage ? raw : cache?.raw ?? null, value: next };
}

export function getChatBackgroundSettings(botId: string): ChatBackgroundSettings {
  return readAllSettings()[botId] ?? DEFAULT_CHAT_BACKGROUND_SETTINGS;
}

export function setChatBackgroundSettings(
  botId: string,
  patch: Partial<ChatBackgroundSettings>,
): ChatBackgroundSettings {
  const all = { ...readAllSettings() };
  const next = normalizeChatBackgroundSettings({
    ...(all[botId] ?? DEFAULT_CHAT_BACKGROUND_SETTINGS),
    ...patch,
  });
  all[botId] = next;
  writeAllSettings(all);
  notify();
  return next;
}

export function resetChatBackgroundSettings(botId: string): ChatBackgroundSettings {
  const all = { ...readAllSettings() };
  delete all[botId];
  writeAllSettings(all);
  notify();
  return DEFAULT_CHAT_BACKGROUND_SETTINGS;
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

/** Read one bot's stored picture, or null when it has none. */
export function readChatBackgroundImage(botId: string): Promise<Blob | null> {
  return withStore<Blob | undefined>("readonly", (store) => store.get(botId)).then(
    (value) => value ?? null,
  );
}

export async function saveChatBackgroundImage(botId: string, blob: Blob): Promise<boolean> {
  const written = await withStore<IDBValidKey>("readwrite", (store) => store.put(blob, botId));
  notify();
  return written !== null;
}

export async function removeChatBackgroundImage(botId: string): Promise<void> {
  await withStore<undefined>("readwrite", (store) => store.delete(botId));
  notify();
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
