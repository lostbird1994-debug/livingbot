import type { MemoryStore } from "@livingbot/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@livingbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  AUTOMATIC_MEMORY_PROMPT,
  enableAutomaticMemoryOrganization,
  isReviewableMemoryPath,
  memoryOrganizationPlan,
  memoryOrganizationStatus,
  memoryReviewStalled,
  nudgeMemoryOrganization,
  organizeMemoryDocument,
  ownsSharedMemoryOrganization,
  recordMemoryRead,
  settleMemoryRewrites,
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
    id: "doc-memory",
    path: "MEMORY.md",
    scope: "bot",
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
    memoryRevision: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (work: unknown) => {
      const client = prisma as unknown as Record<string, unknown>;
      return typeof work === "function"
        ? (work as (tx: unknown) => Promise<unknown>)(client)
        : Promise.all(work as Array<Promise<unknown>>);
    }),
    memoryDocumentCheck: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    },
    routine: {
      findFirst: vi.fn(async ({ select, where }) =>
        where.sharedMemoryOrganizer
          ? null
          : select.botId
            ? { botId: "bot" }
            : select.organizationFullCheckedAt
              ? { organizationFullCheckedAt: null, organizationSweepStartedAt: null }
              : {
                  id: "routine",
                  prompt: AUTOMATIC_MEMORY_PROMPT,
                  nextRunAt: new Date("2026-11-09T10:00:00Z"),
                },
      ),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([
        {
          botId: "bot",
          active: true,
          bot: { name: "Chief", spawnKey: "onboarding:first", disabledBuiltinTools: [] },
        },
      ]),
    },
  };
  return { prisma, previous, document };
}
describe("memory organization scheduling", () => {
  it("nudges the existing enabled routine when memory changed", async () => {
    const { prisma } = policyFixture();
    expect(await nudgeMemoryOrganization(prisma as never, scope, now)).toBe(true);
    expect(prisma.routine.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ...scope, active: true, memoryMaintenance: true }),
        data: { nextRunAt: now },
      }),
    );
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
    expect(prisma.routine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user",
          spaceId: "space",
          memoryMaintenance: true,
        }),
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
          { id: "paused", active: false, spaceId: "space", userId: "user" },
          { id: "active", active: true, spaceId: "space", userId: "user" },
        ]),
        update,
      },
      $transaction: vi.fn(async (operation) =>
        operation({
          $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
          routine: {
            findMany: vi.fn().mockResolvedValue([
              {
                id: "active",
                botId: "bot",
                active: true,
                bot: { name: "Chief", spawnKey: "onboarding:first", disabledBuiltinTools: [] },
              },
            ]),
            findFirst: vi.fn(async ({ where }) =>
              where.sharedMemoryOrganizer ? null : { id: "active" },
            ),
            update,
          },
        }),
      ),
    };
    await enableAutomaticMemoryOrganization(prisma as never, now);
    expect(update).toHaveBeenNthCalledWith(1, {
      where: { id: "paused" },
      data: {
        builtinKind: "memory-organization",
        name: "Automatic memory organization",
        prompt: AUTOMATIC_MEMORY_PROMPT,
        crons: ["10 18 * * *"],
        nextRunAt: null,
      },
    });
    expect(update).toHaveBeenNthCalledWith(2, {
      where: { id: "active" },
      data: {
        builtinKind: "memory-organization",
        name: "Automatic memory organization",
        prompt: AUTOMATIC_MEMORY_PROMPT,
        crons: ["10 18 * * *"],
        nextRunAt: new Date("2026-11-08T18:10:00Z"),
      },
    });
    expect(update).toHaveBeenNthCalledWith(3, {
      where: { id: "active" },
      data: { sharedMemoryOrganizer: true },
    });
  });
});

