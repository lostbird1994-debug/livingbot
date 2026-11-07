import type { MemorySnapshot } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { memoryTools } from "./run-tools-memory.js";

const summary = "alpha ".repeat(10).trim();
const documents: MemorySnapshot["documents"] = [
  {
    id: "1",
    path: "MEMORY.md",
    content: summary,
    revision: 3,
    updatedAt: "2026-08-15T12:00:00.000Z",
  },
  {
    id: "2",
    path: "memory/notes.md",
    content: "beta detail",
    revision: 1,
    updatedAt: "2026-08-14T12:00:00.000Z",
  },
];
const userDocuments: MemorySnapshot["documents"] = [
  {
    id: "3",
    path: "profile.md",
    content: "gamma profile",
    revision: 1,
    updatedAt: "2026-08-16T12:00:00.000Z",
  },
];

function setup(secrets: string[] = []) {
  const read = vi.fn(
    async ({ scope, path }: { scope: "bot" | "user"; path?: string }): Promise<MemorySnapshot> => {
      const source = scope === "bot" ? documents : userDocuments;
      return { documents: path ? source.filter((entry) => entry.path === path) : source };
    },
  );
  const search = vi.fn(async ({ scope }: { scope: "bot" | "user" | "all" }) =>
    scope === "bot"
      ? [{ path: "memory/notes.md", snippet: "beta detail", score: 1 }]
      : [{ path: "profile.md", snippet: "gamma profile", score: 0.5 }],
  );
  const commit = vi.fn(
    async ({
      path,
      content,
      expectedRevision,
    }: {
      path: string;
      content: string;
      expectedRevision: number;
    }) => ({
      id: "doc",
      path,
      content,
      revision: expectedRevision + 1,
    }),
  );
  const context = {
    deps: { memory: { read, search, commit } },
    bot: { id: "bot-1" },
    thread: { id: "thread-1" },
    runId: "run-1",
    context: {},
    secrets,
  } as unknown as RunContext;
  const call = (name: string, args: Record<string, unknown>) =>
    ({
      name,
      args,
      finish: async (result: unknown) => result,
    }) as unknown as ToolCall;
  return { context, call, read, search, commit };
}

describe("read_memory", () => {
  it("returns one document and reports where to continue", async () => {
    const { context, call } = setup();

    const result = (await memoryTools.read_memory!(
      context,
      call("read_memory", {
        path: "MEMORY.md",
        max_chars: 20,
      }),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      path: "MEMORY.md",
      scope: "bot",
      revision: 3,
      totalChars: summary.length,
      offset: 0,
      truncated: true,
      nextOffset: 20,
    });
    expect(result.content).toBe(summary.slice(0, 20));
  });

  it("continues from nextOffset until the document ends", async () => {
    const { context, call } = setup();

    const result = (await memoryTools.read_memory!(
      context,
      call("read_memory", {
        path: "MEMORY.md",
        offset: 50,
        max_chars: 100,
      }),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ offset: 50, truncated: false });
    expect(result.content).toBe(summary.slice(50));
    expect(result.nextOffset).toBeUndefined();
  });

  it("accepts a path typed in another case and points at the real one", async () => {
    const { context, call } = setup();

    const result = (await memoryTools.read_memory!(
      context,
      call("read_memory", {
        path: "memory.md",
      }),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ path: "MEMORY.md", scope: "bot" });
    expect(result.content).toBe(summary);
  });

  it("lists what does exist when the path is wrong", async () => {
    const { context, call } = setup();

    const result = (await memoryTools.read_memory!(
      context,
      call("read_memory", {
        path: "nope.md",
      }),
    )) as Record<string, unknown>;

    expect(result.error).toBe('No memory document at "nope.md".');
    expect(result.paths).toEqual(["user:profile.md", "bot:MEMORY.md", "bot:memory/notes.md"]);
  });

  it("redacts a stored credential before returning text", async () => {
    const { context, call } = setup(["alpha"]);

    const result = (await memoryTools.read_memory!(
      context,
      call("read_memory", {
        path: "MEMORY.md",
      }),
    )) as Record<string, unknown>;

    expect(result.content).toContain("[redacted]");
    expect(result.content).not.toContain("alpha");
  });
});

describe("write_memory", () => {
  it("rewrites a document at the revision that was read", async () => {
    const { context, call, commit } = setup();

    const result = (await memoryTools.write_memory!(
      context,
      call("write_memory", {
        path: "MEMORY.md",
        content: "condensed",
        expected_revision: 3,
      }),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, path: "MEMORY.md", revision: 4, chars: 9 });
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ path: "MEMORY.md", content: "condensed", expectedRevision: 3 }),
      expect.anything(),
    );
  });

  it("refuses to overwrite a document that moved on", async () => {
    const { context, call, commit } = setup();

    const result = (await memoryTools.write_memory!(
      context,
      call("write_memory", {
        path: "MEMORY.md",
        content: "stale rewrite",
        expected_revision: 2,
      }),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ revision: 3 });
    expect(String(result.error)).toContain("changed since you read it");
    expect(commit).not.toHaveBeenCalled();
  });

  it("refuses to blank a document", async () => {
    const { context, call, commit } = setup();

    const result = (await memoryTools.write_memory!(
      context,
      call("write_memory", {
        path: "MEMORY.md",
        content: "   ",
        expected_revision: 3,
      }),
    )) as Record<string, unknown>;

    expect(String(result.error)).toContain("erase");
    expect(commit).not.toHaveBeenCalled();
  });

  it("creates a document that does not exist yet", async () => {
    const { context, call } = setup();

    const result = (await memoryTools.write_memory!(
      context,
      call("write_memory", {
        path: "memory/2026-11.md",
        content: "November notes",
      }),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, path: "memory/2026-11.md", revision: 1 });
  });
});

describe("search_memory", () => {
  it("searches both scopes and orders by score", async () => {
    const { context, call } = setup();

    const result = (await memoryTools.search_memory!(
      context,
      call("search_memory", {
        query: "detail",
      }),
    )) as { matches: number; results: Array<Record<string, unknown>> };

    expect(result.matches).toBe(2);
    expect(result.results.map((hit) => [hit.scope, hit.path])).toEqual([
      ["bot", "memory/notes.md"],
      ["user", "profile.md"],
    ]);
  });

  it("refuses an empty query", async () => {
    const { context, call } = setup();

    expect(
      await memoryTools.search_memory!(context, call("search_memory", { query: "  " })),
    ).toEqual({ error: "query is required." });
  });
});
