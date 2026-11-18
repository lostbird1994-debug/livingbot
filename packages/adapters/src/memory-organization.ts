import type { AdapterContext, MemorySnapshot, MemoryStore } from "@livingbot/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@livingbot/adapter-kit";
import type { Actor } from "@livingbot/contracts";
import { isMemoryArchivePath, isMemoryReviewPath } from "@livingbot/contracts";
import {
  AUTOMATIC_MEMORY_PROMPT,
  findWorkspaceChief,
  MEMORY_ORGANIZATION_CRON,
  nextCronDate,
  WORKSPACE_CHIEF_SPAWN_KEY,
} from "@livingbot/core";
import type { PrismaClient } from "@livingbot/db";
import { lockSpaceSettings, withTransactionRetry } from "@livingbot/db";
import { getLogger } from "@livingbot/logging";
import { normalizeMemoryPath } from "./memory-context.js";
import type { MemoryConsolidationDecision } from "./memory-maintenance.js";
import { configureMemoryMaintenance, renderMemoryProposal } from "./memory-maintenance.js";
import { charLength } from "./utf8.js";

export const MEMORY_ORGANIZATION_VERSION = "Memory organization v2.";
export function isAutomaticMemoryPrompt(prompt: string) {
  return (
    prompt.startsWith(MEMORY_ORGANIZATION_VERSION) || prompt.startsWith("Memory organization v1.")
  );
}
export const MEMORY_ORGANIZATION_COOLDOWN_MS = 6 * 60 * 60_000;
/** While a sweep is unfinished the next slice is due sooner; a whole week of waiting per slice
 * would leave a large collection half-checked for days. */
export const MEMORY_SWEEP_COOLDOWN_MS = 60 * 60_000;
/** One review run reads at most this much text per batch, and a few batches per run. */
export const MEMORY_REVIEW_BUDGET_CHARS = 20_000;
export const MEMORY_REVIEW_MAX_BATCHES = 4;
export const MEMORY_REVIEW_MAX_DOCUMENTS = 8;
const MEMORY_FULL_SWEEP_DAYS = 7;

/** Merged `[start, end)` character ranges already read for one document revision. */
export function readCoverageRanges(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!Array.isArray(entry) || entry.length < 2) return [];
    const start = Number(entry[0]);
    const end = Number(entry[1]);
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      ? [[start, end] as [number, number]]
      : [];
  });
}

export function mergeReadRanges(
  left: Array<[number, number]>,
  right: Array<[number, number]>,
): Array<[number, number]> {
  const sorted = [...left, ...right].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range] as [number, number]);
  }
  return merged;
}

/** Offset where reading must continue: the end of the block that starts at zero. */
export function readCoverageOffset(value: unknown): number {
  let offset = 0;
  for (const [start, end] of readCoverageRanges(value)) {
    if (start > offset) break;
    offset = Math.max(offset, end);
  }
  return offset;
}

/**
 * Persist how far one document revision has been read. Coverage is merged across runs so a note
 * larger than one read budget continues where it stopped instead of restarting.
 */
const readWrites = new Map<
  string,
  Promise<{ ranges: Array<[number, number]>; complete: boolean }>
>();

export async function recordMemoryRead(
  prisma: PrismaClient,
  scope: { spaceId: string; botId: string },
  document: { id: string; revision: number; chars: number },
  ranges: Array<[number, number]>,
  complete: boolean,
  runId?: string,
): Promise<{ ranges: Array<[number, number]>; complete: boolean }> {
  // Page reads for the same document may arrive in parallel; serialize per revision so a later
  // write cannot drop ranges an earlier one just merged.
  const key = `${document.id}:${document.revision}`;
  const previous = readWrites.get(key);
  const write = (previous ?? Promise.resolve({ ranges: [], complete: false }))
    .catch(() => ({ ranges: [], complete: false }))
    .then(() => writeMemoryRead(prisma, scope, document, ranges, complete, runId));
  readWrites.set(key, write);
  try {
    return await write;
  } catch (error) {
    // Progress is a convenience, not the review itself: a write failure must not fail the read.
    getLogger().warn("memory.read_progress_unrecorded", {
      "bot.id": scope.botId,
      "memory.document": document.id,
      error,
    });
    const merged = mergeReadRanges([], ranges);
    return { ranges: merged, complete: complete || coversText(merged, document.chars) };
  } finally {
    if (readWrites.get(key) === write) readWrites.delete(key);
  }
}

