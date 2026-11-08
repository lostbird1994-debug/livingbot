import { spokenMemory } from "./echo.js";

/** Lower echo match while audio plays: most of what the mic hears is the speaker. */
const PLAYBACK_ECHO_RATIO = 0.4;

/**
 * How long an interim phrase must stand before it cuts playback.
 * The final transcript arrives later, after the reply has already finished.
 */
export const INTERIM_BARGE_IN_MS = 300;

/** Chinese counts by character; other languages count by spoken word. */
export function isCallBargeIn(text: string): boolean {
  if (spokenMemory.isEcho(text, PLAYBACK_ECHO_RATIO)) return false;
  const cleaned = cleanWords(text);
  const han = cleaned.match(/\p{Script=Han}/gu)?.length ?? 0;
  const words = cleaned.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return han + words >= 2;
}

/** An interim is revised word by word, so one stray word never cuts playback. */
export function isInterimCallBargeIn(text: string): boolean {
  return isCallBargeIn(text);
}

function cleanWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Counts down an interim phrase heard over a reply: one that stands for
 * INTERIM_BARGE_IN_MS calls `onBargeIn`, and anything that no longer qualifies resets it.
 */
export function createInterimBargeIn(onBargeIn: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    hear(text: string): void {
      if (!isInterimCallBargeIn(text)) {
        clear();
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        onBargeIn();
      }, INTERIM_BARGE_IN_MS);
    },
    clear,
  };
}
