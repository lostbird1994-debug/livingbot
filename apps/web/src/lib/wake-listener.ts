import { t } from "@lingui/core/macro";
import { DictationStream } from "./dictation-stream";
import { selectedSpaceId, withSpaceHeaders } from "./rpc";
import { matchWake, type WakeMatch, type WakeTarget } from "./wake-word";

/** Recognition stays connected only inside the explicitly entered voice mode. */
const TICK_MS = 100;
/** Used for endpoint timing only; never gates capture or name recognition. */
const WAKE_RMS = 0.012;
const ABANDON_SILENCE_MS = 3000;

export type WakeHit = WakeMatch<WakeTarget>;

export type WakeListenerOptions = {
  /** Called on the main thread with the name that was spoken. */
  onWake: (hit: WakeHit) => void;
  /** What the recogniser made of the last utterance: the only way to see a near miss. */
  onHeard?: (text: string) => void;
  /** A microphone that cannot open, or died mid-standby. */
  onError?: (message: string) => void;
  onReady?: () => void;
};

export class WakeListener {
  private options: WakeListenerOptions | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Uint8Array<ArrayBuffer> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tap: DictationStream | null = null;
  /** The recogniser's current reading of this utterance. */
  private heard = "";
  private voiceAt = 0;
  private running = false;
  /** Silenced while the bot itself is talking, so its own voice cannot wake it. */
  private paused = false;
  private targets: readonly WakeTarget[] = [];
  private finishing = false;
  private generation = 0;
  private lastTextAt = 0;
  private hadVoice = false;
  private turnAt = 0;

  get isRunning(): boolean {
    return this.running;
  }

  /** The roster is read per utterance: renaming a bot takes effect without re-arming. */
  setTargets(targets: readonly WakeTarget[]): void {
    this.targets = targets;
  }