/** True when one contiguous range covers the whole document. */
function coversText(ranges: Array<[number, number]>, chars: number) {
  return ranges.length === 1 && ranges[0]![0] === 0 && ranges[0]![1] === chars;
}

/** Total characters covered by merged, non-overlapping ranges. */
function coveredWidth(ranges: Array<[number, number]>) {
  return ranges.reduce((total, [start, end]) => total + (end - start), 0);
}

async function writeMemoryRead(
  prisma: PrismaClient,
  scope: { spaceId: string; botId: string },
  document: { id: string; revision: number; chars: number },
  ranges: Array<[number, number]>,
  complete: boolean,
  runId?: string,
) {
  const where = {
    documentId_revision: { documentId: document.id, revision: document.revision },
  };
  const existing = await prisma.memoryDocumentCheck.findUnique({
    where,
    select: { status: true, ranges: true },
  });
  const persisted = readCoverageRanges(existing?.ranges);
  // A settled revision stays settled; reading it again counts as covered for this run.
  if (existing?.status === "checked") return { ranges: persisted, complete: true };
  // Completion is judged on everything read for this revision, across runs: a note larger than
  // one read budget only becomes "read" after the second slice continues from its offset.
  const merged = mergeReadRanges(persisted, ranges);
  const covered = complete || coversText(merged, document.chars);
  const status = covered || existing?.status === "read" ? "read" : "reading";
  // Re-reading the same page is not progress; only new coverage (or a settlement) is. The run
  // id is what the stall guard counts, so it must not be refreshed by a no-op read.
  const progressed = covered || coveredWidth(merged) > coveredWidth(persisted);
  await prisma.memoryDocumentCheck.upsert({
    where,
    create: {
      spaceId: scope.spaceId,
      botId: scope.botId,
      documentId: document.id,
      revision: document.revision,
      chars: document.chars,
      status,
      ranges: merged,
      ...(runId ? { runId } : {}),
    },
    update: {
      chars: document.chars,
      status,
      ranges: merged,
      ...(runId && progressed ? { runId } : {}),
    },
  });
  return { ranges: merged, complete: covered };
}

/** A finished run settles the documents it read in full; a read alone never settles one. */
export async function markMemoryChecked(
  prisma: PrismaClient,
  scope: { spaceId: string; botId: string },
  documentIds: readonly string[],
  runId?: string,
) {
  if (!documentIds.length) return 0;
  const { count } = await prisma.memoryDocumentCheck.updateMany({
    where: {
      spaceId: scope.spaceId,
      botId: scope.botId,
      documentId: { in: [...documentIds] },
      status: "read",
    },
    data: {
      status: "checked",
      settledBy: "read",
      checkedAt: new Date(),
      ...(runId ? { runId } : {}),
    },
  });
  return count;
}

/**
 * A document the run rewrote has a new revision the model itself produced, so settle that
 * revision too. Only revisions this run actually wrote are settled: another run may have
 * written the document after our read, and a version the model never saw must not be marked
 * reviewed. The revision row carries the producing run, so no `botId` filter is needed and
 * shared (`scope: "user"`) documents work the same way.
 */
export async function settleMemoryRewrites(
  prisma: PrismaClient,
  scope: { spaceId: string; botId: string },
  documentIds: readonly string[],
  runId: string,
) {
  if (!documentIds.length) return 0;
  const revisions = await prisma.memoryRevision.findMany({
    where: { sourceRunId: runId, documentId: { in: [...documentIds] } },
    orderBy: { revision: "desc" },
    select: { documentId: true, revision: true, content: true },
  });
  const documents = revisions.filter(
    (revision, index) =>
      revisions.findIndex((row) => row.documentId === revision.documentId) === index,
  );
  let settled = 0;
  for (const document of documents) {
    const where = {
      documentId_revision: { documentId: document.documentId, revision: document.revision },
    };
    const existing = await prisma.memoryDocumentCheck.findUnique({
      where,
      select: { status: true },
    });
    if (existing?.status === "checked") continue;
    await prisma.memoryDocumentCheck.upsert({
      where,
      create: {
        spaceId: scope.spaceId,
        botId: scope.botId,
        documentId: document.documentId,
        revision: document.revision,
        chars: charLength(document.content),
        status: "checked",
        ranges: [],
        settledBy: "rewrite",
        runId,
      },
      update: {
        status: "checked",
        settledBy: "rewrite",
        checkedAt: new Date(),
        runId,
      },
    });
    settled += 1;
  }
  return settled;
}