it("uses changed documents for daily checks and every live document for a weekly full check", async () => {
  const f = policyFixture();
  const original = f.prisma.routine.findFirst.getMockImplementation()!;
  const lastFull = new Date("2026-11-08T01:00:00Z");
  f.prisma.routine.findFirst.mockImplementation(async (args) =>
    args.select.organizationFullCheckedAt
      ? ({ organizationFullCheckedAt: lastFull } as never)
      : original(args),
  );
  // The server only schedules what the memory tools can enumerate; mirror rows without a live
  // document never become targets, so an unreachable document cannot fail the whole run.
  let live = [
    { ...f.document, id: "doc-memory", path: "MEMORY.md" },
    { ...f.document, id: "doc-ghost", path: "feishu/ghost.md" },
  ];
  const readDocuments = async (target: "bot" | "user") =>
    target === "bot"
      ? live.map((doc) => ({
          id: doc.id,
          path: doc.path,
          content: doc.content,
          revision: 1,
          updatedAt: new Date(doc.updatedAt).toISOString(),
        }))
      : [];
  let result = await memoryOrganizationPlan(
    f.prisma as never,
    scope,
    "current",
    now,
    readDocuments,
  );
  expect(result.full).toBe(false);
  expect(result.paths).toEqual(["bot:MEMORY.md"]);
  expect(result.ids).toEqual(["doc-memory"]);
  result = await memoryOrganizationPlan(
    f.prisma as never,
    scope,
    "current",
    new Date("2026-11-16T10:00:00Z"),
    readDocuments,
  );
  expect(result.full).toBe(true);
  expect(result.ids).toEqual(["doc-memory"]);
  f.prisma.memoryDocument.findMany.mockResolvedValue([
    { ...f.document, updatedAt: new Date("2026-11-07T00:00:00Z") },
  ]);
  live = [
    {
      ...f.document,
      id: "doc-memory",
      path: "MEMORY.md",
      updatedAt: new Date("2026-11-07T00:00:00Z"),
    },
  ];
  // A document that was never settled counts as work even when it did not change.
  result = await memoryOrganizationPlan(
    f.prisma as never,
    scope,
    "current",
    new Date("2026-11-16T10:00:00Z"),
    readDocuments,
  );
  expect(result.full).toBe(false);
  expect(result.changed).toBe(true);
  // Once the current revision is settled there is nothing left to do.
  f.prisma.memoryDocumentCheck.findMany.mockResolvedValue([
    {
      documentId: "doc-memory",
      revision: 1,
      status: "checked",
      ranges: [],
      checkedAt: new Date("2026-11-08T12:00:00Z"),
    },
  ]);
  result = await memoryOrganizationPlan(
    f.prisma as never,
    scope,
    "current",
    new Date("2026-11-16T10:00:00Z"),
    readDocuments,
  );
  expect(result.full).toBe(false);
  expect(result.changed).toBe(false);
});

it("skips settled revisions, budgets the batch and resumes an oversized document", async () => {
  const f = policyFixture();
  const snapshot = [
    {
      id: "big",
      path: "memory/big.md",
      content: "x".repeat(60_000),
      revision: 2,
      updatedAt: "2026-11-08T02:00:00.000Z",
    },
    {
      id: "small",
      path: "memory/small.md",
      content: "y".repeat(1_000),
      revision: 1,
      updatedAt: "2026-11-08T02:00:00.000Z",
    },
    {
      id: "done",
      path: "memory/done.md",
      content: "z".repeat(1_000),
      revision: 1,
      updatedAt: "2026-11-08T02:00:00.000Z",
    },
  ];
  const original = f.prisma.routine.findFirst.getMockImplementation()!;
  f.prisma.routine.findFirst.mockImplementation(async (args) =>
    args.select?.organizationFullCheckedAt
      ? ({
          organizationFullCheckedAt: new Date("2026-11-08T11:00:00Z"),
          organizationSweepStartedAt: null,
        } as never)
      : original(args),
  );
  f.prisma.memoryDocumentCheck.findMany.mockResolvedValue([
    {
      documentId: "big",
      revision: 2,
      status: "reading",
      ranges: [[0, 20_000]],
      checkedAt: new Date("2026-11-08T03:00:00Z"),
    },
    {
      documentId: "done",
      revision: 1,
      status: "checked",
      ranges: [],
      checkedAt: new Date("2026-11-08T03:00:00Z"),
    },
  ]);
  const result = await memoryOrganizationPlan(
    f.prisma as never,
    scope,
    "current",
    now,
    async (target) => (target === "bot" ? snapshot : []),
  );
  // The 60k note is taken first and may exceed one batch; a settled revision is not re-scheduled.
  expect(result.full).toBe(false);
  expect(result.ids[0]).toBe("big");
  expect(result.ids).toContain("small");
  expect(result.ids).not.toContain("done");
  expect(result.resume).toEqual([{ path: "memory/big.md", offset: 20_000 }]);
  expect(result.budget).toBe(80_000);
  expect(result.remaining).toBe(0);
});