  /** Playback is muted to the microphone, but a speaker at volume still leaks. */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.closeTap();
    } else if (this.running && !this.finishing) {
      this.openTap();
    }
  }

  async start(options: WakeListenerOptions, targets: readonly WakeTarget[]): Promise<boolean> {
    this.options = options;
    this.targets = targets;
    if (this.running) return true;
    const generation = ++this.generation;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      if (generation === this.generation)
        options.onError?.(error instanceof Error ? error.message : t`Microphone failed`);
      return false;
    }
    if (generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      return false;
    }
    const Ctor =
      typeof AudioContext === "function"
        ? AudioContext
        : (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      for (const track of stream.getTracks()) track.stop();
      options.onError?.(t`This browser cannot listen in the background.`);
      return false;
    }
    let context: AudioContext;
    try {
      context = new Ctor();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      if (context.state === "suspended") void context.resume();
      this.stream = stream;
      this.context = context;
      this.analyser = analyser;
      this.samples = new Uint8Array(analyser.fftSize);
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      options.onError?.(error instanceof Error ? error.message : t`Microphone failed`);
      return false;
    }
    // A headset pulled out ends the track without an error of its own.
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (this.running && generation === this.generation)
          this.stop(t`The microphone was disconnected.`);
      });
    }
    this.running = true;
    this.voiceAt = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // The user explicitly entered voice mode. Arm recognition before the name is
    // spoken instead of losing its first syllable behind a loudness threshold.
    this.openTap();
    return true;
  }

  stop(reason?: string): void {
    const wasRunning = this.running;
    this.running = false;
    this.generation += 1;
    this.closeTap();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.context) void this.context.close().catch(() => undefined);
    this.context = null;
    this.analyser = null;
    this.samples = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    this.stream = null;
    if (wasRunning && reason) this.options?.onError?.(reason);
  }

  private tick() {
    const analyser = this.analyser;
    const samples = this.samples;
    if (!analyser || !samples || this.paused) return;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const value = (sample - 128) / 128;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / samples.length);
    const now = Date.now();
    if (rms > WAKE_RMS && now - this.turnAt > 2000) {
      this.hadVoice = true;
      this.voiceAt = now;
    }
    if (!this.tap || this.finishing) return;
    const silent = now - this.voiceAt;
    // A recogniser needs a moment before its first word, and a lone name only becomes a whole
    // sentence when the stream is closed. Both ends are therefore given time, and the last word
    // on the utterance comes from the flush rather than from a partial.
    if (this.heard) {
      // Recognition progress also anchors the endpoint; room noise must not keep
      // a completed name open forever, or quiet speech close it mid-word.
      const textQuiet = now - this.lastTextAt;
      if (silent > ABANDON_SILENCE_MS && textQuiet > 350) this.finishTap();
    } else if (this.hadVoice && silent > ABANDON_SILENCE_MS) {
      // A lone name may only become text after the recognition stream is flushed.
      this.finishTap();
    }
  }

  private openTap() {
    const stream = this.stream;
    if (!stream || this.tap) return;
    const tap = new DictationStream();
    this.tap = tap;
    this.heard = "";
    this.hadVoice = false;
    this.turnAt = 0;
    this.lastTextAt = Date.now();
    void tap
      .start(
        stream,
        withSpaceHeaders({}, selectedSpaceId()),
        (text) => this.inspect(text),
        () => {
          if (this.tap === tap) this.stop("语音识别连接中断，请重新进入语音模式。");
        },
        (turn) => {
          if (this.tap !== tap || this.finishing || this.paused) return;
          this.turnAt = Date.now();
          if (turn.speechProbability >= 0.7) this.hadVoice = true;
          if (this.hadVoice) this.voiceAt = Date.now() - turn.silenceMs;
          if (turn.complete) this.finishTap();
        },
      )
      .then((started) => {
        if (!started && this.tap === tap)
          this.stop("语音识别连接失败，请检查语音提供方后重新进入语音模式。");
        else if (started && this.tap === tap) this.options?.onReady?.();
      })
      .catch(() => {
        if (this.tap === tap) this.stop("语音识别连接中断，请重新进入语音模式。");
      });
  }

  private inspect(text: string) {
    if (this.paused || !this.running || !this.tap) return;
    const line = text.trim();
    if (line && line !== this.heard) {
      this.heard = line;
      this.lastTextAt = Date.now();
      this.options?.onHeard?.(line);
    }
    // Wait for the utterance's final text, so "name + command" stays one turn
    // rather than dropping the command when the name appears in a partial.
  }

  /**
   * Closes the stream properly and judges what it finally heard.
   *
   * A lone "四月" is never a finished sentence while it is still being streamed, so the
   * partials alone would miss it; the flush is what turns the utterance into text.
   */
  private finishTap() {
    const tap = this.tap;
    if (!tap) return;
    this.finishing = true;
    const generation = this.generation;
    this.tap = null;
    const options = this.options;
    const partial = this.heard;
    this.heard = "";
    void tap
      .finish()
      .then((text) => {
        if (generation !== this.generation || !this.running || this.paused) return;
        const line = text.trim() || partial.trim();
        if (!line) {
          options?.onHeard?.("");
          return;
        }
        options?.onHeard?.(line);
        if (!this.running || this.paused) return;
        const hit = matchWake(line, this.targets);
        if (!hit) {
          return;
        }
        this.stop();
        options?.onWake(hit);
      })
      .catch(() => {
        if (generation === this.generation) this.stop("语音识别连接中断，请重新进入语音模式。");
      })
      .finally(() => {
        this.finishing = false;
        if (generation === this.generation && this.running && !this.paused) this.openTap();
      });
  }

  private closeTap() {
    const tap = this.tap;
    this.tap = null;
    if (this.heard) {
      this.heard = "";
      // Nothing matched: the caller gets the standby label back instead of a stale reading.
      this.options?.onHeard?.("");
    }
    tap?.abort();
  }
}
