import { speakable } from "@rakazo/core";
import { firstReplyParagraph } from "@rakazo/core/message-quote";
import { speaker } from "./tts";

/**
 * A message worth hearing, said out loud once.
 *
 * Not a call: nothing rings, nothing is answered, nothing lands in the transcript. One short
 * line, a soft chime first so it is not mistaken for someone in the room, then silence.
 */
const MIN_GAP_MS = 6_000;
const MAX_QUEUE = 3;
/** Long enough for the point, short enough to stay a notification. */
const MAX_CHARS = 90;
const CHIME_GAIN = 0.045;
const CHIME_MS = 110;

/** The bot's own name, then the first thing worth hearing from its message. */
export function announcementLine(botName: string, message: string): string {
  const text = speakable(firstReplyParagraph(message));
  if (!text) return "";
  const body = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1).trimEnd()}…` : text;
  return `收到${botName}发来的消息：${body}`;
}

/** A quiet two-note cue before the brief notification. */
function playChime(): Promise<void> {
  const Context =
    globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return Promise.resolve();
  let context: AudioContext;
  try {
    context = new Context();
  } catch {
    return Promise.resolve();
  }
  const now = context.currentTime + 0.02;
  const note = (hz: number, at: number) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = hz;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(CHIME_GAIN, at + 0.015);
    gain.gain.linearRampToValueAtTime(0, at + CHIME_MS / 1000);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + CHIME_MS / 1000 + 0.02);
  };
  note(880, now);
  note(1174, now + 0.13);
  return new Promise((resolve) => {
    setTimeout(() => {
      void context.close().catch(() => undefined);
      resolve();
    }, 320);
  });
}

type Queued = { line: string; botId?: string; allowed?: () => boolean };

export class Announcer {
  private queue: Queued[] = [];
  private speaking = false;
  private lastAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Set by whoever knows whether the app is already using the audio path. */
  private blocked: () => boolean = () => false;

  setBlockedCheck(blocked: () => boolean): void {
    this.blocked = blocked;
  }

  /** A call or a live announcement owns the speaker: a notice is dropped, never queued for later. */
  announce(line: string, botId?: string, allowed?: () => boolean): boolean {
    if (!line.trim() || this.blocked() || speaker.isSpeaking()) return false;
    if (this.queue.length >= MAX_QUEUE) {
      // Three unspoken notices have stopped being news; keep the newest and move on.
      this.queue = this.queue.slice(-(MAX_QUEUE - 1));
    }
    this.queue.push({ line, ...(botId ? { botId } : {}), allowed });
    void this.pump();
    return true;
  }

  /** A call started, or the user silenced announcements: nothing already queued may speak. */
  clear(): void {
    this.queue = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async pump(): Promise<void> {
    if (this.speaking || this.timer) return;
    const next = this.queue.shift();
    if (!next) return;
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - this.lastAt));
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (next) this.queue.unshift(next);
        void this.pump();
      }, wait);
      return;
    }
    if (next.allowed?.() === false) {
      void this.pump();
      return;
    }
    if (this.blocked() || speaker.isSpeaking()) return;
    this.speaking = true;
    try {
      await playChime();
      if (!this.blocked() && next.allowed?.() !== false)
        await speaker.speak(next.line, { ...(next.botId ? { botId: next.botId } : {}) });
    } catch {
      // A refused voice provider is reported by the speaker itself; the queue keeps moving.
    } finally {
      this.speaking = false;
      this.lastAt = Date.now();
      if (this.queue.length) void this.pump();
    }
  }
}

export const announcer = new Announcer();
