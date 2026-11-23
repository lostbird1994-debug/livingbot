import { useRef, useState } from "react";
import { ArrowUpRight, RotateCcw } from "lucide-react";
import { Button } from "@livingbot/ui-web/components/ui/button";
import type { Bot, FileBatch, FileBatchReceipt, Task } from "../../../packages/workbench/src/contracts.ts";
import type { WorkbenchClient } from "./client.ts";

const states: Partial<Record<Task["status"], string>> = {
  completed: "已完成", failed: "失败", interrupted: "已中断", cancelled: "已取消",
  waiting: "等待你", running: "处理中", stopping: "停止中",
};

export function FileBatches({ client, batches, tasks, bots, onUpdate, onOpen }: {
  client: WorkbenchClient; batches: FileBatch[]; tasks: Task[]; bots: Bot[];
  onUpdate: (receipt: FileBatchReceipt) => void;
  // The same task navigation the work records use: one item opens its own task and result.
  // Optional so a build without the App wiring still renders the batch; App passes openConversation.
  onOpen?: (conversationId: string, taskId: string) => void;
}) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<Record<string, string>>({});
  const retryIds = useRef(new Map<string, string>());
  async function retry(batch: FileBatch) {
    if (busy) return;
    const key = `livingbot:file-batch-retry:${JSON.stringify([client.origin, batch.id])}`;
    let retryId = retryIds.current.get(batch.id);
    if (!retryId) {
      try { retryId = sessionStorage.getItem(key) ?? undefined; } catch { /* Keep the active-page identity. */ }
      retryId ??= crypto.randomUUID();
      retryIds.current.set(batch.id, retryId);
      try { sessionStorage.setItem(key, retryId); } catch { /* Keep the active-page identity. */ }
    }
    setBusy(batch.id); setError((current) => ({ ...current, [batch.id]: "" }));
    try {
      const receipt = await client.retryFileBatch(batch.id, retryId);
      onUpdate(receipt);
      if (receipt.outcomes.every((outcome) => outcome.accepted)) {
        retryIds.current.delete(batch.id);
        try { sessionStorage.removeItem(key); } catch { /* Receipt remains authoritative. */ }
      } else setError((current) => ({ ...current, [batch.id]: "接收状态尚未确认，再试一次会沿用原请求。" }));
    } catch (cause) {
      setError((current) => ({ ...current, [batch.id]: cause instanceof Error ? cause.message : "重试尚未确认" }));
    } finally { setBusy(undefined); }
  }
  if (!batches.length) return null;
  return <section className="catalog-page file-batches" aria-label="逐个处理的文件">
    <h2>文件批次</h2>
    {[...batches].reverse().map((batch) => {
      const entries = batch.items.map((item) => ({ item, task: tasks.find((task) => task.id === item.taskId) }));
      const failing = entries.filter(({ task }) => task?.status === "failed" || task?.status === "interrupted");
      const failed = failing.length > 0;
      const active = entries.some(({ item, task }) => task !== undefined &&
        (task.status === "running" || task.status === "waiting" || task.status === "stopping" ||
          task.status === "queued" && item.accepted === true));
      return <article className="file-batch" key={batch.id}>
        <header><strong>{batch.instruction}</strong><span>{bots.find((bot) => bot.id === batch.botId)?.name}</span></header>
        <ul>{entries.map(({ item, task }) => <li key={item.attachmentId} data-file-batch-item={item.attachmentId}>
          {task && onOpen
            ? <Button variant="text" size="sm" data-file-batch-task={task.id}
              onClick={() => onOpen(task.conversationId, task.id)}
              aria-label={`打开 ${item.name} 的处理结果`}>{item.name}<ArrowUpRight /></Button>
            : <span>{item.name}</span>}
          <span>{task ? states[task.status] ?? "排队中" : "待处理"}
            {item.retries ? ` · 第 ${item.retries + 1} 次` : ""}</span>
        </li>)}</ul>
        {failed && <Button size="sm" variant="outline" disabled={Boolean(busy) || active} onClick={() => void retry(batch)}>
          <RotateCcw />{busy === batch.id ? "正在重试…" : `重试失败的 ${failing.length} 项`}
        </Button>}
        {active && <small role="status">逐项独立运行，其他文件不会等待本项结束。</small>}
        {error[batch.id] && <p role="alert" className="text-destructive">{error[batch.id]}</p>}
      </article>;
    })}
  </section>;
}
