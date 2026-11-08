import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DataKey } from "./content-crypto.js";
import { memorySearchTokens } from "./memory-search.js";

const key: DataKey = { id: "k", spaceId: "s", version: 1, key: randomBytes(32) };
describe("memory substring blind index", () => {
  it.each([
    ["月结导账流程", "导账"],
    ["月结导账流程", "账"],
    ["CaseSensitive configuration", "sensi"],
    ["ＡＢＣ １２３", "bc 12"],
    ["emoji 😀 evidence", "😀"],
    ["A multiline\nentry", "line\nen"],
  ])("retains candidates for %j / %j", (content, query) => {
    const tokens = new Set(memorySearchTokens(key, content));
    expect(memorySearchTokens(key, query, true).every((token) => tokens.has(token))).toBe(true);
  });
  it("isolates keys and removes repeated ngrams", () => {
    expect(memorySearchTokens(key, "导账")).not.toEqual(
      memorySearchTokens({ ...key, key: randomBytes(32) }, "导账"),
    );
    expect(memorySearchTokens(key, "aaaa")).toEqual(memorySearchTokens(key, "aa"));
  });
});
