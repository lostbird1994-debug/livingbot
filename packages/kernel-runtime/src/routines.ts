import type { GatewayRequests } from "./contracts.ts";
import { validateAgentId } from "./config.ts";

export type RoutineSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number }
  | { kind: "cron"; expr: string; tz: string };
export type RoutineDefinition = {
  declarationKey: string; agentId: string; sessionKey: string;
  name: string; message: string; schedule: RoutineSchedule;
};
export type RoutineEdit = Pick<RoutineDefinition, "name" | "message" | "schedule">;
export type NativeRoutine = RoutineDefinition & {
  id: string; enabled: boolean; revision: string;
  nextRunAt?: number; lastRunAt?: number; runningAt?: number; disabledReason?: string;
};
export type RoutineOutcome = {
  occurrenceKey: string; runId?: string; jobId: string; timestamp: number; startedAt?: number;
  status: "ok" | "error" | "skipped" | "unknown"; completion?: "succeeded" | "failed" | "unknown";
  summary?: string; error?: string; delivery: "delivered" | "not-delivered" | "unknown" | "not-requested";
  sessionKey?: string; sessionId?: string;
};
export interface RoutineProvider {
  create(definition: RoutineDefinition): Promise<NativeRoutine>;
  get(id: string): Promise<NativeRoutine>;
  setEnabled(id: string, revision: string, enabled: boolean): Promise<NativeRoutine>;
  update(id: string, revision: string, changes: RoutineEdit): Promise<NativeRoutine>;
  history(id: string, offset?: number): Promise<{ entries: RoutineOutcome[]; hasMore: boolean }>;
  /** Delete the native schedule; its past runs stay in the history. */
  remove(id: string, revision: string): Promise<void>;
  /** Run the schedule once, now, without changing its next occurrence. */
  runNow(id: string): Promise<{ runId: string | null }>;
}
/** Pinned native cron uses this stable ID for its committed conversation result. */
export function routineExecutionId(jobId: string, startedAt: number): string {
  if (!jobId || !Number.isSafeInteger(startedAt) || startedAt < 0) throw new Error("Invalid native occurrence identity");
  return `cron:${jobId}:${startedAt}`;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid native automation response");
  return value;
}
function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
export function routineSchedule(value: unknown): RoutineSchedule {
  const schedule = object(value);
  if (schedule.kind === "at") {
    if (typeof schedule.at !== "string" || !/^\d{4}-\d\d-\d\dT/.test(schedule.at) ||
      !Number.isFinite(Date.parse(schedule.at))) throw new Error("Choose a valid date and time");
    return { kind: "at", at: new Date(schedule.at).toISOString() };
  }
  if (schedule.kind === "every" && typeof schedule.everyMs === "number" &&
    Number.isSafeInteger(schedule.everyMs) && schedule.everyMs >= 60_000 && schedule.everyMs <= 365 * 86_400_000) {
    return { kind: "every", everyMs: schedule.everyMs };
  }
  if (schedule.kind === "cron" && typeof schedule.expr === "string" &&
    schedule.expr.trim().length > 0 && schedule.expr.length <= 256 && typeof schedule.tz === "string") {
    try { new Intl.DateTimeFormat("en", { timeZone: schedule.tz }); } catch { throw new Error("Choose a valid time zone"); }
    return { kind: "cron", expr: schedule.expr.trim(), tz: schedule.tz };
  }
  throw new Error("Choose a valid schedule");
}
function job(value: unknown): NativeRoutine {
  const raw = object(value);
  const record = object(raw.job ?? raw);
  const payload = object(record.payload);
  const state = object(record.state);
  if (payload.kind !== "agentTurn" || typeof record.enabled !== "boolean") throw new Error("Unsupported native automation");
  if (record.sessionTarget !== `session:${record.sessionKey}`) throw new Error("Schedule execution session differs from its destination");
  if (object(record.delivery).mode !== "none") throw new Error("Schedule delivery differs from its conversation-only definition");
  const agentId = text(record.agentId);
  validateAgentId(agentId);
  return {
    id: text(record.id), declarationKey: text(record.declarationKey), agentId,
    sessionKey: text(record.sessionKey), name: text(record.name), message: text(payload.message),
    schedule: routineSchedule(record.schedule), enabled: record.enabled, revision: text(record.configRevision),
    nextRunAt: timestamp(state.nextRunAtMs), lastRunAt: timestamp(state.lastRunAtMs),
    runningAt: timestamp(state.runningAtMs),
    ...(typeof object(state.autoDisabled).reason === "string" ? { disabledReason: String(object(state.autoDisabled).reason) } : {}),
  };
}

/** Native cron owns timers, catch-up, execution and delivery. This adapter only controls it. */
export class OpenClawRoutines implements RoutineProvider {
  private readonly gateway: GatewayRequests;
  constructor(gateway: GatewayRequests) { this.gateway = gateway; }

