import { createHash } from "node:crypto";
import type { RuntimeObservation } from "../../kernel-runtime/src/contracts.ts";
import { routineExecutionId, routineSchedule } from "../../kernel-runtime/src/routines.ts";
import type { NativeRoutine, RoutineEdit, RoutineOutcome, RoutineProvider, RoutineSchedule } from "../../kernel-runtime/src/routines.ts";
import type { Bot, Run, Task } from "./contracts.ts";
import type { WorkbenchStore } from "./store.ts";

export type RoutineInput = {
  id: string; botId: string; conversationId: string; name: string; message: string; schedule: RoutineSchedule;
};
export type Routine = RoutineInput & {
  state: "pending" | "ready" | "unavailable" | "removed";
  createdAt: number; updatedAt: number; nativeId?: string; revision?: string;
  enabled: boolean; nextRunAt?: number; lastRunAt?: number; runningAt?: number;
  /** Set when the schedule was removed; receipts stay readable. */
  removedAt?: number;
  error?: string; disabledReason?: string;
};
export type RoutineReceipt = RoutineOutcome & { id: string; routineId: string; botId: string; conversationId: string };
export type NativeScheduledRun = {
  trigger: "cron"; jobId: string; runId: string; sessionId: string; agentId: string; sessionKey: string;
};

function content(input: RoutineEdit): RoutineEdit {
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200 ||
    typeof input.message !== "string" || !input.message.trim() || input.message.length > 16_000) {
    throw new Error("Enter a name and task for the schedule");
  }
  return { name: input.name.trim(), message: input.message.trim(), schedule: routineSchedule(input.schedule) };
}
function sameContent(left: RoutineEdit, right: RoutineEdit): boolean {
  return left.name === right.name && left.message === right.message &&
    JSON.stringify(left.schedule) === JSON.stringify(right.schedule);
}

