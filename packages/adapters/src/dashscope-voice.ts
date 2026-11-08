import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { accessSync, constants } from "node:fs";
import type {
  AdapterContext,
  AdapterDescriptor,
  SpeechClip,
  VoiceCapabilities,
  VoiceInfo,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceTranscribeRequest,
  VoiceVerifyResult,
} from "@rakazo/adapter-kit";
import { MAX_SPEAK_CHARS } from "./voice-http.js";

/**
 * Alibaba Cloud Bailian (DashScope) speech.
 *
 * Transcription uses the multimodal-generation endpoint, which is *not* Whisper-shaped: the
 * audio has to arrive as a base64 wav inside `input.messages`, and there is no
 * `/audio/transcriptions` path at all (it answers 404). That is the whole reason a local
 * adapter exists instead of pointing an OpenAI-compatible provider at DashScope.
 *
 * Cloud synthesis collects WebSocket PCM frames and returns one WAV clip.
 */
export const DASHSCOPE_VOICE_PROVIDER_ID = "dashscope";

export const DASHSCOPE_VOICE_CATALOG_ENTRY = {
  id: DASHSCOPE_VOICE_PROVIDER_ID,
  name: "阿里百炼 · DashScope",
  description: "Qwen 语音识别（中文强）+ 云端女声朗读。中国大陆直连。",
  transcribe: true,
} as const;

const CLOUD_BASE = "https://dashscope.aliyuncs.com";
const TTS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const TTS_MODEL = "qwen-audio-3.1-tts-flash";
const TTS_RATE = 24_000;
const DEFAULT_VOICE = "longanhuan_v3.1";
const TTS_TIMEOUT_MS = 45_000;

/** Cloud voices, female first because that is what this adapter is usually chosen for. */
const CLOUD_VOICES = [
  { id: "longanhuan_v3.1", label: "龙安欢", description: "女 · 默认 · 会方言" },
  { id: "longanlingxin_v3.1", label: "龙安灵心", description: "女 · 温柔" },
  { id: "longanfengyue_v3.1", label: "龙安风悦", description: "女 · 自然" },
  { id: "qiaoxiaojiao_v3.1", label: "乔小娇", description: "女 · 俏丽" },
  { id: "yezhiqing_v3.1", label: "叶芷晴", description: "女 · 轻快" },
  { id: "anruorou_v3.1", label: "安若柔", description: "女 · 气声知性" },
  { id: "yuxiaoyun_v3.1", label: "于小云", description: "女 · 元气" },
  { id: "anxiaolan_v3.1", label: "安小岚", description: "女 · 甜润" },
  { id: "xuyuyuan_v3.1", label: "许语媛", description: "女 · 知性" },
  { id: "xunanchuan_v3.1", label: "许南川", description: "男" },
  { id: "amingyuan_v3.1", label: "安明远", description: "男" },
] as const satisfies readonly VoiceInfo[];
const ASR_MODEL = "qwen-audio-3.1-asr-flash";
const GENERATION_PATH = "/api/v1/services/aigc/multimodal-generation/generation";
const MODELS_PATH = "/compatible-mode/v1/models";

const VERIFY_TIMEOUT_MS = 15_000;
const TRANSCRIBE_TIMEOUT_MS = 60_000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 120;
const SAMPLE_RATE = 16_000;
const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_PATH,
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
].filter((value): value is string => Boolean(value));