/**
 * True when the last three finished runs settled nothing. Repeating hourly slices that make no
 * progress only burns tokens, so the caller falls back to the daily slot instead of escalating.
 */
export async function memoryReviewStalled(
  prisma: PrismaClient,
  scope: { spaceId: string; botId: string; routineId: string },
) {
  const runs = await prisma.run.findMany({
    where: { routineId: scope.routineId, status: "completed" },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: { id: true },
  });
  if (runs.length < 3) return false;
  // Any recorded read counts as progress, not only a completed one: a large note legitimately
  // takes several slices, and calling that a stall would stop a healthy resume.
  const progressed = await prisma.memoryDocumentCheck.count({
    where: {
      spaceId: scope.spaceId,
      botId: scope.botId,
      runId: { in: runs.map((run) => run.id) },
    },
  });
  return progressed === 0;
}

/**
 * Mirrors the memory tools' own allow-list: anything else cannot be read, so never schedule it.
 * The reader exposes MEMORY.md in both scopes and USER.md only in the shared one.
 */
export function isReviewableMemoryPath(scope: "bot" | "user", path: string) {
  return (
    path === "MEMORY.md" ||
    (scope === "user" && path === "USER.md") ||
    /^memory\/.+\.md$/i.test(path)
  );
}

// The model selects current information; the server enforces lossless preservation, not meaning.
export { AUTOMATIC_MEMORY_PROMPT } from "@livingbot/core";

type Decision = typeof MemoryConsolidationDecision._output;
type Document = MemorySnapshot["documents"][number];
type Scope = { spaceId: string; userId: string; botId: string };

export function chiefMemoryRoutine<
  T extends {
    botId: string;
    bot: { name: string; spawnKey: string | null };
  },
>(routines: readonly T[]): T | undefined {
  const chief = findWorkspaceChief(
    routines.map((row) => ({
      ...row.bot,
      routine: row,
    })),
  );
  return chief?.routine;
}

const chiefRoutineQuery = (member: { spaceId: string; userId: string }) => ({
  where: { ...member, memoryMaintenance: true, bot: { archivedAt: null } },
  include: { bot: { select: { name: true, spawnKey: true, disabledBuiltinTools: true } } },
});

/** Called after onboarding bot creation; retries safely without changing existing schedules. */
export async function ensureChiefMemoryOrganization(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
  now = new Date(),
) {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceSettings(tx, actor);
        const bot = await tx.bot.findFirst({
          where: {
            id: botId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            archivedAt: null,
            spawnKey: WORKSPACE_CHIEF_SPAWN_KEY,
          },
          select: { id: true, disabledBuiltinTools: true },
        });
        if (
          !bot ||
          bot.disabledBuiltinTools.some((name) => ["read_memory", "organize_memory"].includes(name))
        )
          return;
        const user = await tx.user.findUnique({
          where: { id: actor.userId },
          select: { timezone: true },
        });
        const timezone = user?.timezone ?? "UTC";
        const routine = await tx.routine.upsert({
          where: { id: `memory-review:${botId}` },
          create: {
            id: `memory-review:${botId}`,
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId,
            builtinKind: "memory-organization",
            name: "Automatic memory organization",
            prompt: AUTOMATIC_MEMORY_PROMPT,
            crons: [MEMORY_ORGANIZATION_CRON],
            timezone,
            active: true,
            notify: false,
            memoryMaintenance: true,
            nextRunAt: nextCronDate(MEMORY_ORGANIZATION_CRON, now, timezone),
          },
          update: {},
        });
        const selected = await tx.routine.findFirst({
          where: { spaceId: actor.spaceId, userId: actor.userId, sharedMemoryOrganizer: true },
          select: { id: true },
        });
        if (!selected)
          await tx.routine.update({
            where: { id: routine.id },
            data: { sharedMemoryOrganizer: true },
          });
      },
      { isolationLevel: "Serializable" },
    ),
  );
}

