import { describe, expect, it, vi } from "vitest";
import { backfillMemorySearch } from "./memory-search-backfill.js";

describe("derived memory index backfill", () => {
  it("only writes derived fields, guarded by the source ciphertext and revision", async () => {
    const $queryRaw = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "d", userId: "u", spaceId: "s", content: "rkz1:cipher", revision: 7 },
        { id: "raced", userId: "u", spaceId: "s", content: "rkz1:other", revision: 2 },
      ])
      .mockResolvedValue([]);
    const $executeRaw = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const memoryIndexTokens = vi.fn().mockResolvedValue([42]);
    const encryption = {
      ring: { encryptWrites: true },
      openRows: vi.fn(async (_model, rows) =>
        rows.map((row: object) => ({ ...row, content: "plain" })),
      ),
      memoryIndexTokens,
    };
    const result = await backfillMemorySearch({
      $queryRaw,
      $executeRaw,
      $contentEncryption: () => encryption,
    } as never);
    expect(result).toEqual({ indexed: 1, conflicts: 1 });
    const sql = $executeRaw.mock.calls[0]![0];
    const set = sql.text.split("WHERE")[0];
    expect(set).toContain('"searchTokens"');
    expect(set).not.toContain("content =");
    expect(set).not.toContain("updatedAt");
    expect(set).not.toContain("revision =");
    expect(sql.text).toContain("AND content =");
    expect(sql.values).toContain("rkz1:cipher");
    expect(sql.values).not.toContain("plain");
    expect(memoryIndexTokens).toHaveBeenCalledWith("s", "plain");
  });
});