it("keeps an unfinished sweep instead of restarting the weekly window", async () => {
  const f = policyFixture();
  const sweepStartedAt = new Date("2026-11-01T00:00:00Z");
  const fullAt = new Date("2026-10-25T00:00:00Z");
  const original = f.prisma.routine.findFirst.getMockImplementation()!;
  f.prisma.routine.findFirst.mockImplementation(async (args) =>
    args.select?.organizationFullCheckedAt
      ? ({ organizationFullCheckedAt: fullAt, organizationSweepStartedAt: sweepStartedAt } as never)
      : original(args),
  );
  // Settled before this sweep began, so it must be reviewed again.
  f.prisma.memoryDocumentCheck.findMany.mockResolvedValue([
    {
      documentId: "doc-memory",
      revision: 1,
      status: "checked",
      ranges: [],
      checkedAt: new Date("2026-10-20T00:00:00Z"),
    },
  ]);
  const result = await memoryOrganizationPlan(
    f.prisma as never,
    scope,
    "current",
    now,
    async (target) =>
      target === "bot"
        ? [
            {
              id: "doc-memory",
              path: "MEMORY.md",
              content: "current",
              revision: 1,
              updatedAt: "2026-11-08T02:00:00.000Z",
            },
          ]
        : [],
  );
  expect(result.full).toBe(true);
  expect(result.sweepStartedAt).toEqual(sweepStartedAt);
  expect(result.ids).toEqual(["doc-memory"]);
  expect(f.prisma.routine.updateMany).not.toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ organizationSweepStartedAt: now }) }),
  );
});

it("counts a document changed by its snapshot even when the mirror has not synced", async () => {
  const f = policyFixture();
  const original = f.prisma.routine.findFirst.getMockImplementation()!;
  f.prisma.routine.findFirst.mockImplementation(async (args) =>
    args.select?.organizationFullCheckedAt
      ? ({
          organizationFullCheckedAt: new Date("2026-11-08T11:00:00Z"),
          organizationSweepStartedAt: null,
        } as never)
      : original(args),
  );
  // The mirror still holds yesterday's row; the workspace file is newer.
  f.prisma.memoryDocument.findMany.mockResolvedValue([
    { ...f.document, updatedAt: new Date("2026-11-07T00:00:00Z") },
  ]);
  const result = await memoryOrganizationPlan(
    f.prisma as never,
    scope,
    "current",
    now,
    async (target) =>
      target === "bot"
        ? [
            {
              id: "doc-memory",
              path: "MEMORY.md",
              content: "current",
              revision: 9,
              updatedAt: "2026-11-08T09:00:00.000Z",
            },
          ]
        : [],
  );
  expect(result.changed).toBe(true);
  expect(result.ids).toEqual(["doc-memory"]);
});