/** Explicit operator action: reassign current spaces without touching memory, models or clocks. */
export async function assignSharedMemoryToWorkspaceChiefs(prisma: PrismaClient) {
  const members = await prisma.routine.findMany({
    where: { memoryMaintenance: true, bot: { archivedAt: null } },
    distinct: ["spaceId", "userId"],
    select: { spaceId: true, userId: true },
  });
  const result = { changed: 0, unchanged: 0, missingChief: 0, unavailableChief: 0 };
  for (const member of members) {
    const status = await withTransactionRetry(() =>
      prisma.$transaction(
        async (tx) => {
          await lockSpaceSettings(tx, member);
          const rows = await tx.routine.findMany(chiefRoutineQuery(member));
          const chief = chiefMemoryRoutine(rows);
          if (!chief) return "missingChief" as const;
          if (
            !chief.active ||
            chief.bot.disabledBuiltinTools.some((name) =>
              ["read_memory", "organize_memory"].includes(name),
            )
          )
            return "unavailableChief" as const;
          if (chief.sharedMemoryOrganizer) return "unchanged" as const;
          await tx.routine.updateMany({
            where: { ...member, sharedMemoryOrganizer: true },
            data: { sharedMemoryOrganizer: false },
          });
          await tx.routine.update({
            where: { id: chief.id },
            data: { sharedMemoryOrganizer: true },
          });
          return "changed" as const;
        },
        { isolationLevel: "Serializable" },
      ),
    );
    result[status]++;
  }
  return result;
}

export async function ownsSharedMemoryOrganization(prisma: PrismaClient, scope: Scope) {
  // An explicitly selected but paused/disabled organizer must not silently hand work elsewhere.
  const selected = await prisma.routine.findFirst({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      sharedMemoryOrganizer: true,
    },
    select: {
      botId: true,
      active: true,
      memoryMaintenance: true,
      bot: {
        select: { archivedAt: true, disabledBuiltinTools: true },
      },
    },
  });
  if (selected) {
    return (
      selected.botId === scope.botId &&
      selected.active &&
      selected.memoryMaintenance &&
      !selected.bot.archivedAt &&
      !selected.bot.disabledBuiltinTools.some((tool) =>
        ["read_memory", "organize_memory"].includes(tool),
      )
    );
  }
  const owner = chiefMemoryRoutine(
    await prisma.routine.findMany(
      chiefRoutineQuery({
        spaceId: scope.spaceId,
        userId: scope.userId,
      }),
    ),
  );
  return Boolean(
    owner?.botId === scope.botId &&
      owner.active &&
      !owner.bot.disabledBuiltinTools.some((name) =>
        ["read_memory", "organize_memory"].includes(name),
      ),
  );
}

/** A verified immutable preimage is committed first. A failed summary CAS preserves that backup. */
export async function organizeMemoryDocument(
  memory: MemoryStore,
  source: Document,
  decision: Decision,
  scope: "bot" | "user",
  context: AdapterContext,
  provenance: { runId: string; threadId: string },
) {
  if (
    !normalizeMemoryPath(source.path) ||
    isMemoryArchivePath(source.path) ||
    isMemoryReviewPath(source.path)
  )
    throw new Error("Archives and review artifacts cannot be reorganized.");
  renderMemoryProposal(source, decision);
  const archivePath = `memory/archive/${source.id}.v${source.revision}.md`;
  const lines = source.content.split("\n");
  const selected = decision.keep_ranges
    .map((range) => lines.slice(range.start_line - 1, range.end_line).join("\n"))
    .join("\n\n");
  const content = `${selected}\n\nFull original: ${scope}:${archivePath} (source revision ${source.revision}).\n`;
  if (charLength(source.content) - charLength(content) < 512)
    throw new Error(
      "The final summary must save at least 512 characters including its archive pointer.",
    );
  const requestScope = { scope, ...(scope === "bot" ? { botId: context.botId } : {}) };
  const readArchive = async () =>
    (await memory.read({ ...requestScope, path: archivePath }, context)).documents[0];
  let archive = await readArchive();
  if (!archive) {
    try {
      await memory.commit(
        {
          ...requestScope,
          path: archivePath,
          content: source.content,
          expectedRevision: 0,
          sourceRunId: provenance.runId,
          sourceThreadId: provenance.threadId,
        },
        context,
      );
    } catch (error) {
      if (!(error instanceof Error) || error.message !== MEMORY_REVISION_CONFLICT_ERROR)
        throw error;
    }
    archive = await readArchive();
  }
  if (!archive || archive.content !== source.content)
    throw new Error("The source archive could not be verified. Source unchanged.");
  const saved = await memory.commit(
    {
      ...requestScope,
      path: source.path,
      content,
      expectedRevision: source.revision,
      sourceRunId: provenance.runId,
      sourceThreadId: provenance.threadId,
    },
    context,
  );
  return {
    status: "applied",
    path: `${scope}:${saved.path}`,
    revision: saved.revision,
    archive: `${scope}:${archivePath}`,
    sourceRevision: source.revision,
    savedCharacters: charLength(source.content) - charLength(content),
  };
}

