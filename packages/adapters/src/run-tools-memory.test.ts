import type { MemorySnapshot } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { serializeToolResult } from "./pi-runtime-tools.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";
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
    source: { messagingChannelRun: false },
  } as unknown as RunContext;
  const call = (name: string, args: Record<string, unknown>) =>
    ({
      name,
      args,
      finish: async (result: unknown) => result,
    }) as unknown as ToolCall;
  return { context, call, read, search, commit };
}

describe("save_shared_memory", () => {
  it.each([
    { path: "user:profile.md", content: "new profile" },
    { path: "profile.md", content: " \n ", expected_revision: 1 },
  ])("rejects unsafe replacement arguments: %j", async (args) => {
    const { context, call, commit } = setup();
    await expect(
      memoryTools.save_shared_memory!(context, call("save_shared_memory", args)),
    ).resolves.toHaveProperty("error");
    expect(commit).not.toHaveBeenCalled();
  });

  it("writes the canonical shared path with the revision the caller read", async () => {
    const { context, call, commit } = setup();
    await memoryTools.save_shared_memory!(
      context,
      call("save_shared_memory", {
        path: "USER:PROFILE.MD",
        content: "new profile",
        expected_revision: 1,
      }),
    );
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "user", path: "profile.md", expectedRevision: 1 }),
      expect.anything(),
    );
  });
});

describe("restricted consolidation", () => {
  it.each(["memory/reviews/1.v3.md", "bot:./MEMORY/REVIEWS/1.v3.md"])(
    "reserves proposal writes and reads from ordinary agent tools: %s",
    async (path) => {
      const { context, call, commit, read } = setup();
      await expect(
        memoryTools.write_memory!(
          context,
          call("write_memory", {
            path,
            content: "replacement",
            expected_revision: 0,
          }),
        ),
      ).resolves.toHaveProperty("error");
      await expect(
        memoryTools.read_memory!(context, call("read_memory", { path })),
      ).resolves.toHaveProperty("error");
      expect(commit).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("omits review snapshots from browsing and tool search", async () => {
    const { context, call, read, search } = setup();
    const review = { ...documents[0]!, path: "memory/reviews/1.v3.md" };
    read.mockResolvedValue({ documents: [documents[0]!, review] });
    search.mockResolvedValue([{ path: review.path, snippet: "obsolete", score: 10 }]);
    const directory = await memoryTools.read_memory!(context, call("read_memory", { path: "" }));
    expect(JSON.stringify(directory)).not.toContain(review.path);
    expect(
      await memoryTools.search_memory!(context, call("search_memory", { query: "obsolete" })),
    ).toMatchObject({ matches: 0, results: [] });
  });
  it("requires complete paginated reading before saving an immutable review document", async () => {
    const { context, call, read, commit } = setup();
    context.source.memoryMaintenance = true;
    const source = {
      ...documents[0]!,
      content: "# Summary\nCurrent rule\nOld detail\nMore detail",
    };
    read.mockImplementation(async ({ scope, path }) => ({
      documents: scope === "bot" && (!path || path === source.path) ? [source] : [],
    }));
    const args = {
      path: source.path,
      expected_revision: 3,
      keep_ranges: [{ start_line: 1, end_line: 2 }],
    };
    await expect(
      memoryTools.propose_memory_consolidation!(
        context,
        call("propose_memory_consolidation", args),
      ),
    ).resolves.toHaveProperty("error");
    expect(commit).not.toHaveBeenCalled();
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = (await memoryTools.read_memory!(
        context,
        call("read_memory", {
          path: source.path,
          offset,
          max_chars: 10,
        }),
      )) as { nextOffset?: number };
      offset = page.nextOffset;
    }
    await expect(
      memoryTools.propose_memory_consolidation!(
        context,
        call("propose_memory_consolidation", args),
      ),
    ).resolves.toMatchObject({ status: "proposed", sourceUnchanged: true });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "memory/reviews/1.v3.md",
        expectedRevision: 0,
        content: expect.stringContaining("> Old detail\n> More detail"),
      }),
      expect.anything(),
    );
  });
});

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
    expect(result.hint).toContain('read_memory(path="")');
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

