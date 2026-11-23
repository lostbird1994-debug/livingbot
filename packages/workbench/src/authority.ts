import type { Bot, Run, Task } from "./contracts.ts";
import type { WorkbenchStore } from "./store.ts";

export type NativeAuthority = { agentId: string; sessionKey: string; runId: string };

export function nativeTask(store: WorkbenchStore, input: NativeAuthority): { bot: Bot; task: Task } {
  const bot = store.list<Bot>("bots").find((item) => item.agentId === input.agentId);
  const run = store.get<Run>("runs", input.runId);
  const task = run && store.get<Task>("tasks", run.taskId);
  if (!bot || !run || !task || task.botId !== bot.id || run.sessionKey !== input.sessionKey ||
    !["running", "waiting"].includes(run.state) ||
    task.stopRequestedAt !== undefined || ["stopping", "completed", "failed", "cancelled", "interrupted"].includes(task.status) ||
    store.engineSessionKey(task.conversationId, bot.id) !== input.sessionKey) {
    throw new Error("No active native conversation authority");
  }
  return { bot, task };
}
