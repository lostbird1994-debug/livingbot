import type { AdapterContext } from "@livingbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

const context: AdapterContext = {
  operationId: "read-memory",
  traceId: "read-memory",
  spaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("memory store contract shape", () => {
  it("excludes review snapshots from plaintext search while keeping explicit human reads", async () => {
    const rows = [
      {
        id: "source",
        path: "MEMORY.md",
        content: "current fact",
        revision: 1,
        updatedAt: new Date(),
      },
      {
        id: "review",
        path: "./MEMORY/REVIEWS/source.v1.md",
        content: "obsolete fact",
        revision: 1,
        updatedAt: new Date(),
      },
    ];
    const store = new MarkdownMemoryStore({
      memoryDocument: { findMany: vi.fn().mockResolvedValue(rows) },
    } as never);
    expect(await store.search({ scope: "bot", query: "obsolete" }, context)).toEqual([]);
    expect((await store.read({ scope: "bot" }, context)).documents).toHaveLength(2);
  });
  it("filters indexed candidates in SQL, then rejects false candidates after decryption", async () => {
    const $queryRaw = vi.fn().mockResolvedValue([
      { id: "1", path: "notes.md", content: "月度结账流程" },
      { id: "2", path: "collision.md", content: "unrelated" },
      { id: "3", path: "结账.md", content: "path match" },
    ]);
    const findMany = vi.fn();
    const encryption = {
      memorySearchTokens: vi.fn().mockResolvedValue([
        [1, 2],
        [3, 4],
      ]),
      openRows: vi.fn(async (_model, rows) => rows),
    };
    const store = new MarkdownMemoryStore({
      $queryRaw,
      $contentEncryption: () => encryption,
      memoryDocument: { findMany },
    } as never);
    const hits = await store.search({ query: "结账", scope: "bot", botId: "bot-1" }, context);
    expect(hits.map((hit) => hit.path)).toEqual(["结账.md", "notes.md"]);
    expect(findMany).not.toHaveBeenCalled();
    const sql = $queryRaw.mock.calls[0]![0];
    expect(sql.text).toContain('"searchTokens" @>');
    expect(sql.text).toContain('"searchTokensVersion" <>');
    expect(sql.text).toContain('m."userId" =');
    expect(sql.text).toContain('m."spaceId" =');
    expect(sql.text).toContain("NOT LIKE");
    expect(sql.values).toContain("memory/reviews/%");
    expect(sql.values).toEqual(
      expect.arrayContaining(["workspace-1", "user-1", "bot", "bot-1", [1, 2], [3, 4]]),
    );
    expect(encryption.memorySearchTokens).toHaveBeenCalledWith("workspace-1", "结账");
  });

  it("preserves original snippets when normalization changes character counts", async () => {
    const content = `${"ﬀ".repeat(150)}项目结账流程😀`;
    const store = new MarkdownMemoryStore({
      memoryDocument: {
        findMany: vi.fn().mockResolvedValue([{ id: "doc", path: "notes", content }]),
      },
    } as never);
    const result = await store.search({ query: "结账", scope: "bot" }, context);
    expect(result[0]!.snippet).toContain("项目结账流程😀");
    expect(result[0]!.snippet).toContain("ﬀ");
    expect(result[0]!.snippet.length).toBeLessThan(100);
  });

  it.each([false, true])(
    "preserves an unrecorded preimage before replacing a document (recorded: %s)",
    async (recorded) => {
      const existing = { id: "doc", path: "MEMORY.md", content: "original", revision: 3 };
      const create = vi.fn().mockResolvedValue({});
      const update = vi.fn().mockResolvedValue({ ...existing, content: "new text", revision: 4 });
      const tx = {
        memoryDocument: { findFirst: vi.fn().mockResolvedValue(existing), update },
        memoryRevision: {
          findUnique: vi.fn().mockResolvedValue(recorded ? { id: "old-revision" } : null),
          create,
        },
      };
      const $transaction = vi.fn(async (body: (client: typeof tx) => unknown) => body(tx));
      const store = new MarkdownMemoryStore({ $transaction } as never);
      await store.commit(
        {
          scope: "bot",
          botId: "bot-1",
          path: "MEMORY.md",
          content: "new text",
          expectedRevision: 3,
        },
        context,
      );
      expect(create).toHaveBeenCalledTimes(recorded ? 1 : 2);
      if (!recorded) {
        expect(create.mock.calls[0]![0]).toEqual({
          data: { documentId: "doc", revision: 3, content: "original" },
        });
        expect(create.mock.invocationCallOrder[0]).toBeLessThan(
          update.mock.invocationCallOrder[0]!,
        );
      }
      expect(create.mock.calls.at(-1)![0].data).toMatchObject({ revision: 4, content: "new text" });
    },
  );
  it("reads the most recently updated documents first", async () => {
    const updatedAt = new Date("2026-08-16T10:00:00.000Z");
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { id: "memory-1", path: "facts.md", content: "A fact", revision: 3, updatedAt },
      ]);
    const store = new MarkdownMemoryStore({ memoryDocument: { findMany } } as never);

    await expect(store.read({ scope: "bot", botId: "bot-1" }, context)).resolves.toEqual({
      documents: [
        {
          id: "memory-1",
          path: "facts.md",
          content: "A fact",
          revision: 3,
          updatedAt: updatedAt.toISOString(),
        },
      ],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "workspace-1",
        userId: "user-1",
        scope: "bot",
        botId: "bot-1",
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
  });

  it("removes one document by scope, bot and path inside the caller's space", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const store = new MarkdownMemoryStore({ memoryDocument: { deleteMany } } as never);
    await expect(
      store.remove(
        { id: "memory-9", scope: "bot", botId: "bot-1", path: "projects/retired.md" },
        context,
      ),
    ).resolves.toEqual({ removed: true });
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        id: "memory-9",
        spaceId: "workspace-1",
        userId: "user-1",
        scope: "bot",
        botId: "bot-1",
        path: "projects/retired.md",
      },
    });
  });

  it("returns false for a missing user document without touching bot memory", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const store = new MarkdownMemoryStore({ memoryDocument: { deleteMany } } as never);
    await expect(
      store.remove({ id: "missing", scope: "user", path: "projects/retired.md" }, context),
    ).resolves.toEqual({ removed: false });
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        id: "missing",
        spaceId: "workspace-1",
        userId: "user-1",
        scope: "user",
        botId: null,
        path: "projects/retired.md",
      },
    });
  });
});