/** Compare against the last completed automatic run, never a proposal-only legacy run. */
export async function memoryOrganizationStatus(
  prisma: PrismaClient,
  scope: Scope,
  currentRunId: string,
  startedAt: Date,
) {
  const previous = await prisma.run.findFirst({
    where: {
      ...scope,
      id: { not: currentRunId },
      status: "completed",
      routine: { memoryMaintenance: true },
      completedAt: { not: null },
    },
    orderBy: { completedAt: "desc" },
    select: { id: true, startedAt: true, completedAt: true, task: { select: { prompt: true } } },
  });
  // Task prompts are encrypted; inspect the decrypted row rather than filtering ciphertext.
  const since =
    previous && isAutomaticMemoryPrompt(previous.task.prompt) ? previous.startedAt : null;
  const lastCompletedAt = since ? (previous?.completedAt ?? null) : null;
  const shared = await ownsSharedMemoryOrganization(prisma, scope);
  const assignment =
    shared && since
      ? await prisma.routine.findFirst({
          where: {
            spaceId: scope.spaceId,
            userId: scope.userId,
            botId: scope.botId,
            sharedMemoryOrganizer: true,
          },
          select: { updatedAt: true },
        })
      : null;
  const newlyAssignedShared = Boolean(
    since && assignment?.updatedAt && assignment.updatedAt > since,
  );
  const documents = await prisma.memoryDocument.findMany({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      OR: [
        { scope: "bot", botId: scope.botId },
        ...(shared ? [{ scope: "user", botId: null }] : []),
      ],
    },
    select: {
      path: true,
      scope: true,
      updatedAt: true,
      revisions: { orderBy: { revision: "desc" }, take: 1, select: { sourceRunId: true } },
    },
  });
  // Archives and review snapshots never create work by themselves.
  const changed = documents.some((doc) => {
    const path = normalizeMemoryPath(doc.path);
    return (
      !path.startsWith("memory/archive/") &&
      !path.startsWith("memory/reviews/") &&
      doc.updatedAt <= startedAt &&
      ((doc.scope === "user" && newlyAssignedShared) ||
        ((!since || doc.revisions[0]?.sourceRunId !== previous?.id) &&
          (!since || doc.updatedAt > since)))
    );
  });
  return { changed, shared, since, lastCompletedAt, newlyAssignedShared };
}

/**
 * Pull the existing enabled routine forward when memory changed. Built-in routines keep their
 * fixed schedule and are skipped; the durable scheduler dispatches everything else normally.
 */
export async function nudgeMemoryOrganization(
  prisma: PrismaClient,
  scope: Scope,
  now = new Date(),
) {
  const routine = await prisma.routine.findFirst({
    where: { ...scope, active: true, memoryMaintenance: true },
    select: { id: true, prompt: true, nextRunAt: true, builtinKind: true },
  });
  if (
    !routine ||
    routine.builtinKind === "memory-organization" ||
    !isAutomaticMemoryPrompt(routine.prompt)
  )
    return false;
  const { changed, lastCompletedAt } = await memoryOrganizationStatus(prisma, scope, "", now);
  if (
    !changed ||
    (lastCompletedAt && now.getTime() - lastCompletedAt.getTime() < MEMORY_ORGANIZATION_COOLDOWN_MS)
  )
    return false;
  const updated = await prisma.routine.updateMany({
    where: {
      id: routine.id,
      ...scope,
      active: true,
      memoryMaintenance: true,
      OR: [{ nextRunAt: null }, { nextRunAt: { gt: now } }],
    },
    data: { nextRunAt: now },
  });
  return updated.count === 1;
}

