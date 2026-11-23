import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { Button } from "@livingbot/ui-web/components/ui/button";
import type { Bot, Conversation, FilePage, Task } from "../../../packages/workbench/src/contracts.ts";
import type { WorkbenchClient } from "./client.ts";
import { FileCard } from "./FileCard.tsx";

export function FileCenter({ client, bot, conversations, tasks, revision, onOpen }: {
  client: WorkbenchClient; bot: Bot; conversations: Conversation[]; tasks: Task[];
  revision: number; onOpen(file: FilePage["files"][number]): void;
}) {
  const [page, setPage] = useState<FilePage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const loadingPage = useRef(false);

  useEffect(() => {
    const current = ++generation.current;
    loadingPage.current = true; setLoading(true); setError(undefined); setPage(undefined);
    void client.request<FilePage>(`/api/bots/${encodeURIComponent(bot.id)}/files`)
      .then((result) => { if (current === generation.current) setPage(result); })
      .catch((cause: unknown) => { if (current === generation.current) setError(String(cause)); })
      .finally(() => {
        if (current === generation.current) { loadingPage.current = false; setLoading(false); }
      });
    return () => { ++generation.current; };
  }, [client, bot.id, revision, refresh]);

  async function more() {
    if (!page?.next || loadingPage.current) return;
    const current = generation.current;
    loadingPage.current = true; setLoading(true); setError(undefined);
    try {
      const result = await client.request<FilePage>(`/api/bots/${encodeURIComponent(bot.id)}/files?before=${encodeURIComponent(page.next)}`);
      if (current === generation.current) setPage((previous) => ({
        ...result, files: [...(previous?.files ?? []), ...result.files],
      }));
    } catch (cause) { if (current === generation.current) setError(String(cause)); }
    finally { if (current === generation.current) { loadingPage.current = false; setLoading(false); } }
  }

  return <section className="catalog-page file-center" aria-label={`${bot.name} 的文件`}>
    <header className="file-center-heading">
      <div><h1>文件</h1><span>{bot.name}</span></div>
      <Button size="icon-sm" variant="ghost" aria-label="刷新文件" disabled={loading} onClick={() => setRefresh((value) => value + 1)}><RefreshCw /></Button>
    </header>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {!page && loading && <p role="status" className="empty-label">正在读取文件…</p>}
    {page && !page.files.length && <p className="empty-label">还没有附件或交付文件</p>}
    {page?.files.map((file) => {
      const task = tasks.find((item) => item.id === file.taskId);
      const conversation = conversations.find((item) => item.id === file.conversationId);
      return <article key={file.id} className="file-entry">
        <div className="file-entry-meta">
          <span>{file.origin === "delivery" ? "交付文件" : file.origin === "attachment" ? "原始附件" : "文件"}</span>
          <span>{file.bytes < 1024 ? `${file.bytes} B` : file.bytes < 1024 * 1024 ? `${(file.bytes / 1024).toFixed(1)} KB` : `${(file.bytes / 1024 / 1024).toFixed(1)} MB`}</span>
          <time dateTime={new Date(file.createdAt).toISOString()}>{new Date(file.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
        </div>
        <FileCard id={file.id} name={file.name} mediaType={file.mediaType} client={client} />
        {conversation && <Button type="button" variant="text" size="sm" className="file-source" onClick={() => onOpen(file)}>
          <span>{task?.title || conversation.title}</span><ArrowUpRight />
        </Button>}
      </article>;
    })}
    {page?.next && <Button variant="outline" disabled={loading} onClick={() => void more()}>更多文件</Button>}
  </section>;
}
