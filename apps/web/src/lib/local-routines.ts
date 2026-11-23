/**
 * Contract adaptation for the original routine editor/history.
 * Donors: contracts/domain.ts, contracts/rpc.ts, contracts/runs.ts,
 * workbench/routines.ts, and workbench HTTP routine routes.
 * Native cron remains the only scheduler; unsupported options fail before writes.
 */
import { CreateRoutineInput, ROUTINE_MENTION_BATCH_MAX, RoutineHistorySchema, RoutineSchema } from "@livingbot/contracts";
import type { Routine, RoutineHistory } from "@livingbot/contracts";
import type { Conversation, Message } from "../../../../packages/workbench/src/contracts";
import type { Routine as NativeRoutine, RoutineReceipt } from "../../../../packages/workbench/src/routines";
import type { RoutineSchedule } from "../../../../packages/kernel-runtime/src/routines";
import { z } from "zod";

export type LocalRoutinesConnection = { origin: string; token: string };
export type LocalRoutinesRequest = <T>(
  connection: LocalRoutinesConnection,
  path: string,
  init?: RequestInit,
) => Promise<T>;

const identity = z.object({ routineId: z.string().min(1) });
const updateInput = RoutineSchema.pick({
  name: true, prompt: true, crons: true, timezone: true, active: true,
  notify: true, requireOutput: true, webhookEnabled: true, githubEnabled: true,
  messageProvider: true, modelProvider: true, modelId: true, thinkingLevel: true, watch: true,
}).partial().extend({ routineId: z.string().min(1), runAt: z.iso.datetime().optional() }).strict();

function supportedOptions(input: z.infer<typeof updateInput> | z.infer<typeof CreateRoutineInput>) {
  if (input.webhookEnabled || input.githubEnabled || input.messageProvider || input.watch)
    throw new Error("Local routines support scheduled triggers only.");
  if (input.modelProvider || input.modelId || input.thinkingLevel)
    throw new Error("Local routines use the Bot's model.");
  if (input.requireOutput || input.notify === false)
    throw new Error("Local routines retain their native conversation output and notifications.");
}

/** Intervals keep their native meaning; they are never approximated by cron. */
export function productLocalRoutine(routine: NativeRoutine): Routine {
  return RoutineSchema.parse({
    id: routine.id, botId: routine.botId, name: routine.name, prompt: routine.message,
    crons: routine.schedule.kind === "cron" ? [routine.schedule.expr]
      : routine.schedule.kind === "at" ? ["@once"] : [],
    timezone: routine.schedule.kind === "cron" ? routine.schedule.tz : "UTC",
    active: routine.enabled, notify: true, requireOutput: false,
    webhookEnabled: false, githubEnabled: false, messageProvider: null,
    modelProvider: null, modelId: null, thinkingLevel: null, watch: null, watchState: null,
    lastRunAt: routine.lastRunAt === undefined ? null : new Date(routine.lastRunAt).toISOString(),
    nextRunAt: routine.nextRunAt === undefined ? null : new Date(routine.nextRunAt).toISOString(),
    createdAt: new Date(routine.createdAt).toISOString(),
    editable: routine.state === "ready" && routine.schedule.kind !== "every",
  });
}

function scheduleFor(
  input: { crons?: string[]; timezone?: string; runAt?: string },
  previous?: NativeRoutine,
): RoutineSchedule {
  if (input.crons === undefined && input.runAt === undefined) {
    if (!previous) throw new Error("Choose one schedule.");
    return previous.schedule.kind === "cron"
      ? { ...previous.schedule, tz: input.timezone ?? previous.schedule.tz } : previous.schedule;
  }
  const crons = input.crons ?? (previous?.schedule.kind === "at" ? ["@once"] : []);
  if (crons.length !== 1) throw new Error("Local routines require exactly one schedule.");
  const cron = crons[0]!.trim();
  if (cron === "@once") {
    const at = input.runAt ?? (previous?.schedule.kind === "at" ? previous.schedule.at : undefined);
    if (!at) throw new Error("Choose an explicit date and time for this one-shot.");
    return { kind: "at", at };
  }
  if (input.runAt !== undefined) throw new Error("A run time requires a one-shot schedule.");
  if (!cron) throw new Error("Choose one schedule.");
  const tz = input.timezone ?? (previous?.schedule.kind === "cron" ? previous.schedule.tz : "UTC");
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); }
  catch { throw new Error("Choose a valid time zone."); }
  return { kind: "cron", expr: cron, tz };
}

/**
 * Inject the parent's authenticated transport; do not create a second connection.
 * Parent also uses routines.list to populate bootstrap/thread routine arrays.
 */