/** Explicit upgrade: keep toggles while adopting the fixed system schedule. */
export async function enableAutomaticMemoryOrganization(prisma: PrismaClient, now = new Date()) {
  const setup = await configureMemoryMaintenance(prisma, true, now);
  const routines = await prisma.routine.findMany({
    where: { memoryMaintenance: true, bot: { archivedAt: null } },
    select: { id: true, active: true, spaceId: true, userId: true, timezone: true },
  });
  for (const routine of routines)
    await prisma.routine.update({
      where: { id: routine.id },
      data: {
        builtinKind: "memory-organization",
        name: "Automatic memory organization",
        prompt: AUTOMATIC_MEMORY_PROMPT,
        crons: [MEMORY_ORGANIZATION_CRON],
        nextRunAt: routine.active
          ? nextCronDate(MEMORY_ORGANIZATION_CRON, now, routine.timezone ?? "UTC")
          : null,
      },
    });
  const members = new Map(
    routines.map((routine) => [
      JSON.stringify([routine.spaceId, routine.userId]),
      { spaceId: routine.spaceId, userId: routine.userId },
    ]),
  );
  for (const member of members.values()) {
    await withTransactionRetry(() =>
      prisma.$transaction(
        async (tx) => {
          await lockSpaceSettings(tx, member);
          const selected = await tx.routine.findFirst({
            where: { ...member, sharedMemoryOrganizer: true },
            select: { id: true },
          });
          if (selected) return;
          const candidate = chiefMemoryRoutine(
            await tx.routine.findMany(chiefRoutineQuery(member)),
          );
          if (
            candidate?.active &&
            !candidate.bot.disabledBuiltinTools.some((name) =>
              ["read_memory", "organize_memory"].includes(name),
            )
          )
            await tx.routine.update({
              where: { id: candidate.id },
              data: { sharedMemoryOrganizer: true },
            });
        },
        { isolationLevel: "Serializable" },
      ),
    );
  }
  return {
    ...setup,
    upgraded: routines.length,
    policy: "daily-or-30-turns-or-16000-chars",
    cooldownHours: 6,
    sourcePreservation: "verified full archive and revisions",
  };
}