/** Product journal for native schedules. No application timer dispatches work. */
export class Routines {
  private readonly store: WorkbenchStore;
  private readonly provider: RoutineProvider;
  private readonly changing = new Map<string, Promise<Routine>>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly refreshAgain = new Set<string>();
  private detached = false;
  constructor(store: WorkbenchStore, provider: RoutineProvider) { this.store = store; this.provider = provider; }
  detach(): void { this.detached = true; }
  list(): Routine[] { return this.store.list<Routine>("routines", -1); }
  receipts(id: string): RoutineReceipt[] {
    this.get(id);
    return this.store.find<RoutineReceipt>("routineReceipts", "routineId", id);
  }
  get(id: string): Routine {
    const result = this.store.get<Routine>("routines", id);
    if (!result) throw new Error("Unknown scheduled work");
    return result;
  }
  /** Only the authenticated, host-bound prompt hook may call this method. */
  async adoptRun(input: NativeScheduledRun, generation: number, assertCurrent: () => void): Promise<Task | undefined> {
    if (input.trigger !== "cron" || [input.jobId, input.runId, input.sessionId, input.agentId, input.sessionKey]
      .some((value) => typeof value !== "string" || !value.trim() || value.length > 4096)) {
      throw new Error("Invalid native scheduled run");
    }
    if (this.detached) throw new Error("The application closed before binding scheduled work");
    const routine = this.list().find((item) => item.nativeId === input.jobId);
    // Other kernel schedules, such as memory maintenance, are not product tasks.
    if (!routine) return undefined;
    this.store.engineSessionKey(routine.conversationId, routine.botId);
    if (this.changing.has(routine.id)) throw new Error("Schedule configuration is being changed");
    const expected = this.definition(routine);
    if (expected.agentId !== input.agentId || expected.sessionKey !== input.sessionKey) {
      throw new Error("Scheduled run ownership differs from its destination");
    }
    const native = await this.provider.get(input.jobId);
    assertCurrent();
    const latest = this.get(routine.id);
    if (this.changing.has(routine.id) || latest.revision !== routine.revision || latest.enabled !== routine.enabled) {
      throw new Error("Schedule configuration changed during run binding");
    }
    this.accept(this.get(routine.id), native);
    if (!native.enabled || native.runningAt === undefined) throw new Error("Native scheduled work is not active");
    return this.store.transaction(() => {
      this.store.engineSessionKey(routine.conversationId, routine.botId);
      const current = this.get(routine.id);
      if (this.detached || !current.enabled || current.runningAt === undefined) throw new Error("Scheduled work is no longer active");
      const id = `scheduled:${createHash("sha256").update(JSON.stringify([input.jobId, input.runId])).digest("hex")}`;
      const occurrenceId = routineExecutionId(input.jobId, current.runningAt);
      const existing = this.store.get<Task>("tasks", id);
      const run = this.store.get<Run>("runs", input.runId);
      if (run && (run.taskId !== id || run.sessionKey !== input.sessionKey)) throw new Error("Scheduled run identity is already owned");
      if (existing) {
        if (existing.botId !== routine.botId || existing.conversationId !== routine.conversationId ||
          existing.routine?.sessionId !== input.sessionId || existing.routine.jobId !== input.jobId ||
          existing.routine.occurrenceId !== occurrenceId ||
          existing.stopRequestedAt !== undefined ||
          !["running", "waiting", "interrupted"].includes(existing.status)) {
          throw new Error("Scheduled task identity is no longer active");
        }
        if (run?.state === "interrupted") {
          this.store.put("runs", { ...run, generation, state: "running", kernelExit: undefined });
          this.store.updateTask(existing.id, "running");
        }
        return existing;
      }
      if (this.store.list<Task>("tasks", -1).some((task) => task.routine?.occurrenceId === occurrenceId)) {
        throw new Error("Scheduled occurrence already belongs to another native run");
      }
      const now = Date.now();
      const task: Task = {
        id, botId: routine.botId, conversationId: routine.conversationId,
        reportConversationId: routine.conversationId, title: current.name, status: "running",
        createdAt: now, updatedAt: now,
        routine: { id: routine.id, jobId: input.jobId, sessionId: input.sessionId, occurrenceId, runId: input.runId },
      };
      this.store.put("tasks", task);
      this.store.put<Run>("runs", {
        id: input.runId, taskId: id, sessionKey: input.sessionKey, generation,
        state: "running", lastSequence: -1, createdAt: now,
      });
      return task;
    });
  }
  create(input: RoutineInput): Promise<Routine> {
    if (!input || typeof input.id !== "string" || input.id.length < 1 || input.id.length > 200) {
      throw new Error("Enter a name and task for the schedule");
    }
    this.store.engineSessionKey(input.conversationId, input.botId);
    const normalized: RoutineInput = {
      id: input.id, botId: input.botId, conversationId: input.conversationId,
      ...content(input),
    };
    const previous = this.store.get<Routine>("routines", input.id);
    if (previous && JSON.stringify(this.definition(previous)) !== JSON.stringify(this.definition(normalized))) {
      throw new Error("Schedule identity conflicts with the original request");
    }
    const working = this.changing.get(input.id);
    if (working) return working;
    if (previous?.nativeId) return Promise.resolve(previous);
    if (!previous) {
      if (normalized.schedule.kind === "at" && Date.parse(normalized.schedule.at) <= Date.now()) throw new Error("Choose a future date");
      this.store.put<Routine>("routines", {
        ...normalized, state: "pending", enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
      });
    }
    const work = this.install(this.get(input.id)).finally(() => this.changing.delete(input.id));
    this.changing.set(input.id, work);
    return work;
  }
  private definition(input: RoutineInput) {
    const agentId = this.store.get<Bot>("bots", input.botId)?.agentId;
    if (!agentId) throw new Error("Unknown Bot");
    return {
      declarationKey: `livingbot:${createHash("sha256").update(input.id).digest("hex")}`, agentId,
      // Identity checks and disabling must remain possible after archival.
      sessionKey: this.store.engineSessionKey(input.conversationId, input.botId, { allowArchived: true }),
      name: input.name, message: input.message, schedule: input.schedule,
    };
  }
  private accept(routine: Routine, native: NativeRoutine): Routine {
    if (this.detached) throw new Error("The application closed before confirming the schedule");
    const expected = this.definition(routine);
    if (native.declarationKey !== expected.declarationKey || native.agentId !== expected.agentId ||
      native.sessionKey !== expected.sessionKey || routine.nativeId && native.id !== routine.nativeId) {
      throw new Error("Native schedule ownership changed");
    }
    return this.store.put<Routine>("routines", {
      ...routine, name: native.name, message: native.message, schedule: native.schedule,
      nativeId: native.id, revision: native.revision, enabled: native.enabled, state: "ready",
      nextRunAt: native.nextRunAt, lastRunAt: native.lastRunAt, runningAt: native.runningAt,
      disabledReason: native.disabledReason, error: undefined, updatedAt: Date.now(),
    });
  }
  private async install(routine: Routine): Promise<Routine> {
    try {
      this.store.engineSessionKey(routine.conversationId, routine.botId);
      return this.accept(routine, await this.provider.create(this.definition(routine)));
    }
    catch (error) {
      if (!this.detached) this.store.put("routines", { ...routine, error: String(error), updatedAt: Date.now() });
      throw error;
    }
  }
  async setEnabled(id: string, enabled: boolean, revision: string): Promise<Routine> {
    if (typeof enabled !== "boolean") throw new Error("Choose whether this schedule is enabled");
    if (this.changing.has(id)) throw new Error("This schedule is still being confirmed");
    const routine = this.get(id);
    if (!routine.nativeId || !routine.revision || routine.revision !== revision) throw new Error("Refresh this schedule before changing it");
    this.store.engineSessionKey(routine.conversationId, routine.botId, { allowArchived: !enabled });
    const work = (async () => {
      const native = await this.provider.get(routine.nativeId!);
      this.accept(this.get(id), native);
      if (native.enabled === enabled) {
        if (!enabled) this.stopIntent(id);
        return this.get(id);
      }
      if (native.revision !== revision) throw new Error("The schedule changed; review it before trying again");
      if (enabled && native.schedule.kind === "at" && native.lastRunAt !== undefined &&
        Date.parse(native.schedule.at) <= Date.now()) throw new Error("已执行的一次性安排需要选择新的时间");
      if (!enabled) this.stopIntent(id);
      return this.accept(this.get(id), await this.provider.setEnabled(routine.nativeId!, revision, enabled));
    })().finally(() => this.changing.delete(id));
    this.changing.set(id, work);
    return work;
  }
  async update(id: string, revision: string, input: RoutineEdit): Promise<Routine> {
    const changes = content(input);
    if (this.changing.has(id)) throw new Error("This schedule is still being confirmed");
    const routine = this.get(id);
    if (!routine.nativeId || !routine.revision) throw new Error("Refresh this schedule before changing it");
    this.store.engineSessionKey(routine.conversationId, routine.botId);
    const work = (async () => {
      const native = await this.provider.get(routine.nativeId!);
      this.accept(this.get(id), native);
      // An exact retry after a lost acknowledgment is read-only.
      if (sameContent(native, changes)) return this.get(id);
      if (native.revision !== revision) throw new Error("The schedule changed; review it before trying again");
      if (native.runningAt !== undefined) throw new Error("请先暂停正在执行的安排");
      if (changes.schedule.kind === "at" && Date.parse(changes.schedule.at) <= Date.now() &&
        JSON.stringify(changes.schedule) !== JSON.stringify(native.schedule)) throw new Error("Choose a future date");
      return this.accept(this.get(id), await this.provider.update(routine.nativeId!, revision, changes));
    })().finally(() => this.changing.delete(id));
    this.changing.set(id, work);
    return work;
  }
  private stopIntent(id: string): void {
    this.store.transaction(() => {
      for (const task of this.store.list<Task>("tasks")) {
        if (task.routine?.id !== id || ["completed", "failed", "cancelled"].includes(task.status)) continue;
        this.store.put("tasks", {
          ...task, status: "stopping", stopRequestedAt: task.stopRequestedAt ?? Date.now(), updatedAt: Date.now(),
        });
      }
    });
  }
  async testRun(id: string, revision: string): Promise<{ runId: string | null }> {
    const routine = this.get(id);
    if (!routine.nativeId || !routine.revision || routine.revision !== revision) {
      throw new Error("Refresh this schedule before running it");
    }
    if (routine.runningAt !== undefined) throw new Error("这次执行还没有结束");
    this.store.engineSessionKey(routine.conversationId, routine.botId);
    const result = await this.provider.runNow(routine.nativeId);
    void this.refresh(id).catch(() => undefined);
    return result;
  }

