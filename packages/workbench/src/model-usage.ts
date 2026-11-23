import { createHash } from "node:crypto";
import type { Bot, Run, Task } from "./contracts.ts";
import type { WorkbenchStore } from "./store.ts";

export type ModelRequestUsage = {
  id: string; taskId: string; runId: string; callId: string;
  durationMs: number; outcome: "completed" | "error"; timeToFirstByteMs?: number;
};

/** Record terminal native observations, including hooks arriving after run completion. */
export function recordModelRequestUsage(store: WorkbenchStore, input: {
  agentId: string; sessionKey: string; runId: string; callId: string;
  durationMs: unknown; outcome: unknown; timeToFirstByteMs?: unknown;
}): ModelRequestUsage {
  const run = store.get<Run>("runs", input.runId);
  const task = run && store.get<Task>("tasks", run.taskId);
  const bot = task && store.get<Bot>("bots", task.botId);
  if (!run || !task || !bot || bot.agentId !== input.agentId || run.sessionKey !== input.sessionKey) {
    throw new Error("Unknown native model request owner");
  }
  const validDuration = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!input.callId || input.callId.length > 512 || !validDuration(input.durationMs) ||
    (input.outcome !== "completed" && input.outcome !== "error") ||
    (input.timeToFirstByteMs !== undefined && (!validDuration(input.timeToFirstByteMs) ||
      input.timeToFirstByteMs > input.durationMs))) {
    throw new Error("Invalid native model request timing");
  }
  const id = `model-request:${createHash("sha256").update(JSON.stringify([run.id, input.callId])).digest("hex")}`;
  const record: ModelRequestUsage = {
    id, taskId: task.id, runId: run.id, callId: input.callId,
    durationMs: input.durationMs, outcome: input.outcome,
    ...(input.timeToFirstByteMs === undefined ? {} : { timeToFirstByteMs: input.timeToFirstByteMs as number }),
  };
  return store.transaction(() => {
    const previous = store.get<ModelRequestUsage>("settings", id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(record)) throw new Error("Native model request receipt conflicts");
      return previous;
    }
    return store.put("settings", record, "usage.recorded");
  });
}

export function modelRequestDuration(store: WorkbenchStore, runId: string): number | null {
  const run = store.get<Run>("runs", runId);
  const records = run ? store.find<ModelRequestUsage>("settings", "taskId", run.taskId)
    .filter((record) => record.id.startsWith("model-request:") && record.runId === runId) : [];
  return records.length ? records.reduce((sum, record) => sum + record.durationMs, 0) : null;
}
