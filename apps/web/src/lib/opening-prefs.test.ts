import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FILE_OPEN_MODE_STORAGE_KEY,
  LINK_OPEN_MODE_STORAGE_KEY,
  getFileOpenMode,
  getLinkOpenMode,
  normalizeFileOpenMode,
  normalizeLinkOpenMode,
  setFileOpenMode,
  setLinkOpenMode,
} from "./opening-prefs";

afterEach(() => {
  vi.unstubAllGlobals();
  setFileOpenMode("preview");
  setLinkOpenMode("system");
});

describe("opening preferences", () => {
  it("defaults to the system browser and to previewing in the app", () => {
    expect(LINK_OPEN_MODE_STORAGE_KEY).toBe("rakazo.linkOpenMode");
    expect(FILE_OPEN_MODE_STORAGE_KEY).toBe("rakazo.fileOpenMode");
    expect(normalizeLinkOpenMode(null)).toBe("system");
    expect(normalizeLinkOpenMode("in-app")).toBe("in-app");
    expect(normalizeLinkOpenMode("popup")).toBe("system");
    expect(normalizeFileOpenMode(null)).toBe("preview");
    expect(normalizeFileOpenMode("system")).toBe("system");
  });

  it("tells the shell which window should take the next link", () => {
    const setMode = vi.fn(async () => undefined);
    vi.stubGlobal("window", { rakazoDesktop: { links: { setMode } } });
    setLinkOpenMode("in-app");
    expect(getLinkOpenMode()).toBe("in-app");
    expect(setMode).toHaveBeenCalledWith("in-app");
  });

  it("keeps the file choice on this device when there is no shell", () => {
    vi.stubGlobal("localStorage", undefined);
    setFileOpenMode("system");
    expect(getFileOpenMode()).toBe("system");
  });
});
