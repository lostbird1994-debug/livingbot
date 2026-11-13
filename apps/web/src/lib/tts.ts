import { t } from "@lingui/core/macro";
import type { SettingsScope } from "@livingbot/contracts";
import {
  readVoiceAudio,
  readVoiceError,
  requestDeadline,
  VOICE_RESPONSE_TIMEOUT_MS,
  withAbort,
} from "@livingbot/core";
import { rpc, selectedSpaceId, withSpaceHeaders } from "./rpc.js";
import { errorText, voiceAccountErrorText } from "./user-error.js";
import { VoicePlayback } from "./voice-playback.js";

export type SpeechStatus = "idle" | "preparing" | "speaking";

export interface SpeechSnapshot {
  status: SpeechStatus;
  botId?: string;
  messageId?: string;
  caption?: string;
  error?: string;
}

interface SpeakOptions {
  spaceId?: string | null;
  /** Which copy of the voice settings to use; omitted means whichever applies in the space. */
  scope?: SettingsScope;
  voiceId?: string;
  botId?: string;
  messageId?: string;
}

const IDLE: SpeechSnapshot = { status: "idle" };

export class Speaker {
  private snapshot: SpeechSnapshot = IDLE;
  private watchers = new Set<(s: SpeechSnapshot) => void>();
  private token = 0;
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private settlePlayback: ((finished: boolean) => void) | null = null;
  private request: AbortController | null = null;
  private playback: VoicePlayback | null = null;
  private lastHeard = "";

  get heardText(): string {
    return this.playback?.heardText ?? this.lastHeard;
  }

  subscribe(fn: (s: SpeechSnapshot) => void): () => void {
    this.watchers.add(fn);
    fn(this.snapshot);
    return () => {
      this.watchers.delete(fn);
    };
  }

  get state(): SpeechSnapshot {
    return this.snapshot;
  }

  private set(next: SpeechSnapshot) {
    this.snapshot = next;
    for (const watcher of [...this.watchers]) watcher(next);
  }

  isSpeaking(messageId?: string): boolean {
    if (this.snapshot.status === "idle") return false;
    return messageId ? this.snapshot.messageId === messageId : true;
  }

  stop() {
    if (this.playback) this.lastHeard = this.playback.heardText;
    this.playback?.stop();
    this.playback = null;
    this.token += 1;
    this.request?.abort();
    this.request = null;
    if (this.settlePlayback) this.settlePlayback(false);
    else this.teardownAudio();
    if (this.snapshot.status !== "idle" || this.snapshot.error) this.set(IDLE);
  }

