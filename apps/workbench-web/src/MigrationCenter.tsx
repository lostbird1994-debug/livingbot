import { useEffect, useRef, useState } from "react";
import { ArrowRight, FolderInput } from "lucide-react";
import { Button } from "@livingbot/ui-web/components/ui/button";
import { Input } from "@livingbot/ui-web/components/ui/input";
import type { Bot } from "../../../packages/workbench/src/contracts.ts";
import type { MigrationPreview } from "../../../packages/workbench/src/migration.ts";
import type { WorkbenchClient } from "./client.ts";
import { desktopBridge } from "./desktop.ts";

const states: Record<MigrationPreview["state"], string> = {
  preview: "待导入", "backing-up": "正在备份", copying: "正在复制",
  registering: "正在登记伙伴", ready: "导入完成", failed: "导入未完成",
};

export function MigrationCenter({ client, latest, onOpen, onBusyChange }: {
  client: WorkbenchClient; latest?: MigrationPreview; onOpen: (bot: Pick<Bot, "id">) => void | Promise<void>; onBusyChange?: (busy: boolean) => void;
}) {
  const storageKey = `livingbot-migration:${client.origin}`;
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<MigrationPreview>();
  const [history, setHistory] = useState<MigrationPreview[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const [error, setError] = useState<string>();
  const [bundlePath, setBundlePath] = useState("");
  const [batch, setBatch] = useState<MigrationPreview[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const generation = useRef(0);

  useEffect(() => {
    const id = sessionStorage.getItem(storageKey);
    const current = ++generation.current;
    setBusy(true);
    void client.request<{ migrations: MigrationPreview[] }>("/api/migrations")
      .then((result) => {
        if (current !== generation.current) return;
        setHistory(result.migrations);
        if (id) setPlan(result.migrations.find((item) => item.id === id));
        const retained = JSON.parse(sessionStorage.getItem(`${storageKey}:batch`) ?? "[]") as string[];
        const previews = result.migrations.filter((item) => retained.includes(item.id));
        setBatch(previews);
        setSelectedIds(previews.filter((item) => item.state !== "ready").map((item) => item.id));
      })
      .catch((cause: unknown) => { if (current === generation.current) setError(String(cause)); })
      .finally(() => { if (current === generation.current) setBusy(false); });
    return () => { ++generation.current; };
  }, [client, storageKey]);
  useEffect(() => {
    if (!latest) return;
    setPlan((current) => current?.id === latest.id ? latest : current);
    setHistory((current) => [latest, ...current.filter((item) => item.id !== latest.id)]);
    setBatch((current) => current.map((item) => item.id === latest.id ? latest : item));
  }, [latest]);

  async function previewBundle(path: string) {
    const current = ++generation.current;
    setBusy(true); setError(undefined);
    try {
      const result = await client.request<{ migrations: MigrationPreview[] }>("/api/migrations/bundle-preview", { path });
      if (current !== generation.current) return;
      setPlan(undefined); setBatch(result.migrations); setAcknowledged(false);
      setSelectedIds(result.migrations.filter((item) => item.state !== "ready").map((item) => item.id));
      sessionStorage.removeItem(storageKey);
      sessionStorage.setItem(`${storageKey}:batch`, JSON.stringify(result.migrations.map((item) => item.id)));
    } catch (cause) { if (current === generation.current) setError(String(cause)); }
    finally { if (current === generation.current) setBusy(false); }
  }

  async function applyBatch() {
    const current = ++generation.current;
    const selection = batch.filter((item) => selectedIds.includes(item.id) && item.state !== "ready");
    setBusy(true); setError(undefined);
    const failures: string[] = [];
    for (const item of selection) {
      if (current !== generation.current) break;
      try {
        const result = await client.request<MigrationPreview>(`/api/migrations/${item.id}/apply`, { acknowledgeExclusions: acknowledged });
        if (current === generation.current) setBatch((items) => items.map((entry) => entry.id === item.id ? result : entry));
      } catch (cause) { failures.push(`${item.name}：${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    if (current !== generation.current) return;
    try {
      const result = await client.request<{ migrations: MigrationPreview[] }>("/api/migrations");
      if (current === generation.current) {
        setHistory(result.migrations);
        setBatch((items) => items.map((entry) => result.migrations.find((item) => item.id === entry.id) ?? entry));
      }
    } catch { failures.push("请重新打开导入记录查看结果"); }
    if (current === generation.current) { setBusy(false); setError(failures.length ? failures.join("\n") : undefined); }
  }

  async function preview() {
    const current = ++generation.current;
    setBusy(true); setError(undefined);
    try {
      const result = await client.request<MigrationPreview>("/api/migrations/preview", { source, name });
      if (current !== generation.current) return;
      setPlan(result); setAcknowledged(false); sessionStorage.setItem(storageKey, result.id);
    } catch (cause) { if (current === generation.current) setError(String(cause)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function apply() {
    if (!plan) return;
    const current = ++generation.current;
    setBusy(true); setError(undefined);
    try {
      const result = await client.request<MigrationPreview>(`/api/migrations/${plan.id}/apply`, { acknowledgeExclusions: acknowledged });
      if (current === generation.current) setPlan(result);
    } catch (cause) {
      if (current !== generation.current) return;
      setError(String(cause));
      try {
        const retained = await client.request<MigrationPreview>(`/api/migrations/${plan.id}`);
        if (current === generation.current) setPlan(retained);
      } catch { /* Keep the last durable event and let an explicit retry recover. */ }
    } finally { if (current === generation.current) setBusy(false); }
  }
  const selected = plan?.inventory.files.filter((file) => file.kind !== "other" && file.status !== "symlink") ?? [];
  const excluded = plan ? [
    ...(plan.sourceExclusions ?? []),
    ...plan.inventory.omitted.map((item) => ({ path: item.path, reason: item.reason })),
    ...plan.inventory.files.filter((file) => file.status === "symlink" || file.kind === "other").map((file) => ({
      path: file.path, reason: file.status === "symlink" ? "链接目标需单独选择" : "不属于身份、记忆或能力文件",
    })),
  ] : [];
  const incomplete = plan && (!plan.inventory.complete || !selected.length || selected.some((file) => file.status !== "verified"));
  const batchSelection = batch.filter((item) => selectedIds.includes(item.id) && item.state !== "ready");
  const batchExclusions = batchSelection.some((item) => item.sourceExclusions?.length || item.inventory.omitted.length ||
    item.inventory.files.some((file) => file.kind === "other" || file.status === "symlink"));
  const batchIncomplete = batchSelection.some((item) => !item.inventory.complete ||
    !item.inventory.files.some((file) => file.kind !== "other" && file.status === "verified") ||
    item.inventory.files.some((file) => file.kind !== "other" && !["verified", "symlink"].includes(file.status)));

  return <section className="catalog-page migration-center">
    <h1>导入伙伴</h1>
    {!plan && batch.length > 0 && <div className="migration-batch">
      {batch.map((item) => <article key={item.id} className="migration-batch-item">
        <label><input type="checkbox" disabled={busy || item.state === "ready"} checked={selectedIds.includes(item.id)}
          onChange={(event) => {
            setAcknowledged(false);
            setSelectedIds((ids) => event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id));
          }} /><strong>{item.name}</strong><span role="status">{states[item.state]}</span></label>
        <p>{(["profile", "memory", "ability"] as const).map((kind, index) =>
          `${["身份", "记忆", "能力"][index]} ${item.inventory.files.filter((file) => file.kind === kind && file.status === "verified").length}`).join(" · ")}</p>
        <details><summary>查看范围</summary>
          <ul>{item.inventory.files.map((file) => <li key={file.path}><code>{file.path}</code>
            {(file.kind === "other" || file.status === "symlink") && <span> · 未纳入</span>}</li>)}
          {item.inventory.omitted.map((file, index) => <li key={`omitted-${index}`}><code>{file.path}</code> · {file.reason}</li>)}</ul>
          {Boolean(item.sourceExclusions?.length) && <><p>旧版未纳入</p><ul>{item.sourceExclusions!.map((file, index) =>
            <li key={index}><code>{file.path}</code> · {file.reason}</li>)}</ul></>}
        </details>
        {item.error && <p role="alert" className="text-destructive">{item.error}</p>}
        {item.state === "ready" && <Button variant="outline" onClick={() => void onOpen({ id: item.botId })}>开始对话<ArrowRight /></Button>}
      </article>)}
      {batchIncomplete && <p role="alert" className="text-destructive">部分来源未能验证，请检查迁移包后重新预览。</p>}
      {batchExclusions && <label className="migration-ack"><input type="checkbox" disabled={busy} checked={acknowledged}
        onChange={(event) => setAcknowledged(event.target.checked)} />已检查未纳入的内容</label>}
      <div className="migration-actions">
        <Button disabled={busy || !batchSelection.length || batchIncomplete || batchExclusions && !acknowledged}
          onClick={() => void applyBatch()}>{busy ? "正在导入" : `备份并导入所选 · ${batchSelection.length}`}<ArrowRight /></Button>
        <Button variant="ghost" disabled={busy} onClick={() => {
          setBatch([]); setSelectedIds([]); sessionStorage.removeItem(`${storageKey}:batch`);
        }}>另选来源</Button>
      </div>
    </div>}
    {!plan ? <>{batch.length === 0 && <>
      <form onSubmit={(event) => { event.preventDefault(); void previewBundle(bundlePath); }}>
        <label>迁移清单<Input value={bundlePath} onChange={(event) => setBundlePath(event.target.value)}
          placeholder="livingbot-migration.json 的完整路径" autoComplete="off" /></label>
        <div className="migration-actions">{desktopBridge() && <Button type="button" variant="outline" disabled={busy}
          onClick={() => {
            void desktopBridge()!.chooseMigrationBundle().then((path) => {
              if (path) { setBundlePath(path); void previewBundle(path); }
            }).catch(() => setError("无法选择迁移清单"));
          }}>选择文件</Button>}
          <Button type="submit" disabled={busy || !bundlePath.trim()}><FolderInput />预览伙伴</Button></div>
      </form>
      <details><summary>单独导入工作区</summary><form onSubmit={(event) => { event.preventDefault(); void preview(); }}>
      <label>伙伴名称<Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" /></label>
      <label>原工作区<Input value={source} onChange={(event) => setSource(event.target.value)} placeholder="工作区文件夹的完整路径" autoComplete="off" /></label>
      <Button type="submit" disabled={busy || !source.trim() || !name.trim()}><FolderInput />{busy ? "正在检查" : "预览"}</Button>
    </form></details></>}
      {batch.length === 0 && history.length > 0 && <div className="migration-history" aria-label="导入记录">{history.map((item) => <Button key={item.id}
        variant="outline" onClick={() => { setPlan(item); setAcknowledged(false); setError(undefined); sessionStorage.setItem(storageKey, item.id); }}>
        {item.name}<span>{states[item.state]}</span><ArrowRight />
      </Button>)}</div>}
    </> : <>
      <header className="migration-heading"><div><h2>{plan.name}</h2><code>{plan.source}</code></div>
        <span role="status">{states[plan.state]}{plan.state === "copying" ? ` ${plan.copied ?? 0}/${selected.length}` : ""}</span></header>
      <dl className="migration-counts">{(["profile", "memory", "ability"] as const).map((kind, index) => <div key={kind}>
        <dt>{["身份文件", "记忆文件", "能力文件"][index]}</dt><dd>{selected.filter((file) => file.kind === kind).length}</dd>
      </div>)}</dl>
      <details><summary>查看文件 · {selected.length}</summary><ul>{selected.map((file) => <li key={file.path}><code>{file.path}</code></li>)}</ul></details>
      {Boolean(plan.projections?.length) && <details><summary>记忆检索副本 · {plan.projections!.length}</summary>
        <ul>{plan.projections!.map((item) => <li key={item.source}><code>{item.source}</code><ArrowRight size={12} /><code>{item.target}</code></li>)}</ul>
      </details>}
      {excluded.length > 0 && <details><summary>未纳入 · {excluded.length}</summary><ul>{excluded.map((item, index) => <li key={`${item.path}:${index}`}><code>{item.path}</code><span className="migration-exclusion-reason">{item.reason}</span></li>)}</ul></details>}
      {incomplete && <p role="alert" className="text-destructive">部分来源未能验证，请检查原工作区后重新预览。</p>}
      {plan.state !== "ready" ? <>
        {excluded.length > 0 && <label className="migration-ack"><input type="checkbox" checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)} />已检查未纳入的内容</label>}
        <div className="migration-actions">
          <Button disabled={busy || Boolean(incomplete) || excluded.length > 0 && !acknowledged} onClick={() => void apply()}>
            {busy ? states[plan.state] : plan.state === "preview" ? "备份并导入" : "继续导入"}<ArrowRight />
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => {
            ++generation.current; setPlan(undefined); setError(undefined); setAcknowledged(false); sessionStorage.setItem(storageKey, "");
          }}>重新选择</Button>
        </div>
        <p className="memory-health">导入到独立工作区，原文件保留。</p>
      </> : <Button onClick={() => { void Promise.resolve(onOpen({ id: plan.botId })).catch((cause: unknown) => setError(String(cause))); }}>开始对话<ArrowRight /></Button>}
      {plan.error && !error && <p role="alert" className="text-destructive">{plan.error}</p>}
    </>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </section>;
}
