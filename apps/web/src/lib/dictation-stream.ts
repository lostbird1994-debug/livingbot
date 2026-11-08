/**
 * Streaming dictation tap: while the recorder runs, this also pushes 16 kHz PCM to the API,
 * which forwards it to the self-hosted speech server's realtime recogniser. Interim text lands
 * in the composer as the user speaks, so stopping the recording barely has anything left to do.
 *
 * Failure is never fatal: if the stream cannot start or dies, the caller keeps using the
 * existing whole-recording transcription path.
 */
const TARGET_RATE = 16_000;
const CHUNK_MS = 120;
const FEED_TIMEOUT_MS = 8_000;
const FLUSH_TIMEOUT_MS = 6_000;
const MAX_QUEUED = TARGET_RATE * 8;

function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j] ?? 0;
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function toPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let text = "";
  const step = 0x1000;
  for (let i = 0; i < bytes.length; i += step) {
    text += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(text);
}

type AudioContextCtor = new () => AudioContext;
export type VoiceTurn = {
  available: boolean;
  complete: boolean;
  speechProbability: number;
  silenceMs: number;
};

function contextCtor(): AudioContextCtor | undefined {
  if (typeof AudioContext === "function") return AudioContext;
  if (typeof window === "undefined") return undefined;
  const host = window as Window & { webkitAudioContext?: AudioContextCtor };
  return host.webkitAudioContext;
}

export class DictationStream {
  private id: string | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private headers = new Headers({ "content-type": "application/json" });
  private onText: ((text: string) => void) | null = null;
  private onFailure: (() => void) | null = null;
  private onTurn: ((turn: VoiceTurn) => void) | null = null;
  private pending: Float32Array[] = [];
  private pendingSamples = 0;
  private committed = "";
  private inFlight: Promise<void> | null = null;
  private failed = false;
  private startAbort: AbortController | null = null;