  async create(definition: RoutineDefinition): Promise<NativeRoutine> {
    validateAgentId(definition.agentId);
    const schedule = routineSchedule(definition.schedule);
    await this.gateway.request("sessions.create", {
      agentId: definition.agentId, key: definition.sessionKey,
      idempotencyKey: `livingbot-session:${definition.sessionKey}`,
    });
    for (let offset = 0;;) {
      const page = object(await this.gateway.request("cron.list", {
        sessionKey: definition.sessionKey, sessionAgentId: definition.agentId, includeDisabled: true,
        limit: 100, offset,
      }));
      if (!Array.isArray(page.jobs)) throw new Error("Invalid native schedule inventory");
      const existing = page.jobs.find((value) => object(value).declarationKey === definition.declarationKey);
      if (existing) {
        const selected = job(existing);
        if (selected.agentId !== definition.agentId || selected.sessionKey !== definition.sessionKey ||
          selected.name !== definition.name || selected.message !== definition.message ||
          JSON.stringify(selected.schedule) !== JSON.stringify(schedule)) throw new Error("The saved schedule differs from this request");
        return selected;
      }
      if (page.hasMore !== true) break;
      if (!page.jobs.length) throw new Error("Native schedule inventory did not advance");
      offset += page.jobs.length;
    }
    const { message, ...attributes } = definition;
    return job(await this.gateway.request("cron.add", {
      ...attributes, schedule, enabled: true, deleteAfterRun: false,
      // A direct operator-created detached job does not inherit session MCP
      // denials. Execute in the actual destination session so its current
      // native policy, workspace and conversation are authoritative.
      sessionTarget: `session:${definition.sessionKey}`, wakeMode: "now",
      payload: { kind: "agentTurn", message },
      // The persistent session owns its final result. Native cron commits it
      // there; an announce would request an additional external delivery.
      delivery: { mode: "none" },
    }));
  }
  async get(id: string): Promise<NativeRoutine> { return job(await this.gateway.request("cron.get", { id })); }
  async setEnabled(id: string, revision: string, enabled: boolean): Promise<NativeRoutine> {
    if (typeof enabled !== "boolean") throw new Error("Choose whether this schedule is enabled");
    return job(await this.gateway.request("cron.update", { id, expectedConfigRevision: revision, patch: { enabled } }));
  }
  async update(id: string, revision: string, changes: RoutineEdit): Promise<NativeRoutine> {
    return job(await this.gateway.request("cron.update", {
      id, expectedConfigRevision: revision, patch: {
        name: text(changes.name), schedule: routineSchedule(changes.schedule),
        payload: { kind: "agentTurn", message: text(changes.message) },
      },
    }));
  }
  async history(id: string, offset = 0): Promise<{ entries: RoutineOutcome[]; hasMore: boolean }> {    const page = object(await this.gateway.request("cron.runs", { id, limit: 100, offset, view: "summary", sortDir: "asc" }));
    if (!Array.isArray(page.entries) || page.entries.length > 100) throw new Error("Invalid native automation history");
    return {
      entries: page.entries.map((value) => {
        const entry = object(value);
        const status = entry.status ?? "unknown";
        const delivery = entry.deliveryStatus ?? "unknown";
        const occurredAt = timestamp(entry.ts);
        const startedAt = timestamp(entry.runAtMs);
        const runId = typeof entry.runId === "string" && entry.runId.trim() ? entry.runId : undefined;
        if (entry.jobId !== id || occurredAt === undefined || !["ok", "error", "skipped", "unknown"].includes(String(status)) ||
          !["delivered", "not-delivered", "unknown", "not-requested"].includes(String(delivery))) {
          throw new Error("Native automation result ownership mismatch");
        }
        return {
          occurrenceKey: runId ? `run:${runId}` : `time:${startedAt ?? occurredAt}`,
          ...(runId ? { runId } : {}), jobId: id, timestamp: occurredAt,
          startedAt, status: status as RoutineOutcome["status"],
          ...(["succeeded", "failed", "unknown"].includes(String(entry.completionStatus))
            ? { completion: entry.completionStatus as RoutineOutcome["completion"] } : {}),
          ...(typeof entry.summary === "string" ? { summary: entry.summary } : {}),
          ...(typeof entry.error === "string" ? { error: entry.error } : {}),
          delivery: delivery as RoutineOutcome["delivery"],
          ...(typeof entry.sessionKey === "string" ? { sessionKey: entry.sessionKey } : {}),
          ...(typeof entry.sessionId === "string" ? { sessionId: entry.sessionId } : {}),
        };
      }),
      hasMore: page.hasMore === true,
    };
  }

  async remove(id: string, revision: string): Promise<void> {
    // Deletion is revision-bound: a stale dialog cannot delete a schedule that
    // changed since it was read.
    await this.gateway.request("cron.remove", { id, expectedConfigRevision: revision });
  }

  async runNow(id: string): Promise<{ runId: string | null }> {
    const result = object(await this.gateway.request("cron.run", { id }));
    const runId = typeof result.runId === "string" && result.runId.trim() ? result.runId : null;
    return { runId };
  }
}
