import { realpath, stat } from "node:fs/promises";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openLocalMessageFile } from "./local-message-file.js";

vi.mock("node:fs/promises", () => ({
  realpath: vi.fn(async (path) => path),
  stat: vi.fn(async () => ({ isFile: () => true })),
}));
const path = "/Users/test/财务 报告.docx";
function fixture() {
  const open = vi.fn(async () => {});
  const findFirst = vi.fn(async () => ({ blocks: [{ kind: "text", text: `MEDIA:${path}` }] }));
  return {
    open,
    findFirst,
    deps: {
      open,
      prisma: { message: { findFirst } } as unknown as PrismaClient,
      localHost: true,
      platform: "darwin",
    },
  };
}
describe("local message file actions", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["open", "reveal"] as const)(
    "%s uses an owned message's referenced document",
    async (action) => {
      const { deps, open, findFirst } = fixture();
      await expect(
        openLocalMessageFile(deps, "thread-1", { messageId: "message-1", path, action }),
      ).resolves.toEqual({ ok: true });
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "message-1", threadId: "thread-1", role: "bot" } }),
      );
      expect(open).toHaveBeenCalledWith(path, action);
    },
  );
  it("rejects an unreferenced path without opening anything", async () => {
    const { deps, open } = fixture();
    await expect(
      openLocalMessageFile(deps, "thread-1", {
        messageId: "message-1",
        path: "/Users/test/other.pdf",
        action: "open",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(open).not.toHaveBeenCalled();
  });
  it("rejects missing files and symlinks to executable targets", async () => {
    const { deps, open } = fixture();
    vi.mocked(realpath).mockRejectedValueOnce(new Error("missing"));
    await expect(
      openLocalMessageFile(deps, "thread-1", { messageId: "message-1", path, action: "open" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    vi.mocked(realpath).mockResolvedValueOnce("/Users/test/run.command");
    await expect(
      openLocalMessageFile(deps, "thread-1", { messageId: "message-1", path, action: "open" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(open).not.toHaveBeenCalled();
  });
  it("does not open files on a remote server", async () => {
    const { deps, open, findFirst } = fixture();
    await expect(
      openLocalMessageFile({ ...deps, localHost: false }, "thread-1", {
        messageId: "message-1",
        path,
        action: "open",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(open).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });
});
