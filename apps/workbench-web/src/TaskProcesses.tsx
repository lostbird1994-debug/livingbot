import { useState } from "react";
import { CircleStop } from "lucide-react";
import { Button } from "@livingbot/ui-web/components/ui/button";
import type { Task } from "../../../packages/workbench/src/contracts.ts";
import { unfinishedProcesses } from "../../../packages/workbench/src/task-state.ts";
import type { WorkbenchClient } from "./client.ts";

export function TaskProcesses({ task, client }: { task: Task; client: WorkbenchClient }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = unfinishedProcesses(task);
  const stopping = pending.length > 0 && pending.every((process) => process.status === "stopping");
  const failure = pending.find((process) => process.stopError)?.stopError ?? (pending.length ? error : undefined);
  const label = failure ?? (stopping ? "程序停止中" : pending.some((process) => process.status === "unknown")
    ? "正在确认程序状态" : pending.length ? "后台程序运行中" :
    task.processes?.some((process) => process.status === "failed") ? "本机程序运行失败" :
    task.processes?.every((process) => process.status === "killed") ? "本机程序已停止" : "本机程序已结束");
  return <div className="task-process-state" role="status">
    <span>{label}</span>
    {pending.length > 0 && <Button type="button" variant="ghost" size="sm"
      disabled={busy || stopping} aria-label={`停止后台工作：${task.title}`}
      onClick={() => {
        setBusy(true); setError(undefined);
        void client.cancel(task.id).catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : "程序尚未确认停止，请重试");
        }).finally(() => setBusy(false));
      }}><CircleStop />{failure ? "重试停止" : "停止"}</Button>}
  </div>;
}