it("settles only the revisions this run wrote", async () => {
  const f = policyFixture();
  // Another run wrote revision 5; this run wrote revision 4. Only 4 may be settled.
  f.prisma.memoryRevision.findMany.mockResolvedValue([
    { documentId: "doc-shared", revision: 4, content: "shared summary" },
  ]);
  await settleMemoryRewrites(
    f.prisma as never,
    { spaceId: "space", botId: "bot" },
    ["doc-shared"],
    "run-1",
  );
  expect(f.prisma.memoryRevision.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { sourceRunId: "run-1", documentId: { in: ["doc-shared"] } },
    }),
  );
  expect(f.prisma.memoryDocumentCheck.upsert).toHaveBeenCalledTimes(1);
  expect(f.prisma.memoryDocumentCheck.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { documentId_revision: { documentId: "doc-shared", revision: 4 } },
      create: expect.objectContaining({ status: "checked", settledBy: "rewrite", runId: "run-1" }),
    }),
  );
});

it("reports a stall when the last three runs settled nothing", async () => {
  const f = policyFixture();
  f.prisma.run.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
  f.prisma.memoryDocumentCheck.count.mockResolvedValue(0);
  expect(
    await memoryReviewStalled(f.prisma as never, {
      spaceId: "space",
      botId: "bot",
      routineId: "routine",
    }),
  ).toBe(true);
  f.prisma.memoryDocumentCheck.count.mockResolvedValue(2);
  expect(
    await memoryReviewStalled(f.prisma as never, {
      spaceId: "space",
      botId: "bot",
      routineId: "routine",
    }),
  ).toBe(false);
});

it("completes a note whose pages were read across two runs", async () => {
  const f = policyFixture();
  // First slice read 0..3000 and stopped; the second slice finishes from 3000.
  f.prisma.memoryDocumentCheck.findUnique.mockResolvedValue({
    status: "reading",
    ranges: [[0, 3000]],
  });
  const result = await recordMemoryRead(
    f.prisma as never,
    { spaceId: "space", botId: "bot" },
    { id: "doc-memory", revision: 3, chars: 5000 },
    [[3000, 5000]],
    false,
    "run-2",
  );
  expect(result.complete).toBe(true);
  expect(result.ranges).toEqual([[0, 5000]]);
  expect(f.prisma.memoryDocumentCheck.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: expect.objectContaining({ status: "read", runId: "run-2" }),
      update: expect.objectContaining({ status: "read", ranges: [[0, 5000]] }),
    }),
  );
});

it("keeps an unfinished document in scope after a partial slice", async () => {
  const f = policyFixture();
  const original = f.prisma.routine.findFirst.getMockImplementation()!;
  f.prisma.routine.findFirst.mockImplementation(async (args) =>
    args.select?.organizationFullCheckedAt
      ? ({
          organizationFullCheckedAt: new Date("2026-11-08T11:00:00Z"),
          organizationSweepStartedAt: null,
        } as never)
      : original(args),
  );
  // The leftover was written before the previous memory run, so only "unsettled" can select it.
  const result = await memoryOrganizationPlan(
    f.prisma as never,
    scope,
    "current",
    now,
    async (target) =>
      target === "bot"
        ? [
            {
              id: "doc-left",
              path: "memory/left.md",
              content: "left",
              revision: 1,
              updatedAt: "2026-11-06T00:00:00.000Z",
            },
          ]
        : [],
  );
  expect(result.ids).toEqual(["doc-left"]);
  expect(result.changed).toBe(true);
});

