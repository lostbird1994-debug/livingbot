/**
 * "Hey <bot>" detection on text a recogniser already produced.
 *
 * The wake word is whatever the bot is called, and users rename bots freely, so nothing here
 * knows a fixed phrase: the recogniser's own opening words are compared against the roster.
 * Matching is forgiving on purpose — a recogniser writes 小雨 as 小雨 but just as happily as
 * 小宇 — while a two-character name is only accepted at the very start of an utterance, which
 * is what a false wake would otherwise look like.
 */
export type WakeTarget = { id: string; name: string; aliases?: readonly string[] };

export function defaultWakeName(name: string): string {
  return name.split(/[|｜]/u)[0]?.trim() || name.trim();
}

export type WakeMatch<T extends WakeTarget> = {
  bot: T;
  /** What the caller said after the name: the first turn, already trimmed. */
  rest: string;
};

export type WakeMatchOptions = {
  /** Shortest bot name that may be woken by. One-character names match everything. */
  minNameLength?: number;
};

/** Whatever people say before a name; it is never part of the first turn. */
const WAKE_PREFIX =
  /^(?:嘿|嗨|喂|哎|那个|(?:hello|hi|hey|okay|ok)(?=[\s\p{P}\p{S}]|$))[\s\p{P}\p{S}]*/iu;
/** A short name is only accepted this close to the start of the utterance. */
/** Space, punctuation and symbols are neither said nor compared. */
const DROPPED = /[\s\p{P}\p{S}]/u;

/** Normalised text with a map back to the original, so the turn keeps its own spacing. */
export function normalizeWithMap(input: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (DROPPED.test(char)) continue;
    text += char.toLowerCase();
    map.push(index);
  }
  return { text, map };
}

/** True when `a` and `b` differ by at most one insertion, deletion or substitution. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;
  let index = 0;
  while (index < short.length && short[index] === long[index]) index += 1;
  if (long.length === short.length) {
    return short.slice(index + 1) === long.slice(index + 1);
  }
  return short.slice(index) === long.slice(index + 1);
}

type Candidate<T extends WakeTarget> = {
  bot: T;
  start: number;
  /** Index in the original transcript just past the spoken name. */
  end: number;
  distance: number;
  nameLength: number;
  /** Characters compared; the widest reading of a name is the one that was really said. */
  width: number;
};

/**
 * The bot whose name opens this utterance, if any. An earlier hit always wins: the caller
 * says the name first, so a later name in the same sentence is part of the request, not a wake.
 */
export function matchWake<T extends WakeTarget>(
  transcript: string,
  bots: readonly T[],
  options: WakeMatchOptions = {},
): WakeMatch<T> | null {
  const minNameLength = options.minNameLength ?? 2;
  const { text: normalized, map } = normalizeWithMap(transcript);
  const prefix = normalizeWithMap(transcript.trimStart().match(WAKE_PREFIX)?.[0] ?? "").text.length;
  const text = normalized.slice(prefix);
  if (!text) return null;
  let best: Candidate<T> | null = null;
  let ambiguous = false;
  for (const bot of bots) {
    for (const alias of new Set([bot.name, defaultWakeName(bot.name), ...(bot.aliases ?? [])])) {
      const name = normalizeWithMap(alias).text;
      if (name.length < minNameLength) continue;
      for (
        let width = Math.max(minNameLength, name.length - 1);
        width <= name.length + 1;
        width += 1
      ) {
        if (width <= text.length) {
          const window = text.slice(0, width);
          const distance = window === name ? 0 : withinOneEdit(window, name) ? 1 : 2;
          // One wrong character is forgiven, but only at the very start: that is where a wake
          // always is, and a recogniser writes 四月 as 思月 as readily as 四月.
          if (distance > 1) continue;
          const originalEnd = map[prefix + width - 1];
          if (
            /^[a-z]+$/u.test(name) &&
            originalEnd !== undefined &&
            /[a-z]/iu.test(transcript[originalEnd + 1] ?? "")
          )
            continue;
          const candidate: Candidate<T> = {
            bot,
            start: 0,
            end: prefix + width,
            distance,
            nameLength: name.length,
            width,
          };
          if (isBetter(candidate, best)) {
            best = candidate;
            ambiguous = false;
          } else if (
            best &&
            best.bot.id !== bot.id &&
            best.distance === distance &&
            best.width === width &&
            best.nameLength === name.length
          ) {
            ambiguous = true;
          }
        }
      }
    }
  }
  if (!best || ambiguous) return null;
  const after = transcript.slice(map[best.end] ?? transcript.length);
  return { bot: best.bot, rest: trimLeading(after) };
}

function isBetter<T extends WakeTarget>(next: Candidate<T>, best: Candidate<T> | null): boolean {
  if (!best) return true;
  if (next.start !== best.start) return next.start < best.start;
  if (next.distance !== best.distance) return next.distance < best.distance;
  if (next.width !== best.width) return next.width > best.width;
  return next.nameLength > best.nameLength;
}

/** Drops the filler before the name, then the punctuation left behind by cutting it out. */
function trimLeading(input: string): string {
  const withoutFiller = input.replace(WAKE_PREFIX, "");
  return withoutFiller.replace(/^[\s\p{P}\p{S}]+/u, "").trim();
}
