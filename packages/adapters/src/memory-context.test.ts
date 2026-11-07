import type { AdapterContext, MemorySnapshot, MemoryStore } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
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

    // A bot summary is append-only, so the newest facts sit at the end and survive the cut.
    expect(result).toContain("NEWEST FACT");
    expect(result).not.toContain("HEAD MARKER");
    expect(result).toContain(`partly in context (200 of ${charLength(body)} chars)`);
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
    expect(result).toContain("partly in context (200 of 5000 chars)");
    expect(result).toContain("## bot: USER.md (revision 1)\nuser fact");
  });

  it("counts characters, not bytes, so Chinese fits as well as English", async () => {
    const body = `${"中".repeat(100)}${"🙂".repeat(100)}`;
    const result = await loadAgentMemoryContext(
      storeWith(readFrom([document("bot", "MEMORY.md", body, 1, "2026-08-15T12:00:00.000Z")])),
      "bot-1",
      context,
      { documentMaxChars: 60 },
    );

    const inlined = result!
      .split("## bot: MEMORY.md (revision 1)\n")[1]!
      .split("\n</durable_memory>")[0]!;
    expect(charLength(inlined)).toBe(60);
    expect(result).not.toContain("�");
  });

  it("carries the budgets the prompt specification names", () => {
    expect(MEMORY_DOCUMENT_MAX_CHARS).toBe(20_000);
    expect(MEMORY_TOTAL_MAX_CHARS).toBe(60_000);
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
