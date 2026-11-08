/** Continuous mono PCM16 playback. Stopping invalidates both scheduled and in-flight audio. */
export class VoicePlayback {
  private context: AudioContext;
  private nextAt = 0;
  private stopped = false;
  private sources = new Set<AudioBufferSourceNode>();
  private segments: Array<{ id: number; text: string; start: number; end: number }> = [];

  constructor(
    private live: () => boolean,
    private onStart: (text: string) => void,
  ) {
    this.context = new AudioContext();
  }

  get heardText(): string {
    const at = this.context.currentTime;
    return this.segments
      .map((segment) => {
        const fraction = Math.max(
          0,
          Math.min(1, (at - segment.start) / (segment.end - segment.start)),
        );
        const chars = Array.from(segment.text);
        return chars.slice(0, Math.floor(chars.length * fraction)).join("");
      })
      .join("");
  }

  async push(bytes: Uint8Array, rate: number, id: number, text: string): Promise<void> {
    if (!Number.isInteger(rate) || rate < 8000 || rate > 96000 || bytes.length % 2)
      throw new Error("Invalid speech audio");
    while (this.nextAt - this.context.currentTime > 20 && this.live() && !this.stopped)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (!this.live() || this.stopped || !bytes.length) return;
    if (this.context.state === "suspended") await this.context.resume();
    if (!this.live() || this.stopped) return;
    const buffer = this.context.createBuffer(1, bytes.length / 2, rate);
    const channel = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < channel.length; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
    const at = Math.max(this.context.currentTime + (this.nextAt ? 0.015 : 0.5), this.nextAt);
    this.nextAt = at + buffer.duration;
    const existing = this.segments.find((segment) => segment.id === id);
    if (existing) existing.end = this.nextAt;
    else this.segments.push({ id, text, start: at, end: this.nextAt });
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
    };
    this.sources.add(source);
    source.start(at);
    if (!existing)
      setTimeout(
        () => {
          if (this.live() && !this.stopped) this.onStart(text);
        },
        Math.max(0, (at - this.context.currentTime) * 1000),
      );
  }

  async drain(): Promise<void> {
    while (this.context.currentTime < this.nextAt && this.live() && !this.stopped)
      await new Promise((resolve) => setTimeout(resolve, 50));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        /* Already ended. */
      }
    }
    this.sources.clear();
    void this.context.close().catch(() => undefined);
  }
}

/** An append-only text source; a wake-up never launches or retries an agent task. */
export function createSpeechFeed() {
  const queue: string[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  return {
    append(text: string) {
      if (!closed && text) {
        queue.push(text);
        wake?.();
      }
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (!closed || queue.length) {
        const text = queue.shift();
        if (text !== undefined) yield text;
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    },
  };
}

/** Hold open fences, quotes, brackets and unfinished sentences until they are stable. */
export function stableSpeechPrefix(text: string, final = false): string {
  if (final) return text;
  let fence = false;
  const stack: string[] = [];
  const pairs: Record<string, string> = {
    "“": "”",
    "‘": "’",
    "(": ")",
    "（": "）",
    "[": "]",
    "【": "】",
  };
  let end = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith("```", i) || text.startsWith("~~~", i)) {
      fence = !fence;
      i += 2;
      continue;
    }
    if (fence) continue;
    const char = text[i]!;
    if (char === '"' && text[i - 1] !== "\\") {
      if (stack.at(-1) === '"') stack.pop();
      else stack.push('"');
    } else if (pairs[char]) stack.push(pairs[char]!);
    else if (char === stack.at(-1)) stack.pop();
    if (
      stack.length === 0 &&
      (/[。！？]/u.test(char) || (/[.!?]/.test(char) && /\s/.test(text[i + 1] ?? "")))
    )
      end = i + 1;
  }
  return text.slice(0, end);
}