  /**
   * Removing a schedule deletes the native job only; its receipts stay so the history
   * the user already saw does not vanish, and the local row is marked removed.
   */
  async remove(id: string, revision: string): Promise<Routine> {
    if (this.changing.has(id)) throw new Error("This schedule is still being confirmed");
    const routine = this.get(id);
    if (!routine.nativeId || !routine.revision || routine.revision !== revision) {
      throw new Error("Refresh this schedule before removing it");
    }
    this.store.engineSessionKey(routine.conversationId, routine.botId);
    await this.provider.remove(routine.nativeId, revision);
    return this.store.put<Routine>("routines", {
      ...routine, enabled: false, state: "removed", nextRunAt: undefined, runningAt: undefined,
      error: undefined, removedAt: Date.now(), updatedAt: Date.now(),
    });
  }

  async reconcile(): Promise<void> {
    await Promise.all(this.list().map((routine) => routine.nativeId ? this.refresh(routine.id) :
      this.create(routine).then(() => undefined)));
  }
  observe(observation: RuntimeObservation): void {
    if (observation.type !== "frame" || observation.frame.event !== "cron") return;
    const jobId = observation.frame.payload?.jobId;
    const routine = this.list().find((item) => item.nativeId === jobId);
    if (routine) void this.refresh(routine.id).catch((error: unknown) => {
      if (!this.detached) this.store.put("routines", { ...this.get(routine.id), error: String(error), updatedAt: Date.now() });
    });
  }
  refresh(id: string): Promise<void> {
    const current = this.refreshing.get(id);
    if (current) { this.refreshAgain.add(id); return current; }
    const work = (async () => {
      do {
        this.refreshAgain.delete(id);
        await this.readNative(id);
      } while (!this.detached && this.refreshAgain.has(id));
    })().finally(() => { this.refreshing.delete(id); this.refreshAgain.delete(id); });
    this.refreshing.set(id, work);
    return work;
  }
  private async readNative(id: string): Promise<void> {
    const routine = this.get(id);
    if (!routine.nativeId) return;
    const native = await this.provider.get(routine.nativeId);
    if (this.detached) return;
    const latest = this.get(id);
    if (latest.revision !== routine.revision || latest.enabled !== routine.enabled) {
      this.refreshAgain.add(id);
      return;
    }
    this.accept(latest, native);
    let offset = 0;
    for (;;) {
      const page = await this.provider.history(routine.nativeId, offset);
      if (this.detached) return;
      this.store.transaction(() => {
        for (const entry of page.entries) {
          const receiptId = `${routine.nativeId}:${entry.occurrenceKey}`;
          this.store.put<RoutineReceipt>("routineReceipts", {
            ...entry, id: receiptId, routineId: id, botId: routine.botId, conversationId: routine.conversationId,
          });
        }
      });
      if (!page.hasMore) return;
      if (!page.entries.length) throw new Error("Native schedule history did not advance");
      offset += page.entries.length;
    }
  }
}
