import type { MemoryStore } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  AUTOMATIC_MEMORY_PROMPT,
  enableAutomaticMemoryOrganization,
  memoryOrganizationStatus,
  nudgeMemoryOrganization,
  organizeMemoryDocument,
  ownsSharedMemoryOrganization,
} from "./memory-organization.js";

const source = {
  id: "source",
  path: "MEMORY.md",
  revision: 4,
  content: `# Current\nKeep this constraint\n${"Detailed old record ".repeat(100)}`,
  updatedAt: "2026-11-08T00:00:00Z",
};
const decision = {
  path: source.path,
  expected_revision: 4,
  keep_ranges: [{ start_line: 1, end_line: 2 }],
};
const context = {
  spaceId: "space",
  userId: "user",
  botId: "bot",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
};
const provenance = { runId: "run", threadId: "thread" };

function storeFixture() {
  const documents = new Map([[source.path, { ...source }]]);
  const read = vi.fn(async ({ path }) => ({
    documents: documents.has(path) ? [documents.get(path)!] : [],
  }));
  const commit = vi.fn(async ({ path, content, expectedRevision }) => {
    if ((documents.get(path)?.revision ?? 0) !== expectedRevision)
      throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
    const saved = { ...source, id: path, path, content, revision: expectedRevision + 1 };
    documents.set(path, saved);
    return saved;
  });
  return { documents, read, commit, store: { read, commit } as unknown as MemoryStore };
}

describe("automatic lossless memory organization", () => {
  it("verifies a complete source archive before changing the live version", async () => {
    const fixture = storeFixture();
    const result = await organizeMemoryDocument(
      fixture.store,
      source,
      decision,
      "bot",
      context,
      provenance,
    );
    expect(result).toMatchObject({
      status: "applied",
      revision: 5,
      archive: "bot:memory/archive/source.v4.md",
    });
    expect(fixture.documents.get("memory/archive/source.v4.md")?.content).toBe(source.content);
    expect(fixture.documents.get("MEMORY.md")?.content).toContain("Keep this constraint");
    expect(fixture.documents.get("MEMORY.md")?.content).toContain(
      "bot:memory/archive/source.v4.md",
    );
    expect(fixture.commit.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 0 });
    expect(fixture.commit.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 4 });
  });
  it("also organizes detailed notes without losing their original text", async () => {
    const fixture = storeFixture();
    const note = { ...source, path: "memory/topic.md" };
    fixture.documents.set(note.path, note);
    await organizeMemoryDocument(
      fixture.store,
      note,
      { ...decision, path: note.path },
      "bot",
      context,
      provenance,
    );
    expect(fixture.documents.get(note.path)?.revision).toBe(5);
    expect(fixture.documents.get("memory/archive/source.v4.md")?.content).toBe(note.content);
  });
  it("leaves the source intact when a conflicting archive already exists", async () => {
    const fixture = storeFixture();
    fixture.documents.set("memory/archive/source.v4.md", { ...source, content: "wrong preimage" });
    await expect(
      organizeMemoryDocument(fixture.store, source, decision, "bot", context, provenance),
    ).rejects.toThrow(/could not be verified/);
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(fixture.documents.get(source.path)?.content).toBe(source.content);
  });
  it("preserves a concurrent source edit and keeps the verified preimage", async () => {
    const fixture = storeFixture();
    fixture.documents.set(source.path, { ...source, revision: 5, content: "concurrent user edit" });
    await expect(
      organizeMemoryDocument(fixture.store, source, decision, "bot", context, provenance),
    ).rejects.toThrow(MEMORY_REVISION_CONFLICT_ERROR);
    expect(fixture.documents.get(source.path)?.content).toBe("concurrent user edit");
    expect(fixture.documents.get("memory/archive/source.v4.md")?.content).toBe(source.content);
  });
  it("does not touch the source if archive storage cannot be read back", async () => {
    const fixture = storeFixture();
    fixture.read.mockResolvedValue({ documents: [] });
    await expect(
      organizeMemoryDocument(fixture.store, source, decision, "bot", context, provenance),
    ).rejects.toThrow(/could not be verified/);
    expect(fixture.commit).toHaveBeenCalledTimes(1);
    expect(fixture.documents.get(source.path)?.content).toBe(source.content);
  });
  it.each(["memory/archive/old.md", "memory/reviews/old.md"])(
    "never reorganizes reserved %s",
    async (path) => {
      const fixture = storeFixture();
      await expect(
        organizeMemoryDocument(
          fixture.store,
          { ...source, path },
          decision,
          "bot",
          context,
          provenance,
        ),
      ).rejects.toThrow(/cannot be reorganized/);
      expect(fixture.commit).not.toHaveBeenCalled();
    },
  );
  it("rejects ineffective savings before creating an archive", async () => {
    const fixture = storeFixture();
    const small = { ...source, content: `Keep\n${"x".repeat(520)}` };
    await expect(
      organizeMemoryDocument(
        fixture.store,
        small,
        { ...decision, keep_ranges: [{ start_line: 1, end_line: 1 }] },
        "bot",
        context,
        provenance,
      ),
    ).rejects.toThrow(/including its archive pointer/);
    expect(fixture.commit).not.toHaveBeenCalled();
  });
});

