import { useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@livingbot/ui-web/components/ui/button";
import type { Task } from "../../../packages/workbench/src/contracts.ts";
import type { WorkbenchClient } from "./client.ts";

export function TaskRecovery({ task, client, name }: { task: Task; client: WorkbenchClient; name: string }) {
  const submissionId = useRef<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return <article className="task-recovery" data-task-id={task.id} tabIndex={-1}>
    <div><small>{name} · {task.status === "interrupted" ? "工作已中断" : task.status === "failed" ? "工作未完成" : "继续请求待确认"}</small><p>{task.title}</p></div>
    <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={`继续工作：${task.title}`}
      onClick={() => {
        submissionId.current = task.continuationSubmissionId ?? submissionId.current ?? crypto.randomUUID();
        setBusy(true); setError(undefined);
        void client.continueTask(task.id, submissionId.current).catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : "尚未确认接收，请重试");
        }).finally(() => setBusy(false));
      }}><RotateCcw />{task.continuationSubmissionId ? "重试继续" : "继续"}</Button>
    {error && <p className="task-recovery-error" role="alert">{error}</p>}
  </article>;
}