/** Daily checks inspect changed notes; a weekly pass revisits the complete live collection. */
export async function memoryOrganizationPlan(
  prisma: PrismaClient,
  scope: Scope,
  currentRunId: string,
  startedAt: Date,
  readDocuments: (target: "bot" | "user") => Promise<MemorySnapshot["documents"]>,
) {
  const status = await memoryOrganizationStatus(prisma, scope, currentRunId, startedAt);
  const routine = await prisma.routine.findFirst({
    where: { ...scope, memoryMaintenance: true },
    select: { organizationFullCheckedAt: true, organizationSweepStartedAt: true },
  });
  const fullAt = routine?.organizationFullCheckedAt ?? null;
  const storedSweep = routine?.organizationSweepStartedAt ?? null;
  const due =
    !fullAt || startedAt.getTime() - fullAt.getTime() >= MEMORY_FULL_SWEEP_DAYS * 86_400_000;
  // A sweep keeps its coverage until it finishes: restarting every week would reset the
  // progress of a large collection and never complete.
  const sweepRunning = Boolean(storedSweep && (!fullAt || fullAt < storedSweep));
  // Targets come from what the memory tools can enumerate, never from mirror rows without a
  // live file: a target that cannot be read can never be reviewed, which fails the whole run.
  const live = [
    ...(await readDocuments("bot")).map((doc) => ({ ...doc, scope: "bot" as const })),
    ...(status.shared
      ? (await readDocuments("user")).map((doc) => ({ ...doc, scope: "user" as const }))
      : []),
  ]
    .filter((doc) => {
      const updatedAt = doc.updatedAt ? new Date(doc.updatedAt) : startedAt;
      return (
        isReviewableMemoryPath(doc.scope, doc.path) &&
        !isMemoryArchivePath(doc.path) &&
        !isMemoryReviewPath(doc.path) &&
        updatedAt <= startedAt
      );
    })
    // One document must be scheduled once even if a provider reports it under two scopes.
    .filter((doc, index, all) => all.findIndex((row) => row.id === doc.id) === index);
  const updatedAt = (doc: (typeof live)[number]) =>
    doc.updatedAt ? new Date(doc.updatedAt) : startedAt;
  const full = sweepRunning || (due && live.some((doc) => !fullAt || updatedAt(doc) > fullAt));
  const sweepStartedAt = full ? (sweepRunning ? storedSweep : startedAt) : null;
  if (full && !sweepRunning) {
    // Opening the window and reopening its stale rows must be one transaction: a crash between
    // them would leave a window that never reopens anything, and the same documents would be
    // selected on every slice forever.
    // Interactive form: the row-security extension carries the space context, which a batch
    // transaction cannot do.
    await prisma.$transaction(async (tx) => {
      await tx.routine.updateMany({
        where: { ...scope, memoryMaintenance: true },
        data: { organizationSweepStartedAt: startedAt },
      });
      // Reset every prior record, not only the settled ones: a sweep must read each document
      // inside its own window, otherwise inherited ranges let it sign off after one page.
      await tx.memoryDocumentCheck.updateMany({
        where: { spaceId: scope.spaceId, botId: scope.botId },
        data: { status: "reading", ranges: [], runId: null, settledBy: null },
      });
    });
  }

  const checks = live.length
    ? await prisma.memoryDocumentCheck.findMany({
        where: {
          spaceId: scope.spaceId,
          botId: scope.botId,
          documentId: { in: live.map((doc) => doc.id) },
        },
        select: {
          documentId: true,
          revision: true,
          status: true,
          ranges: true,
          checkedAt: true,
        },
      })
    : [];
  const checkFor = (doc: (typeof live)[number]) =>
    checks.find((row) => row.documentId === doc.id && row.revision === doc.revision);
  // `checked` only counts inside the running sweep; a read is never a finished review.
  const settled = (doc: (typeof live)[number]) => {
    const row = checkFor(doc);
    if (row?.status !== "checked") return false;
    return sweepStartedAt ? row.checkedAt >= sweepStartedAt : true;
  };

  const changedNow = (doc: (typeof live)[number]) =>
    full ||
    (doc.scope === "user" && status.newlyAssignedShared) ||
    !status.since ||
    updatedAt(doc) > status.since;
  // Unsettled documents stay in scope even when nothing changed: leftovers from a partial slice
  // must continue, not wait for a new edit that may never come.
  const scoped = live.filter((doc) => changedNow(doc) || !settled(doc));
  const pending = scoped.filter((doc) => !settled(doc));
  const backlog = pending.reduce((total, doc) => total + charLength(doc.content), 0);
  const batches = Math.min(
    MEMORY_REVIEW_MAX_BATCHES,
    Math.max(1, Math.ceil(backlog / MEMORY_REVIEW_BUDGET_CHARS)),
  );
  const budget = MEMORY_REVIEW_BUDGET_CHARS * batches;
  const rank = (doc: (typeof live)[number]) => {
    const row = checkFor(doc);
    if (row?.status === "reading") return 0;
    if (!row) return 1;
    return row.status === "read" ? 2 : 3;
  };
  const ordered = [...pending].sort(
    (left, right) => rank(left) - rank(right) || left.content.length - right.content.length,
  );
  const selected: typeof ordered = [];
  let used = 0;
  for (const doc of ordered) {
    if (selected.length >= MEMORY_REVIEW_MAX_DOCUMENTS) break;
    // Always take one document even when it alone exceeds the budget; otherwise a single
    // oversized note could never be scheduled.
    if (selected.length && used + doc.content.length > budget) break;
    selected.push(doc);
    used += doc.content.length;
  }
  return {
    ...status,
    // Work exists exactly when an unsettled document is in scope. Deriving it from the snapshot
    // (not the mirror) means a file edited on disk before the mirror synced is never skipped.
    changed: pending.length > 0,
    full,
    sweepStartedAt,
    budget,
    batches,
    paths: selected.map((doc) => `${doc.scope}:${doc.path}`),
    ids: selected.map((doc) => doc.id),
    resume: selected.flatMap((doc) => {
      const row = checkFor(doc);
      if (row?.status !== "reading") return [];
      return [{ path: doc.path, offset: readCoverageOffset(row.ranges as unknown) }];
    }),
    remaining: pending.length - selected.length,
    settled: live.filter(settled).length,
    total: live.length,
  };
}
