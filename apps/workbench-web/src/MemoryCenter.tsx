import { useEffect, useRef, useState } from "react";
import { BookOpen, Search, X } from "lucide-react";
import { Button } from "@livingbot/ui-web/components/ui/button";
import { Input } from "@livingbot/ui-web/components/ui/input";
import type { Bot, Conversation } from "../../../packages/workbench/src/contracts.ts";
import type { MemoryForgetOutcome, MemoryForgetPreview } from "../../../packages/kernel-runtime/src/memory-forget.ts";
import { memoryForgetScopeSummary } from "../../../packages/kernel-runtime/src/memory-scopes.ts";
import type { MemoryForgetScopeId } from "../../../packages/kernel-runtime/src/memory-forget.ts";
import type { MemoryForgetRecovery } from "../../../packages/kernel-runtime/src/memory-forget.ts";
import type { MemoryDocument, MemoryHealth, MemoryHit, MemoryPage } from "../../../packages/kernel-runtime/src/memory.ts";
import type { WorkbenchClient } from "./client.ts";

const scopeLabels: Record<MemoryForgetScopeId, string> = {
  "memory-documents": "记忆文档", "session-transcripts": "会话摘录", "retrieval-index": "检索索引",
  "short-term": "短时记忆", "native-backups": "原生记忆备份", "curated-writes": "需另行检查的文件",
};
const countLabels: Record<string, string> = {
  memoryFiles: "文件", memoryEntries: "条目", memoryLines: "行",
  sessionCorpusFiles: "摘录文件", sessionCorpusLines: "摘录行",
  indexChunks: "索引片段", indexSources: "索引来源", ftsRows: "全文索引行", vectorRows: "向量行", embeddingCacheRows: "嵌入缓存行",
  shortTermEntries: "条目", seenHashScopes: "已读标记", backups: "备份", originRows: "原始记录", curatedWrites: "文件",
};