export function createLocalRoutinesHandler(
  connection: LocalRoutinesConnection,
  request: LocalRoutinesRequest,
): (procedure: string, input: unknown) => Promise<unknown> {
  const get = <T>(path: string) => request<T>(connection, path);
  const post = <T>(path: string, body?: unknown) =>
    request<T>(connection, path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const endpoint = (id: string) => `/api/routines/${encodeURIComponent(id)}`;
  const refresh = (id: string) => post<NativeRoutine>(`${endpoint(id)}/refresh`);
  return async (procedure, input) => {
    const path = procedure.replace(/^\//, "").replaceAll("/", ".");
    if (path === "routines.remove") {
      const { routineId } = identity.parse(input);
      const routine = await refresh(routineId);
      if (!routine.revision) throw new Error("Refresh this schedule before removing it.");
      // The native job goes; the rows it already produced stay readable.
      await post(`${endpoint(routineId)}/remove`, { revision: routine.revision });
      return { ok: true as const };
    }
    if (path === "routines.testRun") {
      const body = identity.extend({ clientNonce: z.string().min(1).max(200).optional() }).parse(input);
      const routine = await refresh(body.routineId);
      if (!routine.revision) throw new Error("Refresh this schedule before running it.");
      const result = await post<{ runId: string | null }>(`${endpoint(body.routineId)}/run`, {
        revision: routine.revision,
        ...(body.clientNonce ? { clientNonce: body.clientNonce } : {}),
      });
      if (!result.runId) throw new Error("这次运行已开始，但原生运行标识还没有返回");
      return { runId: result.runId };
    }
    if (path === "routines.list" || path === "routines.listForMentions") {
      const ids = path === "routines.list"
        ? [z.object({ botId: z.string().min(1) }).parse(input).botId]
        : z.object({ botIds: z.array(z.string().min(1)).min(1).max(ROUTINE_MENTION_BATCH_MAX) }).parse(input).botIds;
      const { routines } = await get<{ routines: NativeRoutine[] }>("/api/routines");
      const select = (botId: string) => routines
        .filter((r) => r.botId === botId && r.state !== "removed")
        .map(productLocalRoutine);
      return path === "routines.list" ? select(ids[0]!)
        : ids.map((botId) => ({ botId, routines: select(botId) }));
    }
    if (path === "routines.get") return productLocalRoutine(await refresh(identity.parse(input).routineId));
    if (path === "routines.create") {
      const body = CreateRoutineInput.parse(input);
      supportedOptions(body);
      if (!body.active) throw new Error("Creating a paused local routine is unavailable.");
      const schedule = scheduleFor(body);
      const conversation = await post<{ id: string }>(
        `/api/bots/${encodeURIComponent(body.botId)}/private-conversation`,
      );
      return productLocalRoutine(await post<NativeRoutine>("/api/routines", {
        id: crypto.randomUUID(), botId: body.botId, conversationId: conversation.id,
        name: body.name, message: body.prompt, schedule,
      }));
    }
    if (path === "routines.update") {
      const body = updateInput.parse(input);
      supportedOptions(body);
      // Validate unsupported schedule shapes before refresh or any mutation.
      if (body.crons !== undefined && body.crons.length !== 1)
        throw new Error("Local routines require exactly one schedule.");
      let saved = await refresh(body.routineId);
      const schedule = scheduleFor(body, saved);
      const name = body.name ?? saved.name;
      const message = body.prompt ?? saved.message;
      if (name !== saved.name || message !== saved.message ||
        JSON.stringify(schedule) !== JSON.stringify(saved.schedule)) {
        if (!saved.revision) throw new Error("Refresh this schedule before changing it.");
        saved = await post<NativeRoutine>(`${endpoint(saved.id)}/update`, {
          revision: saved.revision, name, message, schedule,
        });
      }
      if (body.active !== undefined && body.active !== saved.enabled) {
        if (!saved.revision) throw new Error("Refresh this schedule before changing it.");
        saved = await post<NativeRoutine>(`${endpoint(saved.id)}/access`, {
          revision: saved.revision, enabled: body.active,
        });
      }
      return productLocalRoutine(saved);
    }
    if (path === "routines.history") {
      const body = identity.extend({
        before: z.object({ id: z.string(), createdAt: z.iso.datetime() }).optional(),
        limit: z.number().int().min(1).max(20).default(20),
      }).parse(input);
      const routine = await refresh(body.routineId);
      const [{ entries }, snapshot, history] = await Promise.all([
        get<{ entries: (RoutineReceipt & { messageId?: string | null })[] }>(`${endpoint(routine.id)}/history`),
        get<{ conversations: Conversation[] }>("/api/snapshot"),
        get<{ messages: Message[] }>(`/api/conversations/${encodeURIComponent(routine.conversationId)}/messages`),
      ]);
      const group = snapshot.conversations.find((c) => c.id === routine.conversationId)?.kind === "group";
      const runs: RoutineHistory["runs"] = entries.map((entry) => {
        if (entry.routineId !== routine.id || entry.botId !== routine.botId ||
          entry.conversationId !== routine.conversationId || entry.jobId !== routine.nativeId)
          throw new Error("Native routine history ownership mismatch.");
        const confirmed = entry.status === "ok" && entry.completion === "succeeded";
        const message = confirmed && (entry.messageId || entry.runId) ? history.messages.find((m) =>
          (entry.messageId ? m.id === entry.messageId : m.runId === entry.runId) && m.botId === routine.botId &&
          m.conversationId === routine.conversationId && m.role === "assistant" && m.final) : undefined;
        return {
          id: entry.id, botId: entry.botId, groupId: group ? routine.conversationId : null,
          status: confirmed ? "completed" : entry.status === "skipped" ? "cancelled" : "failed",
          error: confirmed ? null : entry.error ?? (entry.status === "skipped" ? null : "Native completion is unconfirmed."),
          createdAt: new Date(entry.timestamp).toISOString(),
          startedAt: entry.startedAt === undefined ? null : new Date(entry.startedAt).toISOString(),
          completedAt: entry.completion === "unknown" || entry.status === "unknown"
            ? null : new Date(entry.timestamp).toISOString(),
          messageId: message?.id ?? null,
        };
      });
      runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const older = body.before ? runs.filter((run) => run.createdAt < body.before!.createdAt ||
        (run.createdAt === body.before!.createdAt && run.id < body.before!.id)) : runs;
      const page = older.slice(0, body.limit);
      const last = page.at(-1);
      return RoutineHistorySchema.parse({
        runs: page, nextCursor: older.length > page.length && last
          ? { id: last.id, createdAt: last.createdAt } : null,
      });
    }
    throw new Error(`Unsupported local routine procedure: ${path}`);
  };
}
