// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { readBotVoicePreferences, writeBotVoicePreferences } from "./voice-assistant-pref";

beforeEach(() => localStorage.clear());

it("defaults every bot to off even when the legacy global switch was on", () => {
  localStorage.setItem("rakazo:voice-wake", "1");
  localStorage.setItem("rakazo:voice-announce", "1");
  expect(readBotVoicePreferences("a")).toEqual({
    wakeEnabled: false,
    notifyEnabled: false,
    aliases: [],
  });
});

it("stores independent bot switches and aliases without changing other bots", () => {
  writeBotVoicePreferences("a", { wakeEnabled: true, notifyEnabled: false, aliases: ["小哭"] });
  writeBotVoicePreferences("b", { wakeEnabled: false, notifyEnabled: true, aliases: [] });
  expect(readBotVoicePreferences("a")).toEqual({
    wakeEnabled: true,
    notifyEnabled: false,
    aliases: ["小哭"],
  });
  expect(readBotVoicePreferences("b").wakeEnabled).toBe(false);
  expect(readBotVoicePreferences("b").notifyEnabled).toBe(true);
});
