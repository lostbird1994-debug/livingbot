import { ORPCError } from "@orpc/server";
import { validateBotModelChange } from "@rakazo/adapters";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { Actor, TaskSession } from "@rakazo/contracts";
import { MODEL_REQUIRED_SEND_ERROR } from "@rakazo/core";
import type { BotTaskSession } from "@rakazo/db";
import { availableInSpace, appendEventInTransaction, createThreadMessageInTransaction, IsolationError,
  THREAD_LOCK_TRANSACTION_OPTIONS } from "@rakazo/db";
import { buildSendPrompt, buildUserMessageBlocks, resolveSendAttachments } from "../artifacts.js";
import { withSerializableRetry } from "../serializable-retry.js";
import { stopThreadRuns, resolveThreadTarget } from "../thread-target.js";
import type { RouterContext } from "./context.js";
import { botsRunOwnModels, modelSetup } from "./shared.js";

export function taskSessionsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  async function dto(row: BotTaskSession): Promise<TaskSession> {
    const [latest, thread] = await Promise.all([
      deps.prisma.run.findFirst({ where: { threadId: row.threadId, botId: row.botId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
      deps.prisma.thread.findUniqueOrThrow({ where: { id: row.threadId }, select: { unread: true } }),
    ]);
    return { id: row.id, botId: row.botId, threadId: row.threadId, mainThreadId: row.mainThreadId,
      title: row.title, modelProvider: row.modelProvider, modelId: row.modelId, thinkingLevel: row.thinkingLevel,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), archivedAt: row.archivedAt?.toISOString() ?? null,
      unread: thread.unread, latestRunId: latest?.id ?? null, status: latest?.status ?? "idle",
      resourceWaitReason: latest?.resourceWaitReason ?? null };
  }
  async function owned(actor: Actor, input: { botId: string; taskSessionId: string }) {
    await resolveThreadTarget(deps.prisma, actor, input, { includeArchived: true });
    return deps.prisma.botTaskSession.findFirstOrThrow({ where: {
      id: input.taskSessionId, botId: input.botId, userId: actor.userId, spaceId: actor.spaceId,
    } });
  }
  async function activeRuns(actor: Actor, botId: string) {
    await resolveThreadTarget(deps.prisma, actor, { botId }, { includeArchived: true });
    const runs = await deps.prisma.run.findMany({ where: { botId, spaceId: actor.spaceId, userId: actor.userId,
      thread: { OR: [{ botId }, { taskBotId: botId }] },
      OR: [{ status: { notIn: ["completed", "failed", "cancelled"] } }, { resourceWaitReason: { in: ["unconfirmed", "stopping"] } }],
    }, include: { routine: { select: { name: true } }, thread: { include: { taskSession: true } } } });
    return runs.map(run => ({ id: run.id, threadId: run.threadId, taskSessionId: run.thread.taskSession?.id ?? null,
      title: run.thread.taskSession?.title ?? run.routine?.name ?? "主聊天", status: run.resourceWaitReason ?? run.status }));
  }
  return { taskSessions: {
    activeRuns: authed.taskSessions.activeRuns.handler(async ({ context, input }) => activeRuns(context.actor, input.botId)),
    stopAll: authed.taskSessions.stopAll.handler(async ({ context, input }) => {
      const active = await activeRuns(context.actor, input.botId);
      const requested = new Set(input.runIds);
      const selected = active.filter(run => requested.has(run.id));
      const byThread = new Map<string, typeof selected>();
      for (const run of selected) byThread.set(run.threadId, [...(byThread.get(run.threadId) ?? []), run]);
      let stopped = 0;
      for (const runs of byThread.values()) {
        const target = await resolveThreadTarget(deps.prisma, context.actor,
          { botId: input.botId, ...(runs[0]!.taskSessionId ? { taskSessionId: runs[0]!.taskSessionId! } : {}) }, { includeArchived: true });
        // Same ordering as threads.stop: the run ids are cancelled inside stopThreadRuns
        // (it calls cancelNativeRuns itself). Every run owns its own native session, so
        // there is no earlier turn that has to confirm termination first.
        const result = await stopThreadRuns(deps, context.actor, target, { runIds: runs.map(run => run.id) });
        stopped += result.cancelledRunCount;
      }
      return { stopped };
    }),
    capabilities: authed.taskSessions.capabilities.handler(async () => ({ enabled: await deps.independentTasksAvailable?.() ?? false, concurrency: 2 })),
    list: authed.taskSessions.list.handler(async ({ context, input }) => {
      await resolveThreadTarget(deps.prisma, context.actor, input, { includeArchived: true });
      const rows = await deps.prisma.botTaskSession.findMany({ where: {
        botId: input.botId, spaceId: context.actor.spaceId, userId: context.actor.userId,
      }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
      return Promise.all(rows.map(dto));
    }),
    start: authed.taskSessions.start.handler(async ({ context, input }) => {
      if (!(await deps.independentTasksAvailable?.())) throw new ORPCError("BAD_REQUEST", { message: "Independent tasks require a compatible runtime." });
      const actor = context.actor;
      const target = await resolveThreadTarget(deps.prisma, actor, { botId: input.botId });
      if (target.kind !== "bot") throw new IsolationError();
      const setup = await modelSetup(deps, actor);
      if (setup.needsModel && !(await botsRunOwnModels(deps, actor, [input.botId])))
        throw new ORPCError("BAD_REQUEST", { message: MODEL_REQUIRED_SEND_ERROR });
      const requestedModel = input.modelProvider !== undefined || input.modelId !== undefined || input.thinkingLevel !== undefined;
      const modelProvider = input.modelProvider ?? (target.bot.modelProvider && target.bot.modelId ? target.bot.modelProvider : setup.model?.provider) ?? null;
      const modelId = input.modelId ?? (target.bot.modelProvider && target.bot.modelId ? target.bot.modelId : setup.model?.modelId) ?? null;
      if (requestedModel) {
        const validated = await validateBotModelChange(ctx.botModelValidation(actor), {
          userId: actor.userId, spaceId: actor.spaceId, provider: modelProvider, model: modelId, thinkingLevel: input.thinkingLevel,
          current: { provider: target.bot.modelProvider ?? setup.model?.provider ?? null, model: target.bot.modelId ?? setup.model?.modelId ?? null },
        });
        if (!validated.ok) throw new ORPCError("BAD_REQUEST", { message: validated.error });
      }
      const committed = await withSerializableRetry(() => deps.prisma.$transaction(async tx => {
        // One Bot lock orders retries, concurrent starts and the execution-slot claim.
        await tx.$queryRaw`SELECT id FROM bots WHERE id = ${input.botId} FOR UPDATE`;
        const bot = await tx.bot.findFirst({ where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null } });
        if (!bot) throw new IsolationError();
        const prior = await tx.botTaskSession.findUnique({ where: { botId_clientNonce: { botId: bot.id, clientNonce: input.clientNonce } } });
        if (prior) {
          const run = await tx.run.findFirstOrThrow({ where: { threadId: prior.threadId }, orderBy: { createdAt: "asc" } });
          const message = await tx.message.findFirstOrThrow({ where: { threadId: prior.threadId, clientNonce: input.clientNonce } });
          const previous = message.blocks as Array<{ kind: string; text?: string; artifactId?: string }>;
          const requestMatched = previous.filter(block => block.kind === "text").map(block => block.text).join("\n") === (input.text?.trim() ?? "") &&
            JSON.stringify(previous.filter(block => block.artifactId).map(block => block.artifactId).sort()) === JSON.stringify([...(input.artifactIds ?? [])].sort());
          return { session: prior, run, seq: message.seq, eventSeq: null, requestMatched };
        }
        // Both ownership and attachment admission are checked inside the creation transaction.
        const { blocks, artifacts } = await resolveSendAttachments({ prisma: tx, maxAttachmentsPerMessage: deps.env.maxAttachmentsPerMessage }, actor, bot.id, input.artifactIds);
        const connectorScope = [...new Set(input.connectorScope ?? [])];
        if (connectorScope.length) {
          const installs = await tx.capabilityInstall.count({ where: { id: { in: connectorScope }, ...availableInSpace(actor), kind: { in: ["mcp", "api", "graphql"] } } });
          if (installs !== connectorScope.length) throw new IsolationError();
        }
        const thread = await tx.thread.create({ data: { spaceId: actor.spaceId, userId: actor.userId, taskBotId: bot.id } });
        const session = await tx.botTaskSession.create({ data: {
          spaceId: actor.spaceId, userId: actor.userId, botId: bot.id, mainThreadId: target.threadId, threadId: thread.id,
          title: input.title ?? (input.text?.trim().slice(0, 40) || "新任务"), clientNonce: input.clientNonce,
          modelProvider, modelId,
          thinkingLevel: input.thinkingLevel !== undefined ? input.thinkingLevel : bot.thinkingLevel,
        } });
        const messageBlocks = buildUserMessageBlocks(input.text, blocks);
        const message = await createThreadMessageInTransaction(tx, { threadId: thread.id, role: "user", blocks: messageBlocks, clientNonce: input.clientNonce });
        const task = await tx.task.create({ data: { spaceId: actor.spaceId, userId: actor.userId, botId: bot.id, threadId: thread.id,
          prompt: buildSendPrompt(input.text, artifacts), status: "queued" } });
        const run = await tx.run.create({ data: { spaceId: actor.spaceId, userId: actor.userId, botId: bot.id, threadId: thread.id,
          taskId: task.id, status: "queued", trigger: "user", sourceMessageId: message.id, clientNonce: input.clientNonce,
          connectorScope, modelProvider: session.modelProvider, modelId: session.modelId, thinkingLevel: session.thinkingLevel,
          modelPinned: Boolean(session.modelProvider && session.modelId) } });
        await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
        const event = await appendEventInTransaction(tx, { spaceId: actor.spaceId, threadId: thread.id, botId: bot.id, runId: run.id,
          type: "thread.message.created", payload: { messageId: message.id, seq: message.seq, role: "user", blocks: messageBlocks, runIds: [run.id] } });
        return { session, run, seq: message.seq, eventSeq: event.seq, requestMatched: true };
      }, THREAD_LOCK_TRANSACTION_OPTIONS));
      if (committed.eventSeq !== null) await deps.events.notify(committed.session.threadId, committed.eventSeq);
      await deps.jobs.enqueue(runContinueJob(committed.run.id));
      return { session: await dto(committed.session), taskId: committed.run.taskId, runId: committed.run.id, seq: committed.seq, requestMatched: committed.requestMatched };
    }),
    rename: authed.taskSessions.rename.handler(async ({ context, input }) => {
      await owned(context.actor, input);
      return dto(await deps.prisma.botTaskSession.update({ where: { id: input.taskSessionId }, data: { title: input.title } }));
    }),
    archive: authed.taskSessions.archive.handler(async ({ context, input }) => {
      const row = await owned(context.actor, input);
      const active = await deps.prisma.run.count({ where: { threadId: row.threadId, status: { notIn: ["completed", "cancelled", "failed"] } } });
      if (input.archived && active) throw new ORPCError("BAD_REQUEST", { message: "Stop or finish this task before archiving it." });
      return dto(await deps.prisma.botTaskSession.update({ where: { id: row.id }, data: { archivedAt: input.archived ? new Date() : null } }));
    }),
  } };
}
