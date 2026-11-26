import { describe, expect, it } from "vitest";
import { CHAT_COLUMN_PADDING, CHAT_WIDTH_MEASURE } from "./transcript-layout.js";

const rem = (value: string) => Number.parseFloat(value) * 16;

describe("chat column measure", () => {
  it("keeps the default inside a readable line length", () => {
    const perCharacter = 14;
    expect(rem(CHAT_WIDTH_MEASURE.default) / perCharacter).toBeGreaterThanOrEqual(44);
    expect(rem(CHAT_WIDTH_MEASURE.default) / perCharacter).toBeLessThanOrEqual(56);
  });

  it("brackets the default with a narrower and a wider column", () => {
    expect(rem(CHAT_WIDTH_MEASURE.narrow)).toBeLessThan(rem(CHAT_WIDTH_MEASURE.default));
    expect(rem(CHAT_WIDTH_MEASURE.wide)).toBeGreaterThan(rem(CHAT_WIDTH_MEASURE.default));
  });

  it("puts the transcript and the composer on the same class", () => {
    // The measure itself lives in the stylesheet so the width setting can move it at runtime.
    expect(CHAT_COLUMN_PADDING).toBe("rk-chat-column");
  });
});