  async start(
    stream: MediaStream,
    headers: Headers,
    onText: (text: string) => void,
    onFailure?: () => void,
    onTurn?: (turn: VoiceTurn) => void,
  ): Promise<boolean> {
    const Ctor = contextCtor();
    if (!Ctor || typeof Ctor.prototype.createScriptProcessor !== "function") return false;
    const controller = new AbortController();
    this.startAbort = controller;
    this.headers = new Headers(headers);
    this.headers.set("content-type", "application/json");
    this.onText = onText;
    this.onFailure = onFailure ?? null;
    this.onTurn = onTurn ?? null;
    // Capture before the network handshake, so a short name cannot disappear while
    // the recognition session opens. The bounded queue is sent when the id arrives.
    try {
      const context = new Ctor();
      this.context = context;
      const source = context.createMediaStreamSource(stream);
      const node = context.createScriptProcessor(2048, 1, 1);
      const sink = context.createGain();
      sink.gain.value = 0;
      node.onaudioprocess = (event) =>
        this.take(event.inputBuffer.getChannelData(0), context.sampleRate);
      source.connect(node);
      node.connect(sink);
      sink.connect(context.destination);
      this.source = source;
      this.node = node;
      this.sink = sink;
      if (context.state === "suspended") await context.resume();
    } catch {
      this.abort();
      return false;
    }
    try {
      const res = await fetch("/api/voice/stream/start", {
        method: "POST",
        headers: this.headers,
        credentials: "include",
        body: "{}",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(FEED_TIMEOUT_MS)]),
      });
      if (!res.ok) {
        this.abort();
        return false;
      }
      const data = (await res.json()) as { id?: string };
      if (!data.id) {
        this.abort();
        return false;
      }
      this.id = data.id;
      if (controller.signal.aborted) {
        this.abort();
        return false;
      }
    } catch {
      this.abort();
      return false;
    }

    if (this.failed) {
      this.abort();
      return false;
    }
    void this.pump();
    return true;
  }

  private take(channel: Float32Array, rate: number) {
    if (this.failed) return;
    const down = downsample(channel, rate, TARGET_RATE);
    this.pending.push(down);
    this.pendingSamples += down.length;
    if (this.pendingSamples > MAX_QUEUED) {
      this.fail();
      return;
    }
    if (this.pendingSamples < (TARGET_RATE * CHUNK_MS) / 1000) return;
    this.pump();
  }

  private build(): string | null {
    if (!this.pending.length) return null;
    const joined = new Float32Array(this.pendingSamples);
    let offset = 0;
    for (const piece of this.pending) {
      joined.set(piece, offset);
      offset += piece.length;
    }
    this.pending = [];
    this.pendingSamples = 0;
    return toBase64(toPcm16(joined));
  }

  /** Sends one chunk. Chunks are serialised so they reach the recogniser in order. */
  private pump(immediate = false): Promise<void> {
    const id = this.id;
    if (!id) return Promise.resolve();
    if (this.inFlight && !immediate) return this.inFlight;
    const run = async () => {
      const pcm = this.build();
      if (!pcm || !this.id || this.failed) return;
      try {
        const res = await fetch("/api/voice/stream/feed", {
          method: "POST",
          headers: this.headers,
          credentials: "include",
          body: JSON.stringify({ id, pcm }),
          signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        });
        if (!res.ok) {
          this.fail();
          return;
        }
        const data = (await res.json()) as {
          partial?: string;
          finals?: string[];
          error?: string | null;
          turn?: VoiceTurn | null;
        };
        if (data.error) {
          this.fail();
          return;
        }
        if (data.finals?.length) this.committed += data.finals.join("");
        const text = `${this.committed}${data.partial ?? ""}`;
        if (text) this.onText?.(text);
        if (data.turn?.available && !this.failed) this.onTurn?.(data.turn);
      } catch {
        this.fail();
      }
    };
    // Clearing the slot in `finally` is what keeps chunks flowing: leaving a settled promise
    // in `inFlight` would make every later pump think a send is still running.
    let next: Promise<void>;
    next = (this.inFlight ?? Promise.resolve()).then(run, run).finally(() => {
      if (this.inFlight === next) this.inFlight = null;
    });
    this.inFlight = next;
    return next;
  }

  /** Ends the session and returns the final transcript, or "" when streaming never worked. */
  async finish(): Promise<string> {
    const id = this.id;
    if (!id || this.failed) {
      this.abort();
      return "";
    }
    await this.pump(true);
    if (this.failed) {
      this.abort();
      return "";
    }
    this.id = null;
    this.teardown();
    try {
      const res = await fetch("/api/voice/stream/flush", {
        method: "POST",
        headers: this.headers,
        credentials: "include",
        body: JSON.stringify({ id }),
        signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
      });
      if (!res.ok) return "";
      const data = (await res.json()) as { text?: string };
      return String(data.text ?? "").trim();
    } catch {
      return "";
    }
  }

  abort() {
    this.startAbort?.abort();
    this.startAbort = null;
    const id = this.id;
    this.id = null;
    this.teardown();
    if (!id) return;
    void fetch("/api/voice/stream/abort", {
      method: "POST",
      headers: this.headers,
      credentials: "include",
      body: JSON.stringify({ id }),
      keepalive: true,
    }).catch(() => undefined);
  }

  private fail() {
    if (this.failed) return;
    this.failed = true;
    this.onFailure?.();
  }

  private teardown() {
    this.failed = false;
    this.pending = [];
    this.pendingSamples = 0;
    this.committed = "";
    this.onText = null;
    const node = this.node;
    this.node = null;
    if (node) node.onaudioprocess = null;
    try {
      this.source?.disconnect();
    } catch {}
    try {
      node?.disconnect();
    } catch {}
    try {
      this.sink?.disconnect();
    } catch {}
    this.source = null;
    this.sink = null;
    const context = this.context;
    this.context = null;
    if (context) void context.close().catch(() => undefined);
  }
}
