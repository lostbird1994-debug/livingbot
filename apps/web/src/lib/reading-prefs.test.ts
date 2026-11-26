import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_TEXT_SIZE_STORAGE_KEY,
  CHAT_WIDTH_STORAGE_KEY,
  getAppTextSize,
  getChatWidth,
  normalizeAppTextSize,
  normalizeChatWidth,
  setAppTextSize,
  setChatWidth,
  subscribeReadingPrefs,
} from "./reading-prefs";
import { CHAT_WIDTH_MEASURE } from "./transcript-layout";

afterEach(() => {
  vi.unstubAllGlobals();
  setAppTextSize("default");
  setChatWidth("default");
});

describe("reading preferences", () => {
  it("accepts only the sizes and widths the settings offer", () => {
    expect(APP_TEXT_SIZE_STORAGE_KEY).toBe("rakazo.appTextSize");
    expect(CHAT_WIDTH_STORAGE_KEY).toBe("rakazo.chatWidth");
    expect(normalizeAppTextSize("largest")).toBe("largest");
    expect(normalizeAppTextSize("huge")).toBe("default");
    expect(normalizeChatWidth("wide")).toBe("wide");
    expect(normalizeChatWidth("wider")).toBe("default");
  });

  it("moves the conversation column through the shared CSS variable", () => {
    const setProperty = vi.fn();
    vi.stubGlobal("document", { documentElement: { style: { setProperty } } });
    setChatWidth("wide");
    expect(getChatWidth()).toBe("wide");
    expect(setProperty).toHaveBeenCalledWith("--rk-chat-measure", CHAT_WIDTH_MEASURE.wide);
  });

  it("tells the page when a reading preference changes", () => {
    const seen = vi.fn();
    const stop = subscribeReadingPrefs(seen);
    setAppTextSize("large");
    expect(getAppTextSize()).toBe("large");
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
    setAppTextSize("small");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("does nothing to a browser that has no shell to zoom", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => setAppTextSize("largest")).not.toThrow();
    expect(getAppTextSize()).toBe("largest");
  });
});
