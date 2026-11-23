import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import { localVoice } from "./voice.ts";

const saved = {
  id: "voice-credential:openai",
  provider: "openai",
  secret: "synthetic-secret",
  voiceId: "alloy",
  transcribe: true,
  isDefault: true,
};
test("native voice selection reaches synthesis and transcription, discovery never exposes the key", async (t) => {
  const store = new WorkbenchStore(":memory:");
  const voice = localVoice(store);
  store.put("voiceCredentials", saved);
  t.after(() => store.close());
  const requests: { url: string; model: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (String(url).endsWith("/models"))
      return new Response(JSON.stringify({ data: [{ id: "custom-tts" }, { id: "custom-asr" }] }), {
        headers: { "content-type": "application/json" },
      });
    if (String(url).endsWith("/audio/speech")) {
      requests.push({ url: String(url), model: JSON.parse(init.body as string).model });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    }
    requests.push({ url: String(url), model: (init.body as FormData).get("model") });
    return new Response(JSON.stringify({ text: "synthetic transcript" }), {
      headers: { "content-type": "application/json" },
    });
  });
  assert.equal(
    (await voice.rpc("modelSettings", { scope: "account" })).ttsModel,
    "gpt-4o-mini-tts",
  );
  await voice.rpc("saveModels", {
    scope: "account",
    ttsModel: "custom-tts",
    sttModel: "custom-asr",
  });
  await voice.synthesize({ text: "test" });
  await voice.transcribe({ audioBase64: "AQID", mimeType: "audio/wav" });
  assert.deepEqual(
    requests.map((x) => x.model),
    ["custom-tts", "custom-asr"],
  );
  const catalog = await voice.rpc("discoverModels", {});
  assert.deepEqual(
    catalog.models.map((x: { id: string }) => x.id),
    ["custom-tts", "custom-asr"],
  );
  assert.ok(!JSON.stringify(catalog).includes(saved.secret));
  await voice.rpc("saveModels", { scope: "space", ttsModel: "space-tts", sttModel: "space-asr" });
  assert.equal((await voice.rpc("modelSettings", { scope: "account" })).ttsModel, "custom-tts");
  assert.equal((await voice.rpc("modelSettings", { scope: "space" })).ttsModel, "space-tts");
  await voice.rpc("setVoice", { scope: "space", voiceId: "alloy" });
  assert.equal((await voice.rpc("modelSettings", { scope: "space" })).ttsModel, "space-tts");
  await assert.rejects(voice.rpc("saveModels", { ttsModel: "bad\nmodel", sttModel: "ok" }));
});
test("notification templates inherit, remain scoped and format the spoken notice without duplicate prefix", async (t) => {
  const store = new WorkbenchStore(":memory:");
  t.after(() => store.close());
  store.put("voiceCredentials", saved);
  const voice = localVoice(store);
  const bot = store.createBot({ name: "Writer", agentId: "writer" });
  await voice.rpc("saveNotificationSettings", {
    scope: "account",
    template: "{botName}：{message}",
  });
  const result = await voice.rpc("prepare", {
    botId: bot.id,
    text: "任务完成",
    purpose: "notification",
  });
  assert.equal(result.announcement, "Writer：任务完成");
  await voice.rpc("saveNotificationSettings", {
    scope: "space",
    template: "请查看{botName}的新消息",
  });
  assert.equal(
    (await voice.rpc("prepare", { botId: bot.id, text: "任务完成", purpose: "notification" }))
      .announcement,
    "请查看Writer的新消息",
  );
  assert.equal(
    (await voice.rpc("notificationSettings", { scope: "account" })).template,
    "{botName}：{message}",
  );
  assert.equal(
    (await voice.rpc("prepare", { botId: bot.id, text: "", purpose: "notification" })).announcement,
    "",
  );
  await assert.rejects(voice.rpc("saveNotificationSettings", { template: "{unknown}" }));
  assert.deepEqual((await voice.rpc("prepare", { text: "speech" })).utterances, ["speech"]);
});
