import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { createHash } from "node:crypto";
import fsPromises, { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import type { ProductEvent } from "../../../packages/workbench/src/contracts.ts";
import { localVoice } from "./voice.ts";

// Expected fixture contract from the existing scripted provider. Keep these
// local so the server check does not import the legacy adapter type graph.
const SCRIPTED_VOICE_ID = "alloy-test";
const SCRIPTED_TRANSCRIPT = "hello from the test microphone";
const SCRIPTED_MPEG = Uint8Array.from([
  0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const secret = "synthetic-voice-key-for-offline-tests";
const disconnected = {
  configured: false, ready: false, transcribe: false, provider: null, voiceId: "",
};
const connected = {
  configured: true, ready: true, transcribe: true, provider: "scripted", voiceId: SCRIPTED_VOICE_ID,
};

function fixture(t: TestContext) {
  // No disk database, native service, mocked provider, or vendor request.
  const originalRuntime = process.env.AGENT_RUNTIME;
  process.env.AGENT_RUNTIME = "scripted";
  const network = t.mock.method(globalThis, "fetch", () => {
    throw new Error("Network is forbidden in offline voice tests");
  });
  const store = new WorkbenchStore(":memory:");
  const emitted: ProductEvent[] = [];
  store.on("event", (event: ProductEvent) => emitted.push(event));
  t.after(() => {
    store.close();
    if (originalRuntime === undefined) delete process.env.AGENT_RUNTIME;
    else process.env.AGENT_RUNTIME = originalRuntime;
    assert.equal(network.mock.callCount(), 0);
  });
  const voice = localVoice(store);
  const connect = () => voice.rpc("connect", {
    provider: "scripted", apiKey: secret, scope: "account",
  });
  function assertPrivate(...responses: unknown[]) {
    for (const value of [store.snapshot(), store.eventsAfter(0), emitted, ...responses]) {
      const serialized = JSON.stringify(value);
      assert.equal(serialized.includes(secret), false, "secret leaked into a public payload");
      assert.equal(serialized.includes('"secret"'), false, "secret field leaked into a public payload");
    }
    const events = store.eventsAfter(0).filter((event) => event.type === "voiceCredentials.changed");
    assert(events.length > 0, "privacy assertion must exercise a credential mutation");
    for (const event of events) assert.deepEqual(event.data, { id: "voice-credential:scripted" });
  }
  return { store, voice, connect, assertPrivate };
}

test("original scripted provider completes the local voice lifecycle without leaking credentials", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.voice.rpc("status"), disconnected);
  assert.deepEqual(await f.voice.rpc("credentials"), []);
  const catalog = await f.voice.rpc("catalog");
  assert(catalog.some((entry: { id: string }) => entry.id === "scripted"));
  const credential = await f.connect();
  assert.deepEqual(credential, {
    id: "voice-credential:scripted", provider: "scripted", hasKey: true, isDefault: true,
    voiceId: SCRIPTED_VOICE_ID, speechModel: "", transcribe: true,
    endpoint: "", ttsModel: "", sttModel: "",
  });
  assert.equal(f.store.get<{ secret: string }>("voiceCredentials", credential.id)?.secret, secret);
  assert.deepEqual(await f.voice.rpc("status"), connected);
  assert.deepEqual(await f.voice.rpc("credentials"), [credential]);
  assert.deepEqual(await f.voice.rpc("voices"), [
    { id: SCRIPTED_VOICE_ID, label: "Scripted", description: "Test voice" },
  ]);
  assert.deepEqual(await f.voice.rpc("setVoice", {
    scope: "account", provider: "scripted", voiceId: SCRIPTED_VOICE_ID,
  }), connected);
  const prepared = await f.voice.rpc("prepare", { text: "**Hello** [world](https://example.test)." });
  // Formatting, not a semantic/quality judgment of free-form speech.
  assert.deepEqual(prepared, { ready: true, utterances: ["Hello world."] });
  const clip = await f.voice.synthesize({ text: prepared.utterances[0] });
  assert.equal(clip.mimeType, "audio/mpeg");
  assert.deepEqual(clip.bytes, SCRIPTED_MPEG);
  assert.deepEqual(await f.voice.transcribe({
    audioBase64: Buffer.from(clip.bytes).toString("base64"), mimeType: clip.mimeType, language: "en",
  }), { text: SCRIPTED_TRANSCRIPT });
  f.assertPrivate(credential, await f.voice.rpc("credentials"));
  assert.deepEqual(await f.voice.rpc("disconnect", { provider: "scripted" }), { ok: true });
  assert.deepEqual(await f.voice.rpc("status"), disconnected);
  assert.deepEqual(await f.voice.rpc("credentials"), []);
  await assert.rejects(f.voice.synthesize({ text: "Hello." }));
  await assert.rejects(f.voice.transcribe({ audioBase64: "AQ==" }));
  assert.deepEqual(await f.voice.rpc("disconnect", { provider: "scripted" }), { ok: true });
  f.assertPrivate();
  await f.connect();
  assert.deepEqual(await f.voice.rpc("status"), connected);
  f.assertPrivate(await f.voice.rpc("credentials"));
});

test("failed verification and invalid voice selection leave no partial credential or preference", async (t) => {
  const f = fixture(t);
  const cursor = f.store.cursor();
  await assert.rejects(f.voice.rpc("connect", { provider: "scripted", apiKey: "short" }));
  await assert.rejects(f.voice.rpc("connect", {
    provider: "scripted", apiKey: secret, voiceId: "not-in-the-catalog",
  }));
  assert.equal(f.store.cursor(), cursor);
  assert.deepEqual(f.store.list("voiceCredentials"), []);
  assert.deepEqual(f.store.list("settings"), []);
  await f.connect();
  const afterConnect = f.store.cursor();
  await assert.rejects(f.voice.rpc("setVoice", { voiceId: "not-in-the-catalog", scope: "space", spaceId: "a" }));
  assert.equal(f.store.cursor(), afterConnect);
  assert.deepEqual(await f.voice.rpc("status"), connected);
  f.assertPrivate();
});

test("transcription rejects malformed, empty and oversized recordings before the scripted transcriber", async (t) => {
  const f = fixture(t);
  await f.connect();
  for (const audioBase64 of [undefined, "%%%not-base64", "", "====",
    Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64")]) {
    await assert.rejects(f.voice.transcribe({ audioBase64 }));
  }
  assert.deepEqual(await f.voice.transcribe({ audioBase64: "AQ==" }), { text: SCRIPTED_TRANSCRIPT });
  f.assertPrivate();
});

function seedDistinctPreferences(store: WorkbenchStore) {
  // The real scripted catalog has exactly one voice. These synthetic persisted
  // older choices make accidental cross-scope writes observable; never synthesize them.
  for (const [target, voiceId] of [
    ["account", "retired-account"], ["space:a", "retired-a"], ["space:b", "retired-b"],
  ]) {
    store.put("settings", { id: `voice-preference:${target}`, provider: "scripted", voiceId });
  }
}

test("explicit account/space setVoice changes only its own saved choice", async (t) => {
  const f = fixture(t);
  await f.connect();
  seedDistinctPreferences(f.store);
  const b = f.store.get("settings", "voice-preference:space:b");
  await f.voice.rpc("setVoice", { scope: "space", spaceId: "a", voiceId: SCRIPTED_VOICE_ID });
  assert.equal((await f.voice.rpc("status", { scope: "account" })).voiceId, "retired-account");
  assert.equal((await f.voice.rpc("status", { spaceId: "a" })).voiceId, SCRIPTED_VOICE_ID);
  assert.equal((await f.voice.rpc("credentials", { spaceId: "a" }))[0].voiceId, SCRIPTED_VOICE_ID);
  await f.voice.rpc("setVoice", { scope: "account", voiceId: SCRIPTED_VOICE_ID });
  assert.deepEqual(f.store.get("settings", "voice-preference:space:b"), b);
  assert.equal((await f.voice.rpc("status", { spaceId: "b" })).voiceId, "retired-b");
  assert.equal((await f.voice.rpc("status", { spaceId: "no-override" })).voiceId, SCRIPTED_VOICE_ID);
  f.assertPrivate(await f.voice.rpc("credentials", { spaceId: "b" }));
});

test("omitted scope updates the active space override rather than the account choice", async (t) => {
  const f = fixture(t);
  await f.connect();
  seedDistinctPreferences(f.store);
  await f.voice.rpc("setVoice", { spaceId: "a", voiceId: SCRIPTED_VOICE_ID });
  assert.deepEqual({
    account: (await f.voice.rpc("status", { scope: "account" })).voiceId,
    a: (await f.voice.rpc("status", { spaceId: "a" })).voiceId,
    b: (await f.voice.rpc("status", { spaceId: "b" })).voiceId,
  }, { account: "retired-account", a: SCRIPTED_VOICE_ID, b: "retired-b" });
});

test("workspace voice edits inherit the account choice and preserve other scoped voice fields", async (t) => {
  const f = fixture(t);
  await f.connect();
  await f.voice.rpc("setSpeechModel", {
    scope: "account", provider: "scripted", speechModel: "account-model",
  });
  assert.equal((await f.voice.rpc("credentials", { scope: "space", spaceId: "a" }))[0].speechModel, "account-model");
  f.store.put("settings", {
    id: "voice-preference:space:a", provider: "scripted", voiceId: "retired-a", speechModel: "space-model",
  });
  await f.voice.rpc("setSpeechModel", {
    scope: "space", spaceId: "a", provider: "scripted", speechModel: "updated-space-model",
  });
  assert.equal((await f.voice.rpc("status", { scope: "space", spaceId: "a" })).voiceId, "retired-a");
  await f.voice.rpc("setVoice", {
    scope: "space", spaceId: "a", provider: "scripted", voiceId: SCRIPTED_VOICE_ID,
  });
  assert.equal((await f.voice.rpc("credentials", { scope: "space", spaceId: "a" }))[0].speechModel, "updated-space-model");
  assert.equal((await f.voice.rpc("credentials", { scope: "account" }))[0].speechModel, "account-model");
  f.assertPrivate();
});

test("prepare returns no utterances when no voice is configured, including after disconnect", async (t) => {
  const f = fixture(t);
  await t.test("before connecting", async () => {
    assert.deepEqual(await f.voice.rpc("prepare", { text: "Hello." }), { ready: false, utterances: [] });
  });
  await f.connect();
  await f.voice.rpc("disconnect", { provider: "scripted" });
  await t.test("after disconnecting", async () => {
    assert.deepEqual(await f.voice.rpc("prepare", { text: "Hello." }), { ready: false, utterances: [] });
  });
});

const macOptions = {
  skip: process.platform !== "darwin" || process.env.LIVINGBOT_TEST_MACOS_VOICE !== "1",
  timeout: 90_000,
};

test("opt-in macOS voice creates a silent WAV clip and recovers its temporary audio to Trash", macOptions, async (t) => {
  const f = fixture(t);
  await f.voice.rpc("connect", { provider: "macos", scope: "account" });
  const voices = await f.voice.rpc("voices");
  const voiceId = voices.find((voice: { description: string }) => voice.description === "en_US")?.id ?? voices[0].id;
  await f.voice.rpc("setVoice", { scope: "account", voiceId });
  const originals: string[] = [];
  const recoveries: string[] = [];
  const originalMkdtemp = fsPromises.mkdtemp;
  // Observe this invocation without enumerating the user's Trash or replacing
  // the original provider's cleanup behavior.
  const directoryObserver = t.mock.method(fsPromises, "mkdtemp", async (prefix: string) => {
    const result = await originalMkdtemp(prefix);
    if (prefix === join(tmpdir(), "rakazo-say-")) originals.push(result);
    if (prefix === join(homedir(), ".Trash/LivingBot-speech-")) recoveries.push(result);
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    directoryObserver.mock.restore();
    syncBuiltinESMExports();
    t.diagnostic(JSON.stringify({ originalDirectories: originals, recoveryDirectories: recoveries }));
  });
  // The original provider uses say -o, never audio output or a microphone.
  const clip = await f.voice.synthesize({ text: "Voice check." });
  assert.equal(clip.mimeType, "audio/wav");
  const bytes = Buffer.from(clip.bytes);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert(bytes.length > 44);
  await assert.rejects(f.voice.transcribe({ audioBase64: "AQ==" }));
  const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
  assert.equal(recoveries.length, 1, "provider must move generated audio to Trash");
  assert.equal(originals.length, 1);
  const recovered = join(recoveries[0], "audio", "speech.wav");
  assert.equal(digest(await readFile(recovered)), digest(bytes));
  await assert.rejects(readFile(join(originals[0], "speech.wav")), { code: "ENOENT" });
  t.diagnostic(JSON.stringify({ recovered, bytes: bytes.length, sha256: digest(bytes) }));
});

test("opt-in macOS account/space choices stay separate using two real installed voices", macOptions, async (t) => {
  const f = fixture(t);
  await f.voice.rpc("connect", { provider: "macos", scope: "account" });
  const voices = await f.voice.rpc("voices");
  assert(voices.length >= 2);
  const [account, space] = voices;
  await f.voice.rpc("setVoice", { scope: "space", spaceId: "a", voiceId: space.id });
  await f.voice.rpc("setVoice", { scope: "account", voiceId: account.id });
  assert.equal((await f.voice.rpc("status", { scope: "account" })).voiceId, account.id);
  assert.equal((await f.voice.rpc("status", { spaceId: "a" })).voiceId, space.id);
  assert.equal((await f.voice.rpc("credentials", { spaceId: "a" }))[0].voiceId, space.id);
  assert.equal((await f.voice.rpc("status", { spaceId: "b" })).voiceId, account.id);
});
