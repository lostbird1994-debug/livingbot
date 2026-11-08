import { createHmac, hkdfSync } from "node:crypto";
import type { DataKey } from "./content-crypto.js";

export const MEMORY_SEARCH_VERSION = 1;

export function normalizeMemorySearch(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

function memoryToken(key: Uint8Array, value: string): number {
  return createHmac("sha256", key).update(value).digest().readInt32BE(0);
}

function memorySearchKey(key: DataKey): Buffer {
  return Buffer.from(hkdfSync("sha256", key.key, Buffer.alloc(0), "rakazo/memory-search/v1", 32));
}

/**
 * Character and adjacent-character tokens preserve substring search, including CJK infixes,
 * one-character queries and English fragments. This domain never changes message indexes.
 * HMAC collisions and out-of-order n-grams are filtered against decrypted candidate text.
 */
export function memorySearchTokens(key: DataKey, text: string, query = false): number[] {
  const characters = Array.from(normalizeMemorySearch(text));
  const values = new Set<string>();
  if (!query || characters.length === 1)
    for (const character of characters) values.add(`char\0${character}`);
  for (let i = 0; i + 1 < characters.length; i += 1)
    values.add(`pair\0${characters[i]}${characters[i + 1]}`);
  const hmacKey = memorySearchKey(key);
  return [...new Set([...values].map((value) => memoryToken(hmacKey, value)))].sort(
    (a, b) => a - b,
  );
}
