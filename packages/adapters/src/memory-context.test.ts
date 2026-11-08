import type { AdapterContext, MemorySnapshot, MemoryStore } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { estimateTextTokens } from "./context-selection.js";
import {
  loadAgentMemoryContext,
  MEMORY_DOCUMENT_MAX_CHARS,
  MEMORY_TOTAL_MAX_CHARS,
} from "./memory-context.js";
import { charLength } from "./utf8.js";

const context: AdapterContext = {
  operationId: "run-1",
  traceId: "run-1",
  spaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  runId: "run-1",
  signal: new AbortController().signal,
};

describe("agent memory context", () => {
  it("keeps proposal snapshots out of agent context and directory counts", async () => {
    const result = await loadAgentMemoryContext(
      storeWith(
        readFrom([
          document("source", "MEMORY.md", "current fact", 1, "2026-11-07"),
          document("review", "memory/reviews/source.v1.md", "obsolete fact", 1, "2026-11-08"),
        ]),
      ),
      "bot-1",
      context,
    );
    expect(result).toContain("current fact");
    expect(result).not.toContain("obsolete fact");
    expect(result).not.toContain("memory/reviews/");
  });
  it("inlines the summary and the profile, and lists everything else", async () => {
    const result = await loadAgentMemoryContext(storeWith(pairRead), "bot-1", context);

    // User documents come first, because the harness this replaces loaded the profile before
    // the memory summary.
    expect(result).toContain("## user: profile.md (revision 1)\nuser fact");
    expect(result).toContain("## bot: MEMORY.md (revision 2)\nsummary fact");
    expect(result!.indexOf("user fact")).toBeLessThan(result!.indexOf("summary fact"));

    // Daily notes are listed rather than inlined: reading every one of them would crowd out
    // the summary as soon as a bot kept notes.
    expect(result).not.toContain("daily detail");
    expect(result).toContain("<memory_index>");
    expect(result).toContain("- bot:memory/notes.md — 12 chars, not in context");
    // The index follows the inlined block; the preamble merely mentions the tag.
    expect(result!.indexOf("\n</durable_memory>")).toBeLessThan(
      result!.lastIndexOf("<memory_index>"),
    );
  });

  it("caps one document and says how much of it was inlined", async () => {
    const body = `HEAD MARKER\n${"old line\n".repeat(200)}NEWEST FACT`;
    const result = await loadAgentMemoryContext(
      storeWith(
        readFrom([
          document("bot", "MEMORY.md", body, 3, "2026-08-15T12:00:00.000Z"),
          document("notes", "memory/notes.md", "daily detail", 1, "2026-08-14T12:00:00.000Z"),
        ]),
      ),
      "bot-1",
      context,
      { documentMaxChars: 200 },
    );

    expect(result).toContain("HEAD MARKER");
    expect(result).not.toContain("NEWEST FACT");
    expect(result).toContain(
      `partly in context (200 of ${charLength(body)} chars, beginning only; read full text before rewriting)`,
    );
    // The daily note is still listed instead of being dropped.
    expect(result).toContain("memory/notes.md");
  });

  it("keeps inlining after one document is cut short", async () => {
    const result = await loadAgentMemoryContext(
      storeWith(
        readFrom([
          // Newest first, so the document that overflows is read before the small one.
          document("bot", "MEMORY.md", "x".repeat(5_000), 2, "2026-08-16T12:00:00.000Z"),
          document("user", "USER.md", "user fact", 1, "2026-08-15T12:00:00.000Z"),
        ]),
      ),
      "bot-1",
      context,
      { documentMaxChars: 200 },
    );

    // The old reader stopped at the first document it had to cut, so everything after it was
    // lost without a word. A cut document must not end the pass.
    expect(result).toContain("partly in context (200 of 5000 chars,");
    expect(result).toContain("## bot: USER.md (revision 1)\nuser fact");
  });

  it("counts characters, not bytes, so Chinese fits as well as English", async () => {
    const body = `${"🙂".repeat(100)}${"中".repeat(100)}`;
    const result = await loadAgentMemoryContext(
      storeWith(readFrom([document("bot", "MEMORY.md", body, 1, "2026-08-15T12:00:00.000Z")])),
      "bot-1",
      context,
      { documentMaxChars: 60 },
    );

    const inlined = result!
      .split("## bot: MEMORY.md (revision 1)\n")[1]!
      .split("\n[Partial memory.")[0]!;
    expect(charLength(inlined)).toBe(60);
    expect(result).not.toContain("�");
  });

  it("carries the budgets the prompt specification names", () => {
    expect(MEMORY_DOCUMENT_MAX_CHARS).toBe(20_000);
    expect(MEMORY_TOTAL_MAX_CHARS).toBe(60_000);
  });

  it("folds the documents past the recent list into one line per folder", async () => {
    const many = [
      document("summary", "MEMORY.md", "summary fact", 1, "2026-11-07T00:00:00.000Z"),
      ...Array.from({ length: 25 }, (_, index) =>
        document(
          `note-${index}`,
          `memory/note-${index}.md`,
          `fact ${index}`,
          index + 1,
          `2026-10-${String(25 - index).padStart(2, "0")}T00:00:00.000Z`,
        ),
      ),
    ];

    const result = await loadAgentMemoryContext(storeWith(readFrom(many)), "bot-1", context);
    const lines = result!.split("\n").filter((line) => line.startsWith("- "));

    // 20 named lines plus one folder roll-up: a fixed count would hide the archive forever.
    expect(lines).toHaveLength(22);
    expect(lines[0]).toContain("note-0.md");
    expect(lines[19]).toContain("note-19.md");
    expect(lines[20]).toBe("- bot:memory/ — 5 files, latest 2026-10-05");
    expect(lines[21]).toContain('read_memory(path="")');
  });

  it("keeps the folder roll-up when the index budget is too tight for every name", async () => {
    const many = Array.from({ length: 23 }, (_, index) =>
      document(
        `note-${index}`,
        index % 2 === 0 ? `memory/note-${index}.md` : `feishu/note-${index}.md`,
        `fact ${index}`,
        index + 1,
        `2026-10-${String(23 - index).padStart(2, "0")}T00:00:00.000Z`,
      ),
    );

    const result = await loadAgentMemoryContext(storeWith(readFrom(many)), "bot-1", context, {
      indexMaxChars: 200,
    });
    const lines = result!.split("\n").filter((line) => line.startsWith("- "));

    // Whole areas survive the trim; only individual names at the tail are dropped.
    expect(result).toContain('read_memory(path="")');
    expect(lines.length).toBeLessThan(20);
  });

  it("keeps omitted recent documents discoverable and tries shorter paths after a long one", async () => {
    const docs = [
      document("long", `memory/${"long-".repeat(900)}.md`, "detail", 1, "2026-11-07"),
      document("short", "other/short.md", "detail", 1, "2026-11-06"),
    ];
    const result = await loadAgentMemoryContext(storeWith(readFrom(docs)), "bot-1", context);
    expect(result).toContain("other/short.md");
    expect(result).toContain("- bot:memory/ — 1 files");
    expect(result).toContain(
      '2 documents not fully in context; browse all with read_memory(path="")',
    );
  });

  it("does not inline arbitrary shared archive documents", async () => {
    const store = storeWith(async ({ scope }) =>
      snapshot(
        scope === "user"
          ? [document("shared", "archive/workflow.md", "ARCHIVED DETAIL", 1, "2026-11-07")]
          : [],
      ),
    );
    const result = await loadAgentMemoryContext(store, "bot-1", context);
    expect(result).not.toContain("ARCHIVED DETAIL");
    expect(result).toContain("user:archive/workflow.md");
  });

  it("fits multilingual memory to the model token allowance without rereading the store", async () => {
    const read = vi.fn(
      readFrom([document("summary", "MEMORY.md", "定义🙂".repeat(20_000), 1, "2026-11-07")]),
    );
    const result = await loadAgentMemoryContext(storeWith(read), "bot-1", context, {
      maxTokens: 700,
    });
    expect(result).toBeTruthy();
    expect(estimateTextTokens(result!)).toBeLessThanOrEqual(700);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("omits the memory block when neither scope has documents", async () => {
    const read = vi.fn(async () => snapshot([]));

    await expect(
      loadAgentMemoryContext(storeWith(read), "bot-1", context),
    ).resolves.toBeUndefined();
  });
});

async function pairRead({ scope }: { scope: "bot" | "user" }) {
  return snapshot(
    scope === "bot"
      ? [
          document("bot", "MEMORY.md", "summary fact", 2, "2026-08-14T12:00:00.000Z"),
          document("notes", "memory/notes.md", "daily detail", 1, "2026-08-13T12:00:00.000Z"),
        ]
      : [document("user", "profile.md", "user fact", 1, "2026-08-15T12:00:00.000Z")],
  );
}

function readFrom(documents: MemorySnapshot["documents"]) {
  return async ({ scope }: { scope: "bot" | "user" }) =>
    snapshot(documents.filter((entry) => (entry.path === "profile.md") === (scope === "user")));
}

function document(id: string, path: string, content: string, revision: number, updatedAt: string) {
  return { id, path, content, revision, updatedAt };
}

function snapshot(documents: MemorySnapshot["documents"]): MemorySnapshot {
  return { documents };
}

function storeWith(read: MemoryStore["read"]): MemoryStore {
  return {
    describe: vi.fn<MemoryStore["describe"]>(),
    read,
    search: vi.fn<MemoryStore["search"]>(),
    commit: vi.fn<MemoryStore["commit"]>(),
    remove: vi.fn<MemoryStore["remove"]>(),
    exportMarkdown: vi.fn<MemoryStore["exportMarkdown"]>(),
    importMarkdown: vi.fn<MemoryStore["importMarkdown"]>(),
  };
}