export function MemoryCenter({ client, bots, conversations, initialBotId, onBusyChange }: {
  client: WorkbenchClient; bots: Bot[]; conversations: Conversation[]; initialBotId?: string; onBusyChange?: (busy: boolean) => void;
}) {
  const [botId, setBotId] = useState(initialBotId ?? bots[0]?.id ?? "");
  const [health, setHealth] = useState<MemoryHealth>();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<MemoryPage>();
  const [source, setSource] = useState<{ hit: MemoryHit; document: MemoryDocument }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const requestId = useRef(0);
  const sourceId = useRef(0);
  const healthId = useRef(0);
  const forgetId = useRef(0);
  const [selectedConversations, setSelectedConversations] = useState<string[]>([]);
  const [forgetPreview, setForgetPreview] = useState<{ id: string; digest: string; report: MemoryForgetPreview; recovery?: MemoryForgetRecovery; outcome?: MemoryForgetOutcome }>();
  const [previewing, setPreviewing] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [recoveries, setRecoveries] = useState<{ id: string; conversationIds: string[]; recovery: MemoryForgetRecovery; outcome?: MemoryForgetOutcome; restores?: { target: string; files: number }[] }[]>([]);
  const [restoring, setRestoring] = useState<string>();
  const busy = previewing || preparing || applying || Boolean(restoring);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  useEffect(() => {
    ++requestId.current;
    const generation = ++healthId.current;
    ++sourceId.current; ++forgetId.current;
    setSelectedConversations([]); setForgetPreview(undefined); setPreviewing(false); setPreparing(false); setApplying(false); setConfirmed(false);
    setRecoveries([]);
    setPage(undefined); setSource(undefined); setHealth(undefined); setError(undefined); setLoading(false);
    void client.request<MemoryHealth>(`/api/bots/${encodeURIComponent(botId)}/memory`)
      .then((result) => { if (healthId.current === generation) setHealth(result); })
      .catch((cause: unknown) => { if (healthId.current === generation) setError(String(cause)); });
    void client.request<typeof recoveries>(`/api/bots/${encodeURIComponent(botId)}/memory/recoveries`)
      .then((result) => { if (healthId.current === generation) setRecoveries(result); })
      .catch((cause: unknown) => { if (healthId.current === generation) setError(String(cause)); });
    return () => { ++requestId.current; ++sourceId.current; ++healthId.current; ++forgetId.current; };
  }, [client, botId]);

  async function search(cursor?: string) {
    const generation = ++requestId.current;
    ++sourceId.current; setSource(undefined); setError(undefined); setLoading(true);
    try {
      const result = await client.request<MemoryPage>(`/api/bots/${encodeURIComponent(botId)}/memory/search`, {
        query: query.trim(), ...(cursor ? { cursor } : {}),
      });
      if (requestId.current === generation) setPage((current) => cursor && current
        ? { ...result, hits: [...current.hits, ...result.hits] } : result);
    } catch (cause) { if (requestId.current === generation) setError(String(cause)); }
    finally { if (requestId.current === generation) setLoading(false); }
  }
  async function read(hit: MemoryHit, from?: number) {
    const generation = requestId.current;
    const selected = ++sourceId.current;
    setError(undefined);
    try {
      const document = await client.request<MemoryDocument>(`/api/bots/${encodeURIComponent(botId)}/memory/source`, {
        reference: hit.reference, ...((from ?? hit.citations[0]?.startLine) ? { from: from ?? hit.citations[0]?.startLine } : {}),
      });
      if (requestId.current === generation && sourceId.current === selected) setSource((current) => ({
        hit, document: from && current?.document.status === "ok" && document.status === "ok"
          ? { ...document, text: `${current.document.text}\n${document.text}` } : document,
      }));
    } catch (cause) { if (requestId.current === generation && sourceId.current === selected) setError(String(cause)); }
  }
  async function previewForget() {
    const generation = ++forgetId.current;
    setPreviewing(true); setForgetPreview(undefined); setConfirmed(false); setError(undefined);
    try {
      const result = await client.request<{ id: string; digest: string; report: MemoryForgetPreview }>(
        `/api/bots/${encodeURIComponent(botId)}/memory/forget-preview`, { conversationIds: selectedConversations, allowKernelPause: true },
      );
      if (forgetId.current === generation) setForgetPreview(result);
    } catch (cause) { if (forgetId.current === generation) setError(String(cause)); }
    finally { if (forgetId.current === generation) setPreviewing(false); }
  }
  async function prepareRecovery() {
    if (!forgetPreview) return;
    const generation = ++forgetId.current;
    setPreparing(true); setError(undefined);
    try {
      const result = await client.request<typeof forgetPreview>(
        `/api/bots/${encodeURIComponent(botId)}/memory/forget-backup`,
        { previewId: forgetPreview.id, digest: forgetPreview.digest, allowKernelPause: true },
      );
      if (forgetId.current === generation) {
        setForgetPreview(result);
        if (result.recovery) setRecoveries((current) => [
          { id: result.id, conversationIds: [...selectedConversations], recovery: result.recovery!, ...(result.outcome ? { outcome: result.outcome } : {}) },
          ...current.filter((item) => item.id !== result.id),
        ].slice(0, 50));
      }
    } catch (cause) { if (forgetId.current === generation) setError(String(cause)); }
    finally { if (forgetId.current === generation) setPreparing(false); }
  }
  async function restoreCopy(id: string) {
    if (restoring) return;
    setRestoring(id); setError(undefined);
    try {
      await client.request(`/api/bots/${encodeURIComponent(botId)}/memory/forget-restore`, { previewId: id, confirmRestore: true });
      setRecoveries(await client.request<typeof recoveries>(`/api/bots/${encodeURIComponent(botId)}/memory/recoveries`));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRestoring(undefined); }
  }

  async function applyForget() {
    if (!forgetPreview || !confirmed) return;
    const generation = ++forgetId.current;
    setApplying(true); setError(undefined);
    try {
      const result = await client.request<typeof forgetPreview>(
        `/api/bots/${encodeURIComponent(botId)}/memory/forget-apply`,
        { previewId: forgetPreview.id, digest: forgetPreview.digest, allowKernelPause: true, confirmForget: true },
      );
      if (forgetId.current === generation) {
        setForgetPreview(result); setConfirmed(false); setPage(undefined); setSource(undefined);
        ++requestId.current; ++sourceId.current;
        if (result.recovery) setRecoveries((current) => [
          { id: result.id, conversationIds: [...selectedConversations], recovery: result.recovery!, ...(result.outcome ? { outcome: result.outcome } : {}) },
          ...current.filter((item) => item.id !== result.id),
        ].slice(0, 50));
      }
    } catch (cause) { if (forgetId.current === generation) setError(String(cause)); }
    finally { if (forgetId.current === generation) setApplying(false); }
  }
  const forgetScopes = forgetPreview ? memoryForgetScopeSummary(forgetPreview.report) : [];
  return <section className="catalog-page memory-center">
    <h1>记忆</h1>
    <div className="ability-bots" aria-label="选择伙伴">{bots.map((bot) => <Button key={bot.id}
      variant={bot.id === botId ? "default" : "outline"} aria-pressed={bot.id === botId} disabled={applying || preparing || previewing}
      onClick={() => setBotId(bot.id)}>{bot.name}</Button>)}</div>
    {health && <p className="memory-health">{health.status === "ready" ? "可用" : health.status === "degraded" ? "部分可用" : "暂不可用"}
      <span>{health.mode === "text" ? "全文检索" : health.mode === "hybrid" ? "混合检索" : "检索模式未确认"}</span></p>}
    <form className="memory-search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
      <Input aria-label="查找记忆" placeholder="查找记忆…" value={query} onChange={(event) => {
        ++requestId.current; ++sourceId.current; setQuery(event.target.value); setPage(undefined); setSource(undefined); setLoading(false);
      }} />
      <Button type="submit" disabled={loading || !query.trim()} aria-label="搜索记忆"><Search /></Button>
    </form>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {loading && <p role="status" className="empty-label">正在查找</p>}
    {page?.coverage === "partial" && <p className="memory-health">结果可能不完整</p>}
    {page && !page.hits.length && !loading && <p className="empty-label">没有找到相关记忆</p>}
    {page?.hits.map((hit, index) => <article className="memory-hit" key={`${hit.reference.providerId}:${hit.reference.id}:${index}`}>
      <div><BookOpen size={16} /><span>{hit.citations[0]?.label ?? (hit.source === "sessions" ? "会话记录" : "记忆记录")}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => void read(hit)}>查看来源</Button></div>
      <p>{hit.excerpt}</p>
    </article>)}
    {page?.nextCursor && <Button variant="outline" disabled={loading} onClick={() => void search(page.nextCursor)}>更多结果</Button>}
    {source && <section className="memory-source" aria-label="记忆来源">
      <header><span>{source.hit.citations[0]?.label ?? "记忆来源"}</span><Button variant="ghost" size="icon-sm" aria-label="关闭来源" onClick={() => {
        ++sourceId.current; setSource(undefined);
      }}><X /></Button></header>
      {source.document.status === "ok" ? <>
        <pre>{source.document.text}</pre>
        {source.document.nextFrom && <Button variant="outline" onClick={() => void read(source.hit, source.document.status === "ok" ? source.document.nextFrom : undefined)}>继续阅读</Button>}
      </> : <p>来源已不可用，请重新搜索</p>}
    </section>}
    <details className="memory-forget">
      <summary>遗忘预览</summary>
      <p className="empty-label">预览需暂时暂停内核，完成后恢复。进行中任务须先结束；此操作不会执行遗忘。</p>
      <div className="memory-forget-conversations">{conversations.filter((conversation) => conversation.botIds.includes(botId)).map((conversation) =>
        <label key={conversation.id}>
          <input type="checkbox" disabled={applying || preparing || previewing} checked={selectedConversations.includes(conversation.id)} onChange={(event) => {
            ++forgetId.current; setForgetPreview(undefined); setPreviewing(false); setPreparing(false); setConfirmed(false);
            setSelectedConversations((current) => event.target.checked ? [...current, conversation.id] : current.filter((id) => id !== conversation.id));
          }} />
          <span>{conversation.title}<small>{conversation.kind === "group" ? "群聊 · 仅当前伙伴" : "私聊"}</small></span>
        </label>)}</div>
      <Button variant="outline" disabled={previewing || preparing || applying || !selectedConversations.length} onClick={() => void previewForget()}>
        {previewing ? "正在预览…" : "暂停内核并预览"}
      </Button>
      {forgetPreview && <section className="memory-forget-report" aria-label="遗忘影响预览">
        <p>{forgetPreview.outcome?.status === "completed" ? "原生遗忘已完成" :
          forgetPreview.outcome?.status === "recovery-required" ? "遗忘中断，内核已暂停" : "尚未执行遗忘"}</p>
        {/* An unresolved conversation explains an empty scope list, so it comes first. */}
        {forgetPreview.report.sessionResolutions.some((item) => item.source === "unresolved") &&
          <p>部分会话未找到原生记录，不能据此判断记忆已清除。</p>}
        <dl>{forgetScopes.filter((scope) => scope.affected).map((scope) =>
          <div key={scope.id}><dt>{scopeLabels[scope.id]}</dt>
            <dd>{Object.entries(scope.counts).filter(([, count]) => count > 0).map(([key, count]) =>
              `${countLabels[key] ?? key} ${count}`).join(" · ")}</dd></div>)}</dl>
        {forgetScopes.some((scope) => !scope.affected && scope.id !== "curated-writes") && <p className="empty-label">
          本次不涉及：{forgetScopes.filter((scope) => !scope.affected && scope.id !== "curated-writes")
            .map((scope) => scopeLabels[scope.id]).join("、")}
        </p>}
        <p className="empty-label">只影响这个伙伴；其他伙伴的记忆和会话原文保持不变。</p>
        {forgetPreview.report.mixedLineageEntryKeys.length > 0 &&
          <p>有 {forgetPreview.report.mixedLineageEntryKeys.length} 条记忆同时来自其他会话，原生遗忘会整条移除。</p>}
        {forgetPreview.report.untargetableEntryKeys.length > 0 &&
          <p>有 {forgetPreview.report.untargetableEntryKeys.length} 条历史记忆缺少可定位来源。</p>}
        {forgetPreview.report.curatedWrites.length > 0 && <div><p>需要另行检查的文件</p>
          <ul>{forgetPreview.report.curatedWrites.map((item) => <li key={item.relativePath}>{item.relativePath}</li>)}</ul>
        </div>}
        {forgetPreview.report.refusals.map((reason, index) => <p key={index}>{reason}</p>)}
        <div className="memory-recovery-preparation">
          {forgetPreview.recovery ? <p role="status">恢复副本已校验 · {forgetPreview.recovery.files} 个文件</p> : <>
            <p>恢复副本包含本机内核状态和当前伙伴工作区，保存时会再次暂停内核。</p>
            <Button variant="outline" disabled={preparing || previewing || applying} onClick={() => void prepareRecovery()}>
              {preparing ? "正在保存…" : "保存恢复副本"}
            </Button>
          </>}
        </div>
        {forgetPreview.outcome ? <OutcomeDetails outcome={forgetPreview.outcome} /> : forgetPreview.report.sessionResolutions.length > 0 &&
          !forgetPreview.report.sessionResolutions.some((session) => session.source === "unresolved") &&
          forgetPreview.report.refusals.length === 0 && <div className="memory-recovery-preparation">
            <p>执行前会再次备份。恢复副本尚无一键还原入口。</p>
            <label className="memory-forget-confirm"><input type="checkbox" checked={confirmed} disabled={applying || preparing}
              onChange={(event) => setConfirmed(event.target.checked)} /><span>移除这些会话衍生的可追溯记忆，保留会话原文</span></label>
            <Button variant="destructive" disabled={!confirmed || applying || preparing || previewing} onClick={() => void applyForget()}>
              {applying ? "正在遗忘…" : "暂停内核并遗忘"}
            </Button>
          </div>}
      </section>}
    </details>
    {recoveries.length > 0 && <details className="memory-forget">
      <summary>恢复副本 · {recoveries.length}</summary>
      {recoveries.map((item) => <div className="memory-recovery-preparation" key={item.id}>
        <p>{new Date(item.recovery.createdAt).toLocaleString()} · {item.recovery.files} 个文件</p>
        <p>{item.conversationIds.map((id) => conversations.find((conversation) => conversation.id === id)?.title ?? "原会话").join("、")}</p>
        {item.outcome && <p>{item.outcome.status === "completed" ? "原生遗忘已完成" : "需要恢复 · 内核已暂停"}</p>}
        {item.outcome && <OutcomeDetails outcome={item.outcome} />}
        <Button variant="outline" size="sm" disabled={Boolean(restoring)} onClick={() => void restoreCopy(item.id)}>
          {restoring === item.id ? "正在复制…" : "复制到独立文件夹"}
        </Button>
        {item.restores?.map((restore) => <p key={restore.target}>{restore.target}<br />{restore.files} 个文件 · 未启用</p>)}
      </div>)}
    </details>}
  </section>;
}

function OutcomeDetails({ outcome }: { outcome: MemoryForgetOutcome }) {
  return <div className="memory-recovery-preparation">
    {outcome.error && <p role="alert">{outcome.error}</p>}
    {outcome.status === "completed" && <p>会话原文保留。未标记来源的历史文字仍需另行检查。</p>}
    {outcome.files.length > 0 && <details>
      <summary>废纸篓中的原件 · {outcome.files.length}</summary>
      {outcome.files.map((file) => <p key={file.original}>{file.original}<br />{file.recovery}</p>)}
    </details>}
  </div>;
}
