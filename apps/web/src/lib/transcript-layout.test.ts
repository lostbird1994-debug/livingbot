import { describe, expect, it } from "vitest";
import { CHAT_COLUMN_MEASURE, CHAT_COLUMN_PADDING } from "./transcript-layout.js";

describe("chat column measure", () => {
  it("stays inside a readable line length", () => {
    const width = Number.parseFloat(CHAT_COLUMN_MEASURE) * 16;
    expect(width / 14).toBeGreaterThanOrEqual(44);
    expect(width / 14).toBeLessThanOrEqual(56);
  });

  it("puts the transcript and the composer on the same gutter", () => {
    expect(CHAT_COLUMN_PADDING).toContain(CHAT_COLUMN_MEASURE);
    expect(CHAT_COLUMN_PADDING).toContain("max(1rem");
  });
});
