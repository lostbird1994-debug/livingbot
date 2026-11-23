import type { Run, Task } from "./contracts.ts";
import type { WorkbenchStore } from "./store.ts";

type Spawn = {
  id: string;
  executor: string;
  title: string;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Adopt only an exact, native ACP tool receipt belonging to a known parent. */
export function recordNativeDelegation(
  store: WorkbenchStore, parent: Task, run: Run, generation: number, data: Record<string, unknown>,
): string | undefined {
  if (data.name !== "sessions_spawn" || typeof data.toolCallId !== "string") return;
  const id = `native-spawn:${run.id}:${data.toolCallId}`;
  if (data.phase === "start") {
    const args = object(data.args);
    if (args.runtime !== "acp" || typeof args.task !== "string" || !args.task.trim()) return;
    store.put<Spawn>("settings", {
      id, executor: typeof args.agentId === "string" && args.agentId ? args.agentId.slice(0, 100) : "外部执行器",
      title: args.task.slice(0, 160),
    });
    return;
  }
  if (data.phase !== "result" || data.isError === true) return;
  const spawn = store.get<Spawn>("settings", id);
  const receipt = object(object(data.result).details);
  if (!spawn || receipt.status !== "accepted" || typeof receipt.runId !== "string" || !receipt.runId ||
    typeof receipt.childSessionKey !== "string" || !receipt.childSessionKey ||
    receipt.childSessionKey === run.sessionKey || receipt.runId === run.id) return;
  const childId = `native-delegation:${receipt.runId}`;
  const existingRun = store.get<Run>("runs", receipt.runId);
  const existingTask = store.get<Task>("tasks", childId);
  if (existingRun && (existingRun.taskId !== childId || existingRun.sessionKey !== receipt.childSessionKey) ||
    existingTask && (existingTask.parentTaskId !== parent.id ||
      existingTask.delegation?.parentRunId !== run.id || existingTask.delegation.toolCallId !== data.toolCallId)) {
    store.recordEvent("operation.failed", parent.id, {
      stage: "delegation", message: "Native child ownership conflicts with its recorded receipt",
    });
    return;
  }
  if (!existingTask) {
    const now = Date.now();
    store.put<Task>("tasks", {
      id: childId, botId: parent.botId, conversationId: parent.conversationId,
      reportConversationId: parent.reportConversationId, parentTaskId: parent.id,
      title: spawn.title, status: parent.stopRequestedAt === undefined ? "queued" : "stopping",
      ...(parent.stopRequestedAt !== undefined ? { stopRequestedAt: parent.stopRequestedAt } : {}),
      delegation: {
        executor: spawn.executor, sessionKey: receipt.childSessionKey, parentRunId: run.id, toolCallId: data.toolCallId,
      },
      createdAt: now, updatedAt: now,
    });
  }
  store.ensureRun(receipt.runId, receipt.childSessionKey, generation, childId);
  return receipt.runId;
}
