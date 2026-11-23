import { DEFAULT_NOTIFICATION_TEMPLATE, notificationTemplate, notificationLine } from "../../../packages/workbench/src/voice-notification.ts";
// Local persistence/HTTP adaptation of 1.0 apps/api/src/voice.ts.
// Providers, validation, speech formatting and the entire call UI are reused.
import type { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import type { Bot } from "../../../packages/workbench/src/contracts.ts";

export function localVoice(store: WorkbenchStore) {
  const adapters = () => import("./voice-adapters.mjs");
  const context = () => ({ operationId: "voice", traceId: "voice", spaceId: "local",
    userId: "local", signal: AbortSignal.timeout(70000) });
  const entries = () => store.list<any>("voiceCredentials", -1).filter((row) => !row.disconnected);
  // Donor: 1.0 resolveVoiceTarget/loadDefaultVoiceCredential. Connections belong
  // to the account; workspace preferences override the account's chosen voice.
  const preferenceId = (input: any) => {
    const workspace = `voice-preference:space:${input.spaceId ?? "local"}`;
    return input.scope === "space" || (input.scope === undefined && store.get("settings", workspace))
      ? workspace : "voice-preference:account";
  };
  const preference = (input: any) => store.get<any>("settings", preferenceId(input)) ??
    (input.scope === undefined ? store.get<any>("settings", `voice-preference:space:${input.spaceId ?? "local"}`) : undefined);
  const selected = (input: any = {}) => {
    const local = input.scope === undefined
      ? store.get<any>("settings", `voice-preference:space:${input.spaceId ?? "local"}`) : undefined;
    const preferred = local ?? preference(input) ??
      (input.scope === "space" ? store.get<any>("settings", "voice-preference:account") : undefined);
    const row = entries().find((row) => row.provider === preferred?.provider) ??
      (preferred ? undefined : entries().find((row) => row.isDefault) ?? entries()[0]);
    return row && { ...row, ...(preferred ?? {}), id: row.id };
  };
  const savePreference = (input: any, row: any) => store.put("settings", {
    id: preferenceId(input), provider: row.provider, voiceId: row.voiceId, speechModel: row.speechModel, ttsModel: row.ttsModel, sttModel: row.sttModel,
  });
  const dto = (row: any) => ({ id: row.id, provider: row.provider, hasKey: Boolean(row.secret),
    isDefault: Boolean(row.isDefault), voiceId: row.voiceId ?? "", speechModel: row.speechModel ?? "",
    transcribe: Boolean(row.transcribe), endpoint: row.baseUrl ?? "", ttsModel: row.ttsModel ?? "", sttModel: row.sttModel ?? "" });
  async function status(input: any = {}) {
    const row = selected(input);
    return { configured: Boolean(row), ready: Boolean(row?.voiceId), transcribe: Boolean(row?.transcribe),
      provider: row?.provider ?? null, voiceId: row?.voiceId ?? "" };
  }
  async function rpc(operation: string, input: any = {}) {
    if (operation === "status") return status(input);
    if (operation === "credentials") return entries().map((row) => dto({
      ...row, isDefault: selected(input)?.provider === row.provider,
      ...(selected(input)?.provider === row.provider ? selected(input) : {}),
    }));
    if (operation === "notificationSettings" || operation === "saveNotificationSettings") {
      const id = input.scope === "space" ? `voice-notification:space:${input.spaceId ?? "local"}` : "voice-notification:account";
      if (operation === "saveNotificationSettings") store.put("settings", {id, template: notificationTemplate(input.template)});
      return {template: store.get<any>("settings", id)?.template ?? store.get<any>("settings", "voice-notification:account")?.template ?? DEFAULT_NOTIFICATION_TEMPLATE};
    }
    const lib = await adapters();
    if (operation === "catalog") return lib.listVoiceCatalog({ allowPrivateEndpoint: true });
    const current = selected(input);
    const row = input.provider
      ? current?.provider === input.provider ? current : entries().find((row) => row.provider === input.provider)
      : current;
    if (["modelSettings", "discoverModels", "saveModels"].includes(operation)) {
      if (!row) throw new Error("请先连接语音服务");
      const defaults = lib.voiceModelDefaults(row.provider, row.secret);
      if (operation === "discoverModels") return lib.discoverVoiceModels(row.provider, row.secret, context().signal);
      if (operation === "saveModels") {
        if (!defaults.selectable) throw new Error("当前服务不支持指定模型");
        const validate = (value: unknown) => { if (typeof value !== "string" || !value.trim() || value.length > 200 || !/^[\w.:/@+-]+$/.test(value)) throw new Error("请输入有效模型名称"); return value.trim(); };
        const ttsModel = validate(input.ttsModel);
        const sttModel = row.transcribe ? validate(input.sttModel) : "";
        savePreference(input, {...row, ttsModel, sttModel});
        return {provider:row.provider,ttsModel,sttModel,selectable:defaults.selectable,transcribe:Boolean(row.transcribe)};
      }
      return {provider:row.provider,ttsModel:row.ttsModel || row.speechModel || defaults.ttsModel,sttModel:row.sttModel || defaults.sttModel,selectable:defaults.selectable,transcribe:Boolean(row.transcribe)};
    }
    if (operation === "prepare") {
      if (!row?.voiceId) return { ready: false, utterances: [] };
      if (input.purpose === "notification") {
        const short = lib.speakable(input.text ?? "");
        const message = Array.from(short).length <= 20 ? short : "有新消息，请查看";
        const botName = input.botId ? store.get<Bot>("bots", input.botId)?.name ?? "Bot" : "Bot";
        const id = `voice-notification:space:${input.spaceId ?? "local"}`;
        const template = store.get<any>("settings", id)?.template ?? store.get<any>("settings", "voice-notification:account")?.template ?? DEFAULT_NOTIFICATION_TEMPLATE;
        return {ready:true,utterances:short ? [message] : [],announcement:short ? notificationLine(template,botName,message) : ""};
      }
      return { ready: true, utterances: lib.toUtterances(lib.speakable(input.text ?? ""), { maxChars: 2000 }) };
    }
    if (operation === "disconnect") {
      if (row) store.put("voiceCredentials", { id: row.id, disconnected: true });
      return { ok: true };
    }
    if (operation === "connect") {
      const provider = lib.createVoiceProvider(input.provider, { allowPrivateEndpoint: true });
      const keyless = lib.listVoiceCatalog({ allowPrivateEndpoint: true }).find((p: any) => p.id === input.provider)?.keyless;
      const secret = input.provider === "openai-compatible"
        ? lib.serializeOpenAiCompatibleVoiceSecret({ baseUrl: input.baseUrl, apiKey: input.apiKey ?? "",
            ttsModel: input.ttsModel, sttModel: input.sttModel }, row?.secret, { allowPrivate: true })
        : keyless ? input.provider : input.apiKey || row?.secret || "";
      const verified = await provider.verify(secret, context());
      if (!verified.ok) throw new Error(verified.message || "语音连接验证失败");
      const voices = await provider.listVoices(secret, context());
      const voiceId = input.voiceId || row?.voiceId || voices[0]?.id || "";
      if (voiceId && !voices.some((v: any) => v.id === voiceId)) throw new Error("请选择可用的声音");
      const saved = { id: `voice-credential:${input.provider}`, provider: input.provider, secret,
        voiceId, speechModel: input.speechModel ?? row?.speechModel ?? "", baseUrl: input.baseUrl ?? row?.baseUrl ?? "", ttsModel: input.ttsModel ?? row?.ttsModel ?? "",
        sttModel: input.sttModel ?? row?.sttModel ?? "", transcribe: provider.describe().capabilities.transcribe, isDefault: true };
      store.put("voiceCredentials", saved);
      savePreference(input, saved);
      return dto(saved);
    }
    if (!row) {
      if (operation === "voices") return [];
      throw new Error("请先连接语音服务");
    }
    const provider = lib.createVoiceProvider(row.provider, { allowPrivateEndpoint: true });
    if (operation === "voices") return provider.listVoices(row.secret, context());
    if (operation === "setVoice") {
      const voices = await provider.listVoices(row.secret, context());
      if (!voices.some((v: any) => v.id === input.voiceId)) throw new Error("请选择可用的声音");
      savePreference(input, { ...row, voiceId: input.voiceId });
      return status(input);
    }
    if (operation === "setSpeechModel") {
      const updated = { ...row, speechModel: input.speechModel };
      savePreference(input, updated);
      return dto(updated);
    }
    throw new Error("Unknown voice operation");
  }
  async function synthesize(input: any) {
    const row = selected(input);
    if (!row?.voiceId) throw new Error("请先选择声音");
    const lib = await adapters();
    return lib.createVoiceProvider(row.provider, { allowPrivateEndpoint: true }).synthesize({
      text: lib.speakable(input.text), voiceId: input.voiceId ||
        (input.botId ? store.get<Bot>("bots", input.botId)?.voiceId : undefined) || row.voiceId, apiKey: row.secret,
      model: row.ttsModel || row.speechModel || undefined,
    }, context());
  }
  async function transcribe(input: any) {
    const row = selected(input);
    if (!row?.transcribe) throw new Error("当前语音服务不支持转写，请使用系统听写");
    if (typeof input.audioBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.audioBase64))
      throw new Error("Invalid audio recording");
    const audio = Buffer.from(input.audioBase64, "base64");
    if (!audio.length || audio.length > 8 * 1024 * 1024) throw new Error("That recording is empty or too large");
    const lib = await adapters();
    const provider = lib.createVoiceProvider(row.provider, { allowPrivateEndpoint: true });
    if (!provider.transcribe) throw new Error("当前语音服务不支持转写");
    const result = await provider.transcribe({ audio, mimeType: input.mimeType || "audio/webm",
      model: row.sttModel || undefined, language: input.language, apiKey: row.secret }, context());
    return { text: result.text };
  }
  return { rpc, synthesize, transcribe };
}
