import type { Task, TaskProcess, TaskStatus } from "./contracts.ts";

export const activeTurnStatuses = new Set<TaskStatus>(["queued", "running", "waiting", "stopping"]);
const finishedProcessStatuses = new Set<TaskProcess["status"]>(["completed", "failed", "killed"]);

export function unfinishedProcesses(task: Task): TaskProcess[] {
  return (task.processes ?? []).filter((process) => !finishedProcessStatuses.has(process.status));
}

/** A completed reply can still own a running service; keep both facts intact. */
export function taskActivity(task: Task): TaskStatus | "background" | "unconfirmed" {
  if (activeTurnStatuses.has(task.status)) return task.status;
  const programs = unfinishedProcesses(task);
  if (programs.some((process) => process.status === "unavailable" || process.status === "unknown")) return "unconfirmed";
  if (programs.length) return task.stopRequestedAt !== undefined ? "stopping" : "background";
  return task.status;
}

export function hasTaskWork(task: Task): boolean {
  return activeTurnStatuses.has(task.status) || unfinishedProcesses(task).length > 0;
}

/** Attention and active turns take precedence over queued inputs and services. */
export function primaryBotTask(tasks: Task[], botId: string): Task | undefined {
  const priority: Record<ReturnType<typeof taskActivity>, number> = {
    waiting: 6, stopping: 5, running: 4, queued: 3, unconfirmed: 2, background: 1,
    completed: 0, failed: 0, cancelled: 0, interrupted: 0,
  };
  return tasks.reduce<Task | undefined>((selected, task) => {
    if (task.botId !== botId || !hasTaskWork(task)) return selected;
    if (!selected) return task;
    const difference = priority[taskActivity(task)] - priority[taskActivity(selected)];
    return difference > 0 || (difference === 0 && (task.updatedAt > selected.updatedAt ||
      (task.updatedAt === selected.updatedAt && task.id > selected.id))) ? task : selected;
  }, undefined);
}
