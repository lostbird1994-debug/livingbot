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
export const MEMORY_ORGANIZATION_TURNS = 30;
export const MEMORY_ORGANIZATION_PRESSURE_CHARS = 16_000;

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

/** Nudge only the existing enabled routine. The durable scheduler dispatches it normally. */
export async function nudgeMemoryOrganization(
  prisma: PrismaClient,
  scope: Scope,
  now = new Date(),
  afterReview = false,
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
  const { changed, since, lastCompletedAt } = await memoryOrganizationStatus(
    prisma,
    scope,
    "",
    now,
  );
  if (
    !changed ||
    (lastCompletedAt && now.getTime() - lastCompletedAt.getTime() < MEMORY_ORGANIZATION_COOLDOWN_MS)
  )
    return false;
  const turns = await prisma.run.findMany({
    where: {
      ...scope,
      status: "completed",
      trigger: { in: ["user", "follow_up"] },
      sourceMessageId: { not: null },
      sourceMessage: { role: "user" },
      ...(since ? { completedAt: { gt: since } } : {}),
    },
    distinct: ["sourceMessageId"],
    select: { sourceMessageId: true },
    take: MEMORY_ORGANIZATION_TURNS,
  });
  const summaries = await prisma.memoryDocument.findMany({
    where: { ...scope, scope: "bot" },
    select: { path: true, content: true },
  });
  const pressure = summaries.some(
    (doc) =>
      ["memory.md", "user.md"].includes(normalizeMemoryPath(doc.path)) &&
      charLength(doc.content) >= MEMORY_ORGANIZATION_PRESSURE_CHARS,
  );
  if (!afterReview && turns.length < MEMORY_ORGANIZATION_TURNS && !pressure) return false;
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
) {
  const status = await memoryOrganizationStatus(prisma, scope, currentRunId, startedAt);
  const routine = await prisma.routine.findFirst({
    where: { ...scope, memoryMaintenance: true },
    select: { organizationFullCheckedAt: true },
  });
  const fullAt = routine?.organizationFullCheckedAt;
  const due = !fullAt || startedAt.getTime() - fullAt.getTime() >= 7 * 24 * 60 * 60_000;
  const documents = await prisma.memoryDocument.findMany({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      OR: [
        { scope: "bot", botId: scope.botId },
        ...(status.shared ? [{ scope: "user", botId: null }] : []),
      ],
    },
    select: { path: true, scope: true, updatedAt: true },
  });
  const live = documents.filter(
    (doc) =>
      !isMemoryArchivePath(doc.path) && !isMemoryReviewPath(doc.path) && doc.updatedAt <= startedAt,
  );
  const full = due && live.some((doc) => !fullAt || doc.updatedAt > fullAt);
  const paths = live
    .filter(
      (doc) =>
        full ||
        (doc.scope === "user" && status.newlyAssignedShared) ||
        !status.since ||
        doc.updatedAt > status.since,
    )
    .map((doc) => `${doc.scope}:${doc.path}`);
  return { ...status, changed: status.changed || full, full, paths };
}