  /** Synthesizes stable text as it arrives, without waiting for the whole model reply. */
  async speakStream(
    texts: AsyncIterable<string>,
    opts: SpeakOptions = {},
  ): Promise<string | undefined> {
    this.stop();
    this.lastHeard = "";
    const mine = this.token;
    const controller = new AbortController();
    this.request = controller;
    const live = () => this.token === mine && !controller.signal.aborted;
    const spaceId = opts.spaceId ?? selectedSpaceId();
    let playback: VoicePlayback | null = null;
    let id = 0;
    const iterator = texts[Symbol.asyncIterator]();
    this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId });
    try {
      if (typeof AudioContext === "function") {
        playback = new VoicePlayback(live, (caption) => {
          this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId, caption });
        });
        this.playback = playback;
      }
      while (live()) {
        const entry = await withAbort(iterator.next(), controller.signal);
        if (entry.done) break;
        const text = entry.value;
        if (!live()) break;
        const utterances = await withAbort(
          this.prepare(text, opts, controller.signal, spaceId),
          controller.signal,
        );
        for (const utterance of utterances) {
          if (!live()) break;
          if (
            playback &&
            (await this.renderStream(utterance, ++id, playback, opts, controller.signal, spaceId))
          )
            continue;
          const blob = await this.render(utterance, opts, controller.signal, spaceId);
          if (!live()) break;
          if (playback) {
            // Other providers return complete clips; keep them on the same timeline.
            const bytes = await blob.arrayBuffer();
            const decode = new AudioContext();
            try {
              const audio = await decode.decodeAudioData(bytes);
              const samples = audio.getChannelData(0);
              const pcm = new Uint8Array(samples.length * 2);
              const view = new DataView(pcm.buffer);
              samples.forEach((sample, index) => {
                view.setInt16(index * 2, Math.max(-1, Math.min(1, sample)) * 32767, true);
              });
              await playback.push(pcm, audio.sampleRate, id, utterance);
            } finally {
              await decode.close();
            }
          } else {
            this.set({
              status: "speaking",
              botId: opts.botId,
              messageId: opts.messageId,
              caption: utterance,
            });
            if (!(await this.play(blob, live))) break;
            this.lastHeard += utterance;
          }
        }
      }
      await playback?.drain();
      if (playback) this.lastHeard = playback.heardText;
    } catch (error) {
      if (live()) {
        const failure = errorText(error);
        this.set({ ...IDLE, error: failure });
        return failure;
      }
    } finally {
      // An interrupted producer may still be awaiting more text. Never block cancellation on it.
      void iterator.return?.().catch(() => undefined);
      if (this.playback === playback) this.playback = null;
      playback?.stop();
      if (this.request === controller) this.request = null;
      if (live() && !this.snapshot.error) this.set(IDLE);
    }
  }

  private async renderStream(
    text: string,
    id: number,
    playback: VoicePlayback,
    opts: SpeakOptions,
    signal: AbortSignal,
    spaceId: string | null,
  ): Promise<boolean> {
    const response = await fetch("/api/voice/speak-stream", {
      method: "POST",
      credentials: "include",
      headers: withSpaceHeaders({ "content-type": "application/json" }, spaceId),
      body: JSON.stringify({ text, botId: opts.botId, voiceId: opts.voiceId, scope: opts.scope }),
      signal,
    });
    if (response.status === 409) {
      await response.body?.cancel();
      return false;
    }
    if (!response.ok || !response.body) throw new Error("语音连接失败，请查看文字回复。");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let received = false;
    try {
      while (!signal.aborted) {
        const part = await reader.read();
        pending += decoder.decode(part.value, { stream: !part.done });
        if (pending.length > 1024 * 1024) throw new Error("Invalid audio stream");
        while (pending.includes("\n")) {
          const end = pending.indexOf("\n");
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (!line) continue;
          const chunk = JSON.parse(line) as { pcm: string; sampleRate: number };
          const raw = atob(chunk.pcm);
          await playback.push(
            Uint8Array.from(raw, (char) => char.charCodeAt(0)),
            chunk.sampleRate,
            id,
            text,
          );
          received = true;
        }
        if (part.done) {
          if (pending.trim()) throw new Error("Incomplete audio stream");
          break;
        }
      }
      if (!received) throw new Error("没有收到语音，请查看文字回复。");
      return true;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private teardownAudio() {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  /** Resolves with this request's failure text; stopping or superseding it resolves with none. */
  async speak(text: string, opts: SpeakOptions = {}): Promise<string | undefined> {
    this.stop();
    const mine = this.token;
    const controller = new AbortController();
    this.request = controller;
    const live = () => this.token === mine && !controller.signal.aborted;
    const spaceId = opts.spaceId ?? selectedSpaceId();

    this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId });
    let utterances: string[];
    try {
      utterances = await withAbort(
        this.prepare(text, opts, controller.signal, spaceId),
        controller.signal,
      );
    } catch (error) {
      const failure = live() ? errorText(error) : undefined;
      if (failure) this.set({ ...IDLE, error: failure });
      if (this.request === controller) this.request = null;
      return failure;
    }
    if (!live()) return;
    if (!utterances.length) {
      this.set(IDLE);
      if (this.request === controller) this.request = null;
      return;
    }

    type Rendered = { blob: Blob; error?: never } | { blob?: never; error: unknown };
    const render = (utterance: string): Promise<Rendered> =>
      this.render(utterance, opts, controller.signal, spaceId).then(
        (blob) => ({ blob }),
        (error: unknown) => ({ error }),
      );
    let next: Promise<Rendered> | null = render(utterances[0] ?? "");
    for (let i = 0; i < utterances.length; i += 1) {
      const current = next;
      next = i + 1 < utterances.length ? render(utterances[i + 1] ?? "") : null;
      if (!current) break;
      const rendered = await current;
      if ("error" in rendered) {
        const failure = live() ? errorText(rendered.error) : undefined;
        if (failure) this.set({ ...IDLE, error: failure });
        if (this.request === controller) this.request = null;
        return failure;
      }
      if (!live()) return;
      this.set({
        status: "speaking",
        botId: opts.botId,
        messageId: opts.messageId,
        caption: utterances[i],
      });
      const finished = await this.play(rendered.blob, live);
      if (!finished || !live()) {
        if (live()) this.set(IDLE);
        if (this.request === controller) this.request = null;
        return;
      }
    }
    if (live()) this.set(IDLE);
    if (this.request === controller) this.request = null;
  }

  private async prepare(
    text: string,
    opts: SpeakOptions,
    signal: AbortSignal,
    spaceId: string | null,
  ): Promise<string[]> {
    const body = await rpc.voice.prepare(
      { text, voiceId: opts.voiceId, botId: opts.botId, scope: opts.scope },
      { signal, context: { spaceId } },
    );
    if (!body.ready) {
      throw new Error(t`Add a voice provider key and pick a voice in Voice settings.`);
    }
    return body.utterances ?? [];
  }

  private async render(
    text: string,
    opts: SpeakOptions,
    signal: AbortSignal,
    spaceId: string | null,
  ): Promise<Blob> {
    const deadline = requestDeadline(
      VOICE_RESPONSE_TIMEOUT_MS,
      t`Voice request timed out.`,
      signal,
    );
    try {
      const res = await withAbort(
        fetch("/api/voice/speak", {
          method: "POST",
          headers: withSpaceHeaders({ "content-type": "application/json" }, spaceId),
          credentials: "include",
          body: JSON.stringify({
            text,
            voiceId: opts.voiceId,
            botId: opts.botId,
            scope: opts.scope,
          }),
          signal: deadline.signal,
        }),
        deadline.signal,
      );
      if (!res.ok) {
        const body = await readVoiceError(res, deadline.signal);
        throw new Error(voiceAccountErrorText(body) ?? body.error ?? "");
      }
      const bytes = await readVoiceAudio(res, deadline.signal);
      return new Blob([new Uint8Array(bytes)], {
        type: res.headers.get("content-type") ?? "audio/mpeg",
      });
    } finally {
      deadline.dispose();
    }
  }

  private play(blob: Blob, live: () => boolean): Promise<boolean> {
    return new Promise((resolve) => {
      if (!live()) return resolve(false);
      this.teardownAudio();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.audio = audio;
      this.objectUrl = url;
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        if (this.settlePlayback === done) this.settlePlayback = null;
        if (this.audio === audio) this.teardownAudio();
        resolve(ok);
      };
      this.settlePlayback = done;
      audio.onended = () => done(true);
      audio.onerror = () => done(false);
      audio.play().catch(() => done(false));
    });
  }
}

export const speaker = new Speaker();