const scope = { spaceId: "space", userId: "user", botId: "bot" };
const now = new Date("2026-11-08T12:00:00Z");
function policyFixture() {
  const previous = {
    id: "prior",
    startedAt: new Date("2026-11-08T00:00:00Z"),
    completedAt: new Date("2026-11-08T00:01:00Z"),
    task: { prompt: AUTOMATIC_MEMORY_PROMPT },
  };
  const document = {
    path: "MEMORY.md",
    content: "current",
    updatedAt: new Date("2026-11-08T02:00:00Z"),
    revisions: [{ sourceRunId: "user-run" }],
  };
  const prisma = {
    run: {
      findFirst: vi.fn().mockResolvedValue(previous),
      findMany: vi
        .fn()
        .mockResolvedValue(Array.from({ length: 30 }, (_, n) => ({ sourceMessageId: `m${n}` }))),
    },
    memoryDocument: { findMany: vi.fn().mockResolvedValue([document]) },
    routine: {
      findFirst: vi.fn(async ({ select, where }) =>
        where.sharedMemoryOrganizer
          ? null
          : select.botId
            ? { botId: "bot" }
            : {
                id: "routine",
                prompt: AUTOMATIC_MEMORY_PROMPT,
                nextRunAt: new Date("2026-11-09T10:00:00Z"),
              },
      ),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return { prisma, previous, document };
}
describe("memory organization scheduling", () => {
  it("nudges the existing enabled routine after 30 distinct human turns", async () => {
    const { prisma } = policyFixture();
    expect(await nudgeMemoryOrganization(prisma as never, scope, now)).toBe(true);
    expect(prisma.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        distinct: ["sourceMessageId"],
        take: 30,
        where: expect.objectContaining({
          ...scope,
          status: "completed",
          sourceMessage: { role: "user" },
        }),
      }),
    );
    expect(prisma.routine.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ...scope, active: true, memoryMaintenance: true }),
        data: { nextRunAt: now },
      }),
    );
  });
  it("does not run for a few turns and small summaries", async () => {
    const { prisma } = policyFixture();
    prisma.run.findMany.mockResolvedValue([{ sourceMessageId: "one" }]);
    expect(await nudgeMemoryOrganization(prisma as never, scope, now)).toBe(false);
    expect(prisma.routine.updateMany).not.toHaveBeenCalled();
  });
  it("nudges on summary pressure even before 30 turns", async () => {
    const { prisma, document } = policyFixture();
    prisma.run.findMany.mockResolvedValue([]);
    prisma.memoryDocument.findMany.mockResolvedValue([{ ...document, content: "x".repeat(16000) }]);
    expect(await nudgeMemoryOrganization(prisma as never, scope, now)).toBe(true);
  });
  it("enforces the six-hour cooldown", async () => {
    const { prisma, previous } = policyFixture();
    prisma.run.findFirst.mockResolvedValue({
      ...previous,
      completedAt: new Date("2026-11-08T08:00:00Z"),
    });
    expect(await nudgeMemoryOrganization(prisma as never, scope, now)).toBe(false);
    expect(prisma.routine.updateMany).not.toHaveBeenCalled();
  });
  it("skips unchanged data before opening a model stream", async () => {
    const { prisma, document } = policyFixture();
    prisma.memoryDocument.findMany.mockResolvedValue([
      { ...document, updatedAt: new Date("2026-11-07T00:00:00Z") },
    ]);
    expect(await memoryOrganizationStatus(prisma as never, scope, "current", now)).toMatchObject({
      changed: false,
    });
    expect(await nudgeMemoryOrganization(prisma as never, scope, now)).toBe(false);
  });
  it("does not treat its own archive or source writes as new work", async () => {
    const { prisma, document } = policyFixture();
    prisma.memoryDocument.findMany.mockResolvedValue([
      { ...document, path: "memory/archive/preimage.md" },
      { ...document, path: "memory/reviews/proposal.md" },
      { ...document, revisions: [{ sourceRunId: "prior" }] },
    ]);
    expect(await memoryOrganizationStatus(prisma as never, scope, "current", now)).toMatchObject({
      changed: false,
    });
  });
  it("retains changes arriving during the previous run for the next check", async () => {
    const { prisma, document } = policyFixture();
    prisma.memoryDocument.findMany.mockResolvedValue([
      { ...document, updatedAt: new Date("2026-11-08T00:00:30Z") },
    ]);
    expect(await memoryOrganizationStatus(prisma as never, scope, "current", now)).toMatchObject({
      changed: true,
    });
  });
  it("scopes shared ownership to the current account and space", async () => {
    const { prisma } = policyFixture();
    expect(await ownsSharedMemoryOrganization(prisma as never, scope)).toBe(true);
    expect(prisma.routine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user", spaceId: "space", active: true }),
        orderBy: { botId: "asc" },
      }),
    );
  });
  it("honors the explicitly chosen owner and does not replace a paused one", async () => {
    const { prisma } = policyFixture();
    const selected = {
      botId: "chosen",
      active: true,
      memoryMaintenance: true,
      bot: { archivedAt: null, disabledBuiltinTools: [] },
    };
    prisma.routine.findFirst.mockResolvedValue(selected as never);
    expect(await ownsSharedMemoryOrganization(prisma as never, scope)).toBe(false);
    expect(await ownsSharedMemoryOrganization(prisma as never, { ...scope, botId: "chosen" })).toBe(
      true,
    );
    prisma.routine.findFirst.mockResolvedValue({ ...selected, active: false } as never);
    expect(await ownsSharedMemoryOrganization(prisma as never, { ...scope, botId: "chosen" })).toBe(
      false,
    );
    prisma.routine.findFirst.mockResolvedValue({
      ...selected,
      bot: { ...selected.bot, disabledBuiltinTools: ["organize_memory"] },
    } as never);
    expect(await ownsSharedMemoryOrganization(prisma as never, { ...scope, botId: "chosen" })).toBe(
      false,
    );
  });
  it("does not reactivate a paused routine during explicit upgrade", async () => {
    const update = vi.fn();
    const prisma = {
      bot: { findMany: vi.fn().mockResolvedValue([]) },
      routine: {
        findMany: vi.fn().mockResolvedValue([
          { id: "paused", active: false },
          { id: "active", active: true },
        ]),
        update,
      },
    };
    await enableAutomaticMemoryOrganization(prisma as never, now);
    expect(update).toHaveBeenNthCalledWith(1, {
      where: { id: "paused" },
      data: {
        name: "Automatic memory organization",
        prompt: AUTOMATIC_MEMORY_PROMPT,
      },
    });
    expect(update).toHaveBeenNthCalledWith(2, {
      where: { id: "active" },
      data: {
        name: "Automatic memory organization",
        prompt: AUTOMATIC_MEMORY_PROMPT,
        nextRunAt: now,
      },
    });
  });
});
