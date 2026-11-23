// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { BotVoicePreferences } from "./voice-assistant-pref";

let prefs: typeof import("./voice-assistant-pref");
const enabled: BotVoicePreferences = {
  wakeEnabled: true, notifyEnabled: true, aliases: ["小蓝"],
};

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  prefs = await import("./voice-assistant-pref");
});

it("defaults every bot to off even when the legacy global switch was on", () => {
  localStorage.setItem("rakazo:voice-wake", "1");
  localStorage.setItem("rakazo:voice-announce", "1");
  expect(prefs.readBotVoicePreferences("a")).toEqual({
    wakeEnabled: false,
    notifyEnabled: false,
    aliases: [],
  });
});

it("stores independent bot switches and aliases without changing other bots", () => {
  prefs.writeBotVoicePreferences("a", { wakeEnabled: true, notifyEnabled: false, aliases: ["小蓝"] });
  prefs.writeBotVoicePreferences("b", { wakeEnabled: false, notifyEnabled: true, aliases: [] });
  expect(prefs.readBotVoicePreferences("a")).toEqual({
    wakeEnabled: true,
    notifyEnabled: false,
    aliases: ["小蓝"],
  });
  expect(prefs.readBotVoicePreferences("b").wakeEnabled).toBe(false);
  expect(prefs.readBotVoicePreferences("b").notifyEnabled).toBe(true);
});

it("restores both bots from existing preferences after a restart with empty origin storage", async () => {
  let stored: Record<string, unknown> = { id: "preferences", avatarStyle: "emoji" };
  const save = vi.fn(async (patch: Record<string, BotVoicePreferences>) => {
    stored = { ...stored, ...patch };
  });
  prefs.hydrateBotVoicePreferences(stored, save);
  await prefs.writeBotVoicePreferences("a", enabled);
  await prefs.writeBotVoicePreferences("b", { ...enabled, wakeEnabled: false, aliases: [] });
  expect(save).toHaveBeenNthCalledWith(1, { "rakazo:bot-voice:a": enabled });
  expect(save).toHaveBeenNthCalledWith(2, {
    "rakazo:bot-voice:b": { ...enabled, wakeEnabled: false, aliases: [] },
  });
  expect(stored.avatarStyle).toBe("emoji");

  // A different loopback port has fresh origin storage but uses the same backend.
  localStorage.clear();
  vi.resetModules();
  const restarted = await import("./voice-assistant-pref");
  restarted.hydrateBotVoicePreferences(stored, save);
  expect(restarted.readBotVoicePreferences("a")).toEqual(enabled);
  expect(restarted.readBotVoicePreferences("b")).toEqual({
    ...enabled, wakeEnabled: false, aliases: [],
  });
});

it("keeps persisted off values authoritative over stale origin storage", () => {
  localStorage.setItem("rakazo:bot-voice:a", JSON.stringify(enabled));
  const save = vi.fn(async () => undefined);
  prefs.hydrateBotVoicePreferences({
    "rakazo:bot-voice:a": { wakeEnabled: false, notifyEnabled: false, aliases: [] },
  }, save);
  expect(prefs.readBotVoicePreferences("a").notifyEnabled).toBe(false);
  expect(save).not.toHaveBeenCalled();
});

it("does not implicitly import old origin values while hydrating", () => {
  localStorage.setItem("rakazo:bot-voice:a", JSON.stringify(enabled));
  const save = vi.fn(async () => undefined);
  prefs.hydrateBotVoicePreferences({ id: "preferences" }, save);
  expect(prefs.readBotVoicePreferences("a")).toEqual(enabled);
  expect(save).not.toHaveBeenCalled();
});

it("rejects failed durable writes without changing switches or emitting success", async () => {
  prefs.hydrateBotVoicePreferences({}, async () => { throw new Error("Unavailable"); });
  const changed = vi.fn();
  const unsubscribe = prefs.subscribeVoiceAssistantPrefs(changed);
  await expect(prefs.writeBotVoicePreferences("a", enabled)).rejects.toThrow("Unavailable");
  expect(prefs.readBotVoicePreferences("a").notifyEnabled).toBe(false);
  expect(localStorage.getItem("rakazo:bot-voice:a")).toBeNull();
  expect(changed).not.toHaveBeenCalled();
  unsubscribe();
});

it("notifies live consumers when bootstrap hydrates persisted preferences", () => {
  const changed = vi.fn();
  const unsubscribe = prefs.subscribeVoiceAssistantPrefs(changed);
  const before = prefs.voicePreferencesRevision();
  prefs.hydrateBotVoicePreferences({ "rakazo:bot-voice:a": enabled }, async () => undefined);
  expect(changed).toHaveBeenCalledOnce();
  expect(prefs.voicePreferencesRevision()).toBeGreaterThan(before);
  expect(prefs.readBotVoicePreferences("a")).toEqual(enabled);
  unsubscribe();
});

it("keeps a successful durable write usable when the origin cache is unavailable", async () => {
  const save = vi.fn(async () => undefined);
  prefs.hydrateBotVoicePreferences({}, save);
  const cache = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  try {
    await prefs.writeBotVoicePreferences("a", enabled);
    expect(save).toHaveBeenCalledWith({ "rakazo:bot-voice:a": enabled });
    expect(prefs.readBotVoicePreferences("a")).toEqual(enabled);
  } finally {
    cache.mockRestore();
  }
});