it("reopens settled revisions when a new sweep starts", async () => {
  const f = policyFixture();
  const original = f.prisma.routine.findFirst.getMockImplementation()!;
  f.prisma.routine.findFirst.mockImplementation(async (args) =>
    args.select?.organizationFullCheckedAt
      ? ({ organizationFullCheckedAt: null, organizationSweepStartedAt: null } as never)
      : original(args),
  );
  f.prisma.memoryDocumentCheck.findMany.mockResolvedValue([
    {
      documentId: "doc-memory",
      revision: 1,
      status: "checked",
      ranges: [],
      checkedAt: new Date("2026-10-01T00:00:00Z"),
    },
  ]);
  const result = await memoryOrganizationPlan(
    f.prisma as never,
    scope,
    "current",
    now,
    async (target) =>
      target === "bot"
        ? [
            {
              id: "doc-memory",
              path: "MEMORY.md",
              content: "current",
              revision: 1,
              updatedAt: "2026-11-08T09:00:00.000Z",
            },
          ]
        : [],
  );
  expect(result.full).toBe(true);
  expect(result.ids).toEqual(["doc-memory"]);
  // Every earlier record is reopened, not only settled ones: coverage from a previous window
  // must not let this window sign off after a single page.
  expect(f.prisma.memoryDocumentCheck.updateMany).toHaveBeenCalledWith({
    where: { spaceId: "space", botId: "bot" },
    data: expect.objectContaining({ status: "reading", ranges: [] }),
  });
});

it("does not count re-reading the same page as progress", async () => {
  const f = policyFixture();
  f.prisma.memoryDocumentCheck.findUnique.mockResolvedValue({
    status: "reading",
    ranges: [[0, 100]],
  });
  const result = await recordMemoryRead(
    f.prisma as never,
    { spaceId: "space", botId: "bot" },
    { id: "doc-memory", revision: 2, chars: 5000 },
    [[0, 100]],
    false,
    "run-3",
  );
  expect(result.complete).toBe(false);
  const update = f.prisma.memoryDocumentCheck.upsert.mock.calls.at(-1)?.[0]?.update;
  // No new coverage: the row keeps the run that actually advanced it, so the stall guard sees it.
  expect(update).not.toHaveProperty("runId");
});

it("opens a sweep and reopens stale rows in one transaction", async () => {
  const f = policyFixture();
  const original = f.prisma.routine.findFirst.getMockImplementation()!;
  f.prisma.routine.findFirst.mockImplementation(async (args) =>
    args.select?.organizationFullCheckedAt
      ? ({ organizationFullCheckedAt: null, organizationSweepStartedAt: null } as never)
      : original(args),
  );
  await memoryOrganizationPlan(f.prisma as never, scope, "current", now, async () => [
    {
      id: "doc-memory",
      path: "MEMORY.md",
      content: "current",
      revision: 1,
      updatedAt: "2026-11-08T09:00:00.000Z",
    },
  ]);
  expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
  // Both writes must be inside the same transaction, not two independent updates.
  expect(f.prisma.routine.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ organizationSweepStartedAt: now }),
    }),
  );
  expect(f.prisma.memoryDocumentCheck.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: "reading" }) }),
  );
});

it("schedules a shared MEMORY.md, which the reader does expose", async () => {
  expect(isReviewableMemoryPath("user", "MEMORY.md")).toBe(true);
  expect(isReviewableMemoryPath("user", "USER.md")).toBe(true);
  expect(isReviewableMemoryPath("bot", "USER.md")).toBe(false);
  expect(isReviewableMemoryPath("bot", "memory/note.md")).toBe(true);
  expect(isReviewableMemoryPath("bot", "feishu/note.md")).toBe(false);
});

it("never advances the built-in fixed memory schedule after messages or daily review", async () => {
  const updateMany = vi.fn();
  const prisma = {
    routine: {
      findFirst: vi.fn().mockResolvedValue({
        id: "memory",
        builtinKind: "memory-organization",
        prompt: AUTOMATIC_MEMORY_PROMPT,
      }),
      updateMany,
    },
  };
  expect(
    await nudgeMemoryOrganization(
      prisma as never,
      { spaceId: "space", userId: "user", botId: "bot" },
      new Date(),
    ),
  ).toBe(false);
  expect(updateMany).not.toHaveBeenCalled();
});