function ffmpegPath(): string | undefined {
  for (const candidate of FFMPEG_CANDIDATES) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

/** Minimal 16 kHz mono PCM16 wav header: the API takes a data URI, not raw frames. */
function wavFromPcm(pcm: Buffer, rate: number = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

type SocketLike = {
  send(data: string | Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
};

type SocketCtor = new (url: string, options?: { headers?: Record<string, string> }) => SocketLike;

export async function dashscopeSocketConstructor(): Promise<SocketCtor> {
  const { WebSocket } = await import("ws");
  return WebSocket as unknown as SocketCtor;
}

/** Node hands WebSocket payloads over as Blob; everything else is already bytes. */
async function asBuffer(data: unknown): Promise<Buffer> {
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  const blob = data as { arrayBuffer?: () => Promise<ArrayBuffer> } | null;
  if (blob && typeof blob.arrayBuffer === "function") {
    return Buffer.from(new Uint8Array(await blob.arrayBuffer()));
  }
  return Buffer.alloc(0);
}

/**
 * Speech synthesis is WebSocket-only: run-task opens the stream, continue-task carries the
 * sentence, finish-task ends it, and the audio arrives as binary PCM frames. The frames are
 * collected in order and wrapped into one wav, which is what the speak path can return.
 */
async function synthesizeOverSocket(
  text: string,
  voice: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const Ctor = await dashscopeSocketConstructor();
  return new Promise((resolve, reject) => {
    const taskId = crypto.randomUUID();
    const header = (action: string) => ({
      header: { action, task_id: taskId, streaming: "duplex" },
    });
    const parts: Promise<Buffer>[] = [];
    let settled = false;
    let socket: SocketLike | null = null;
    const timer = setTimeout(() => finish(new Error("Bailian speech timed out.")), TTS_TIMEOUT_MS);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      try {
        socket?.close();
      } catch {
        // already closed
      }
      if (error) {
        reject(error);
        return;
      }
      void Promise.all(parts).then(
        (chunks) => resolve(Buffer.concat(chunks)),
        () => reject(new Error("Bailian audio could not be read.")),
      );
    };
    const onAbort = () => finish(new Error("Bailian speech was cancelled."));
    if (signal.aborted) {
      finish(new Error("Bailian speech was cancelled."));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      socket = new Ctor(TTS_URL, { headers: { Authorization: `bearer ${apiKey}` } });
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Could not open the speech socket."));
      return;
    }

    socket.addEventListener("open", () => {
      try {
        socket?.send(
          JSON.stringify({
            ...header("run-task"),
            payload: {
              task_group: "audio",
              task: "tts",
              function: "SpeechSynthesizer",
              model: TTS_MODEL,
              parameters: { voice, format: "pcm", sample_rate: TTS_RATE },
              input: {},
            },
          }),
        );
      } catch {
        finish(new Error("Could not start Bailian speech."));
      }
    });

    socket.addEventListener("message", (event) => {
      const data = event.data;
      if (typeof data !== "string") {
        parts.push(asBuffer(data));
        return;
      }
      let msg: { header?: { event?: string; error_message?: string } };
      try {
        msg = JSON.parse(data) as typeof msg;
      } catch {
        return;
      }
      const kind = msg.header?.event;
      if (kind === "task-started") {
        try {
          socket?.send(
            JSON.stringify({ ...header("continue-task"), payload: { input: { text } } }),
          );
          socket?.send(JSON.stringify({ ...header("finish-task"), payload: { input: {} } }));
        } catch {
          finish(new Error("Could not send that sentence to Bailian."));
        }
        return;
      }
      if (kind === "task-failed") {
        finish(new Error(msg.header?.error_message || "Bailian speech failed."));
        return;
      }
      if (kind === "task-finished") finish();
    });

    socket.addEventListener("error", () => {
      if (!settled) finish(new Error("The speech socket failed. Check the key and the network."));
    });
  });
}

function run(bin: string, args: string[], input: Buffer, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
      signal,
      killSignal: "SIGKILL",
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      child.kill("SIGKILL");
      reject(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_AUDIO_BYTES) fail(new Error("That recording is too large."));
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () =>
      reject(
        signal.aborted
          ? new Error("Audio conversion was cancelled.")
          : new Error("Audio conversion is unavailable."),
      ),
    );
    child.on("close", (code) => {
      if (failed) return;
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error("That recording could not be decoded."));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

export class DashScopeVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: DASHSCOPE_VOICE_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    try {
      const res = await fetch(CLOUD_BASE + MODELS_PATH, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.any(
          [context.signal, AbortSignal.timeout(VERIFY_TIMEOUT_MS)].filter(Boolean) as AbortSignal[],
        ),
      });
      await res.body?.cancel();
      if (res.ok) return { ok: true };
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: "That key was rejected. Use a Beijing-region Bailian key." };
      }
      return { ok: false, message: `Bailian answered ${res.status}.` };
    } catch {
      return {
        ok: false,
        message: "Bailian could not be reached. Check the network, not a proxy.",
      };
    }
  }

  listVoices(_apiKey: string, _context: AdapterContext): Promise<VoiceInfo[]> {
    return Promise.resolve([...CLOUD_VOICES]);
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const text = request.text.trim();
    if (!text) throw new Error("Nothing to speak.");
    if (text.length > MAX_SPEAK_CHARS) throw new Error("That utterance is too long to speak.");
    const voice = CLOUD_VOICES.some((entry) => entry.id === request.voiceId)
      ? request.voiceId
      : DEFAULT_VOICE;
    const pcm = await synthesizeOverSocket(
      text,
      voice,
      request.apiKey,
      AbortSignal.any(
        [request.signal, context.signal, AbortSignal.timeout(TTS_TIMEOUT_MS)].filter(
          Boolean,
        ) as AbortSignal[],
      ),
    );
    if (!pcm.length) throw new Error("Bailian returned no audio.");
    return { bytes: new Uint8Array(wavFromPcm(pcm, TTS_RATE)), mimeType: "audio/wav" };
  }

  async transcribe(
    request: VoiceTranscribeRequest,
    context: AdapterContext,
  ): Promise<{ text: string }> {
    if (!request.audio.byteLength) throw new Error("That recording is empty.");
    if (request.audio.byteLength > MAX_AUDIO_BYTES) throw new Error("That recording is too large.");

    const signal = AbortSignal.any(
      [request.signal, context.signal, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)].filter(
        Boolean,
      ) as AbortSignal[],
    );
    const bin = ffmpegPath();
    let wav: Buffer;
    if (bin) {
      const pcm = await run(
        bin,
        [
          "-nostdin",
          "-v",
          "error",
          "-i",
          "pipe:0",
          "-map",
          "0:a:0",
          "-vn",
          "-t",
          String(MAX_AUDIO_SECONDS),
          "-ar",
          String(SAMPLE_RATE),
          "-ac",
          "1",
          "-f",
          "s16le",
          "pipe:1",
        ],
        Buffer.from(request.audio),
        signal,
      );
      if (!pcm.length) throw new Error("That recording contained no audio.");
      wav = wavFromPcm(pcm);
    } else if (request.mimeType.includes("wav")) {
      // No ffmpeg on this machine: hand the wav through and let the API decide.
      wav = Buffer.from(request.audio);
    } else {
      throw new Error("Transcription needs ffmpeg to convert the recording to 16 kHz wav.");
    }

    const res = await fetch(CLOUD_BASE + GENERATION_PATH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        "content-type": "application/json",
        "X-DashScope-SSE": "disable",
      },
      body: JSON.stringify({
        model: ASR_MODEL,
        input: {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "input_audio",
                  input_audio: { data: `data:audio/wav;base64,${wav.toString("base64")}` },
                },
              ],
            },
          ],
        },
        parameters: { format: "wav", sample_rate: String(SAMPLE_RATE) },
      }),
      signal,
    });

    if (!res.ok) await res.body?.cancel();
    if (!res.ok) {
      throw new Error(
        res.status === 401 || res.status === 403
          ? "Bailian rejected that key for transcription."
          : `Bailian transcription failed (${res.status}).`,
      );
    }
    const data = (await res.json()) as { output?: { text?: unknown } };
    const text = typeof data.output?.text === "string" ? data.output.text.trim() : "";
    if (!text) throw new Error("Bailian returned an empty transcript.");
    return { text };
  }
}
