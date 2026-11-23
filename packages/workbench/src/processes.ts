import { createHash } from "node:crypto";
import type { GatewayRequests, ProcessPage, RuntimeObservation } from "../../kernel-runtime/src/contracts.ts";
import type { Run, Task, TaskProcess } from "./contracts.ts";
import type { WorkbenchStore } from "./store.ts";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A native exec receipt, not a session-wide process listing, establishes task ownership. */
export function recordNativeProcess(store: WorkbenchStore, task: Task, run: Run, data: Record<string, unknown>): void {
  if (data.name !== "exec" || typeof data.toolCallId !== "string" ||
    !["update", "result"].includes(String(data.phase))) return;
  const details = object(object(data.phase === "update" ? data.partialResult : data.result).details);
  const current = store.get<Task>("tasks", task.id)!;
  if (data.phase === "result" && ["completed", "failed"].includes(String(details.status))) {
    const matching = current.processes?.find((entry) => entry.runId === run.id && entry.toolCallId === data.toolCallId && entry.foreground);
    if (matching) {
      store.put<Task>("tasks", {
        ...current, updatedAt: Date.now(), processes: current.processes!.map((entry) => entry.id === matching.id ? {
          ...entry, foreground: false, canStop: false, stopError: undefined, errorKind: undefined,
          ...(typeof details.exitCode === "number" || details.exitCode === null ? { exitCode: details.exitCode } : {}),
          ...(typeof details.exitSignal === "string" || typeof details.exitSignal === "number" || details.exitSignal === null
            ? { exitSignal: details.exitSignal } : {}),
          ...(typeof details.exitReason === "string" ? { exitReason: details.exitReason } : {}),
          status: current.stopRequestedAt !== undefined && details.exitSignal ? "killed" : details.status as "completed" | "failed",
        } : entry),
      });
      return;
    }
  }
  if (typeof details.sessionId !== "string" || !details.sessionId ||
    typeof details.startedAt !== "number" || !Number.isFinite(details.startedAt)) return;
  const id = createHash("sha256").update(JSON.stringify([run.sessionKey, details.sessionId, details.startedAt])).digest("hex");
  const previous = current.processes?.find((entry) => entry.id === id);
  if (previous) {
    if (data.phase === "result" && previous.foreground) store.put<Task>("tasks", {
      ...current, updatedAt: Date.now(), processes: current.processes!.map((entry) => entry.id === id ? {
        ...entry, foreground: false,
      } : entry),
    });
    return;
  }
  // One exact receipt cannot transfer an existing process to a different task.
  if (store.tasksWithProcesses().some((entry) => entry.id !== task.id && entry.processes?.some((process) => process.id === id))) {
    store.recordEvent("operation.failed", task.id, { stage: "process", message: "Native process ownership conflicts with its receipt" });
    return;
  }
  store.put<Task>("tasks", {
    ...current, updatedAt: Date.now(), processes: [...current.processes ?? [], {
      id, runId: run.id, sessionKey: run.sessionKey, toolCallId: data.toolCallId,
      processId: details.sessionId, startedAt: details.startedAt,
      foreground: data.phase === "update", status: data.phase === "update" ? "running" : "unknown",
    }],
  });
}

const terminal = new Set<TaskProcess["status"]>(["completed", "failed", "killed"]);

/** Event-driven, non-consuming process observation through the official Gateway. */
export class Processes {
  private readonly store: WorkbenchStore;
  private readonly gateway: GatewayRequests;
  private readonly pending = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private detached = false;

  constructor(store: WorkbenchStore, gateway: GatewayRequests) {
    this.store = store; this.gateway = gateway;
  }

  observe(observation: RuntimeObservation): void {
    if (this.detached || observation.type !== "frame") return;
    const { event, payload } = observation.frame;
    if (event === "chat" && payload?.state === "aborted" && typeof payload.runId === "string") {
      this.confirmForeground(payload.runId);
    }
    if (typeof payload?.sessionKey !== "string" ||
      !(event === "sessions.processes.changed" || event === "agent" && payload.stream === "tool")) return;
    if (!this.entries(payload.sessionKey).length) return;
    void this.refresh(payload.sessionKey).catch((error: unknown) => {
      if (this.detached) return;
      this.store.recordEvent("operation.failed", "processes", {
        stage: "process", message: error instanceof Error ? error.message : "Process observation unavailable",
      });
    });
  }

  private entries(sessionKey?: string): { task: Task; process: TaskProcess }[] {
    return this.store.tasksWithProcesses().flatMap((task) =>
      (task.processes ?? []).filter((process) => !sessionKey || process.sessionKey === sessionKey)
        .map((process) => ({ task, process })));
  }

  private update(taskId: string, id: string, patch: Partial<TaskProcess>): void {
    if (this.detached) return;
    const task = this.store.get<Task>("tasks", taskId);
    if (!task?.processes) return;
    const previous = task.processes.find((entry) => entry.id === id);
    if (!previous) return;
    const next = { ...previous, ...patch };
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    this.store.put<Task>("tasks", {
      ...task, updatedAt: Date.now(), processes: task.processes.map((entry) => entry.id === id ? next : entry),
    });
  }

