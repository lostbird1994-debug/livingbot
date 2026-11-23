import type { VoiceModelEntry } from "../../contracts/src/voice-models.js";
import { CARTESIA_TTS_MODEL } from "./cartesia-voice.js";
import { DASHSCOPE_STT_MODEL, DASHSCOPE_TTS_MODEL } from "./dashscope-voice.js";
import { ELEVENLABS_STT_MODEL, ELEVENLABS_TTS_MODEL } from "./elevenlabs-voice.js";
import { resolveFishSpeechModel, resolveFishTranscriptionModel } from "./fish-audio-voice.js";
import { parseOpenAiCompatibleVoiceSecret } from "./openai-compatible-voice.js";
import { OPENAI_STT_MODEL, OPENAI_TTS_MODEL } from "./openai-voice.js";
import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";
import { readVoiceJson } from "./voice-http.js";

export function voiceModelDefaults(
  provider: string,
  secret: string,
): { ttsModel: string; sttModel: string; selectable: boolean } {
  switch (provider) {
    case "dashscope":
      return { ttsModel: DASHSCOPE_TTS_MODEL, sttModel: DASHSCOPE_STT_MODEL, selectable: true };
    case "openai":
      return { ttsModel: OPENAI_TTS_MODEL, sttModel: OPENAI_STT_MODEL, selectable: true };
    case "elevenlabs":
      return { ttsModel: ELEVENLABS_TTS_MODEL, sttModel: ELEVENLABS_STT_MODEL, selectable: true };
    case "cartesia":
      return { ttsModel: CARTESIA_TTS_MODEL, sttModel: "", selectable: true };
    case "fish-audio":
      return {
        ttsModel: resolveFishSpeechModel(),
        sttModel: resolveFishTranscriptionModel(),
        selectable: true,
      };
    case "openai-compatible": {
      const config = parseOpenAiCompatibleVoiceSecret(secret);
      return { ttsModel: config.ttsModel, sttModel: config.sttModel, selectable: true };
    }
    default:
      return { ttsModel: "", sttModel: "", selectable: false };
  }
}
/** Only advertised capabilities classify models. Unknown models remain available for manual selection. */
export function normalizeVoiceModels(body: unknown): VoiceModelEntry[] {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const rows = Array.isArray(body)
    ? body
    : Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.models)
        ? record.models
        : [];
  const found = new Map<string, VoiceModelEntry>();
  for (const item of rows.slice(0, 2000)) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    const id = value.id ?? value.model_id;
    if (typeof id !== "string" || !id.trim() || id.length > 200 || /[\p{Cc}]/u.test(id)) continue;
    const entry: VoiceModelEntry = {
      id,
      label: typeof value.name === "string" ? value.name.slice(0, 120) : id,
    };
    if (typeof value.can_do_text_to_speech === "boolean")
      entry.synthesis = value.can_do_text_to_speech;
    found.set(id, entry);
  }
  return [...found.values()];
}
export async function discoverVoiceModels(
  provider: string,
  secret: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  let url: string;
  let headers: Record<string, string>;
  let request = fetcher;
  if (provider === "openai-compatible") {
    const config = parseOpenAiCompatibleVoiceSecret(secret);
    url = config.baseUrl.replace(/\/$/, "") + "/models";
    headers = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
    request = createOpenAiCompatibleFetch(fetcher, undefined, { allowPrivate: true });
  } else if (provider === "dashscope" || provider === "openai") {
    url =
      provider === "dashscope"
        ? "https://dashscope.aliyuncs.com/compatible-mode/v1/models"
        : "https://api.openai.com/v1/models";
    headers = { authorization: `Bearer ${secret}` };
  } else if (provider === "elevenlabs") {
    url = "https://api.elevenlabs.io/v1/models";
    headers = { "xi-api-key": secret };
  } else return { models: [] as VoiceModelEntry[], supported: false };
  const response = await request(url, {
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    redirect: "error",
  });
  if (response.status === 404 || response.status === 405) {
    await response.body?.cancel();
    return { models: [] as VoiceModelEntry[], supported: false };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`模型探测失败（HTTP ${response.status}）`);
  }
  return {
    models: normalizeVoiceModels(await readVoiceJson(response, { requireValid: true })),
    supported: true,
  };
}