describe("memory read boundaries", () => {
  it("reads scope-qualified shared paths even when bot memory has the same name", async () => {
    const { context, call, read } = setup();
    read.mockImplementation(async ({ scope, path }) => ({
      documents:
        path === "MEMORY.md"
          ? [
              {
                ...documents[0]!,
                content: scope === "user" ? "shared text" : "private text",
              },
            ]
          : [],
    }));
    const result = await memoryTools.read_memory!(
      context,
      call("read_memory", { path: "user:MEMORY.md" }),
    );
    expect(result).toMatchObject({ scope: "user", content: "shared text" });
  });

  it("browses omitted documents with a bounded, resumable directory listing", async () => {
    const { context, call, read } = setup();
    read.mockImplementation(async ({ scope }) => ({
      documents:
        scope === "user"
          ? []
          : Array.from({ length: 25 }, (_, index) => ({
              ...documents[0]!,
              path: `memory/${String(index).padStart(2, "0")}.md`,
            })),
    }));
    const first = (await memoryTools.read_memory!(
      context,
      call("read_memory", { path: "bot:memory/" }),
    )) as {
      entries: unknown[];
      nextOffset: number;
    };
    const next = (await memoryTools.read_memory!(
      context,
      call("read_memory", {
        path: "bot:memory/",
        offset: first.nextOffset,
      }),
    )) as { entries: unknown[] };
    expect(first.entries).toHaveLength(20);
    expect(next.entries).toHaveLength(5);
  });

  it.each(["current", "cache-aware"] as const)(
    "delivers every redacted character through %s serialization",
    async (strategy) => {
      const { context, call, read } = setup(["super-secret"]);
      const content = `${'中🙂\\"\n'.repeat(2_000)}super-secret${"z".repeat(15_000)}`;
      read.mockResolvedValue({ documents: [{ ...documents[0]!, content }] });
      let offset = 0;
      let collected = "";
      for (let page = 0; page < 50; page += 1) {
        const result = await memoryTools.read_memory!(
          context,
          call("read_memory", {
            path: "MEMORY.md",
            offset,
          }),
        );
        const serialized = serializeToolResult(result, strategy, "read_memory", {});
        expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(11_000);
        const delivered = JSON.parse(serialized);
        collected += delivered.content;
        if (delivered.nextOffset === undefined) break;
        expect(delivered.nextOffset).toBeGreaterThan(offset);
        offset = delivered.nextOffset;
      }
      expect(collected).toBe(content.replace("super-secret", "[redacted]"));
    },
  );
});

describe("write_memory", () => {
  it("requires the caller's revision for an existing document", async () => {
    const { context, call, commit } = setup();
    const result = await memoryTools.write_memory!(
      context,
      call("write_memory", {
        path: "MEMORY.md",
        content: "stale draft",
      }),
    );
    expect(result).toHaveProperty("error");
    expect(commit).not.toHaveBeenCalled();
  });

  it("does not create an alias when rewriting a normalized path", async () => {
    const { context, call, commit } = setup();
    await memoryTools.write_memory!(
      context,
      call("write_memory", {
        path: "bot:./memory.md",
        content: "updated",
        expected_revision: 3,
      }),
    );
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ path: "MEMORY.md" }),
      expect.anything(),
    );
  });

  it("rejects writes to shared scope", async () => {
    const { context, call, commit } = setup();
    expect(
      await memoryTools.write_memory!(
        context,
        call("write_memory", {
          path: "user:MEMORY.md",
          content: "wrong scope",
          expected_revision: 3,
        }),
      ),
    ).toHaveProperty("error");
    expect(commit).not.toHaveBeenCalled();
  });
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

describe("private memory execution gate", () => {
  it.each(["read_memory", "search_memory", "write_memory", "remember", "save_shared_memory"])(
    "rejects %s even if a channel calls it through a replay or deferred route",
    async (name) => {
      const context = { source: { messagingChannelRun: true } } as RunContext;
      const result = await gateToolCall(context, { name } as ToolRequest, undefined);
      expect(result).toMatchObject({
        result: { error: expect.stringContaining("messaging channels") },
      });
    },
  );
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