  refresh(sessionKey: string): Promise<void> {
    if (this.detached) return Promise.resolve();
    const previous = this.pending.get(sessionKey);
    if (previous) { this.dirty.add(sessionKey); return previous; }
    const operation = (async () => {
      do {
        this.dirty.delete(sessionKey);
        await this.read(sessionKey);
        if (this.detached) return;
        const requests = await Promise.allSettled(this.entries(sessionKey)
          .filter(({ task, process }) => task.stopRequestedAt !== undefined && process.status === "running")
          .map(({ task, process }) => this.stop(task, process)));
        // One immediate confirmation read; subsequent confirmation is driven by
        // native process events or explicit recovery, never a polling timer.
        if (requests.some((entry) => entry.status === "fulfilled" && entry.value)) await this.read(sessionKey);
        const failures = requests.filter((entry) => entry.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map((entry) => entry.reason), "Some programs could not be stopped");
      } while (this.dirty.has(sessionKey));
    })().finally(() => { this.pending.delete(sessionKey); this.dirty.delete(sessionKey); });
    this.pending.set(sessionKey, operation);
    return operation;
  }

  private async read(sessionKey: string): Promise<void> {
    const page = await this.gateway.request<ProcessPage>("sessions.processes.list", { key: sessionKey });
    if (!page || typeof page.sessionId !== "string" || !Array.isArray(page.processes)) {
      throw new Error("Native process observation is unavailable");
    }
    if (this.detached) return;
    for (const { task, process } of this.entries(sessionKey)) {
      if (terminal.has(process.status)) continue;
      const native = page.processes.find((entry) => entry.processId === process.processId &&
        entry.startedAt === process.startedAt &&
        (!process.instanceId || entry.instanceId === process.instanceId));
      // Official process listings expose background programs. An in-flight
      // foreground exec stays under its exact turn owner until promotion or
      // a structured tool terminal; absence is not disappearance.
      if (!native && process.foreground && !process.instanceId) continue;
      if (!native || process.nativeSessionId && page.sessionId !== process.nativeSessionId) {
        this.update(task.id, process.id, {
          status: "unavailable", errorKind: "observation",
          stopError: page.truncated ? "程序不在本次返回的列表中" : "原程序实例已无法确认",
        });
        continue;
      }
      this.update(task.id, process.id, {
        instanceId: native.instanceId, nativeSessionId: page.sessionId,
        canStop: native.canStop,
        status: native.status === "running"
          ? process.status === "stopping" ? "stopping" : process.errorKind === "stop" ? "unavailable" : "running"
          : native.status,
        stopError: native.status === "running" && process.errorKind === "stop" ? process.stopError : undefined,
        errorKind: native.status === "running" && process.errorKind === "stop" ? "stop" : undefined,
        exitCode: native.exitCode, exitSignal: native.exitSignal, exitReason: native.exitReason,
      });
    }
  }

  private async stop(task: Task, process: TaskProcess): Promise<boolean> {
    if (this.detached || !process.instanceId || !process.nativeSessionId) return false;
    if (!process.canStop) {
      this.update(task.id, process.id, { status: "unavailable", stopError: "当前权限无法停止这个程序", errorKind: "stop" });
      throw new Error("Native process cannot be stopped with current authority");
    }
    this.update(task.id, process.id, { status: "stopping", stopError: undefined, errorKind: undefined });
    try {
      const result = await this.gateway.request<{ requested: boolean }>("sessions.processes.stop", {
        key: process.sessionKey, sessionId: process.nativeSessionId,
        processId: process.processId, instanceId: process.instanceId,
      });
      if (!result?.requested) throw new Error("程序停止请求未被确认");
      return true;
    } catch (error) {
      this.update(task.id, process.id, { status: "unavailable", stopError: "程序尚未确认停止，请重试", errorKind: "stop" });
      throw error;
    }
  }

  async stopTask(taskId: string): Promise<void> {
    const selected = this.entries().filter(({ task, process }) =>
      task.id === taskId && !terminal.has(process.status));
    for (const { task, process } of selected) {
      if (process.stopError) this.update(task.id, process.id, { status: "unknown", stopError: undefined, errorKind: undefined });
    }
    const sessions = new Set(selected.map(({ process }) => process.sessionKey));
    const results = await Promise.allSettled([...sessions].map((key) => this.refresh(key)));
    const failures = results.filter((entry) => entry.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((entry) => entry.reason), "Program cleanup is not confirmed");
  }

  async recover(): Promise<void> {
    for (const { process } of this.entries()) {
      if (process.foreground) this.confirmForeground(process.runId);
    }
    const sessions = new Set(this.entries().filter(({ process }) => !terminal.has(process.status)).map(({ process }) => process.sessionKey));
    const results = await Promise.allSettled([...sessions].map((key) => this.refresh(key)));
    const failures = results.filter((entry) => entry.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((entry) => entry.reason), "Program observation is not restored");
  }

  detach(): void { this.detached = true; }

  confirmAbort(runId: string, receipt: unknown): void {
    if (this.detached) return;
    const response = object(receipt);
    if (response.aborted !== true || !Array.isArray(response.runIds) || !response.runIds.includes(runId)) return;
    this.store.put("settings", { id: `process-abort:${runId}`, runId, confirmed: true }, "process.abort-confirmed");
    this.confirmForeground(runId);
  }

  private confirmForeground(runId: string): void {
    const run = this.store.get<Run>("runs", runId);
    if (run?.state !== "cancelled" || !this.store.get("settings", `process-abort:${runId}`)) return;
    // Successful exact-run Stop waits for native owner cleanup. Require its
    // cancelled terminal as well; a request receipt alone is not an exit.
    // Background programs keep their separate instance-level confirmation.
    for (const { task, process } of this.entries(run.sessionKey)) {
      if (process.runId !== runId || !process.foreground || process.instanceId || terminal.has(process.status)) continue;
      this.update(task.id, process.id, { status: "killed", foreground: false, canStop: false, stopError: undefined, errorKind: undefined });
    }
  }
}
