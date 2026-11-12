import type { Bot, TaskSession } from "@rakazo/contracts";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input } from "@rakazo/ui-web";
import { History, Plus, X } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RpcClient } from "../../lib/rpc";

export function taskStatus(task: Pick<TaskSession, "status" | "resourceWaitReason">) {
  if (task.resourceWaitReason === "unconfirmed") return "核实状态中";
  if (task.resourceWaitReason === "stopping") return "正在停止";
  if (task.resourceWaitReason === "computer") return "等待电脑";
  if (task.resourceWaitReason === "task_slot") return "等待执行名额";
  return ({ queued: "已接收", leased: "准备中", running: "执行中", waiting_input: "待你确认",
    waiting_takeover: "待你操作", completed: "已完成", failed: "失败", cancelled: "已停止" } as Record<string, string>)[task.status] ?? "未发送";
}
interface Layout { botId: string; opened: string[]; selected: string | null; drafts: string[] }
function readLayout(botId: string, scope: string): Layout {
  try {
    const value = JSON.parse(localStorage.getItem(`rakazo.taskTabs.${scope}.${botId}`) ?? "null");
    if (value?.botId === botId && Array.isArray(value.opened)) return { ...value, drafts: value.drafts ?? value.opened.filter((id: string) => id.startsWith("draft:")) };
  } catch { /* A corrupt local layout never changes server records. */ }
  return { botId, opened: [], selected: null, drafts: [] };
}
export function useBotTaskTabs(bot: Bot | undefined, rpc: RpcClient, scope: string, routeTask: string | null) {
  const botId = bot?.id ?? "";
  const [, setSearchParams] = useSearchParams();
  const navigateTask = useCallback((key: string | null) => {
    if (window.location.pathname !== `/app/${botId}`) return;
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      if (key && !key.startsWith("draft:")) next.set("task", key); else next.delete("task");
      return next;
    }, { replace: true });
  }, [setSearchParams, botId]);
  const [layout, setLayout] = useState(() => readLayout(botId, scope));
  const current = useMemo(() => layout.botId === botId ? layout : readLayout(botId, scope), [layout, botId, scope]);
  const [rows, setRows] = useState<{ botId: string; tasks: TaskSession[] }>({ botId: "", tasks: [] });
  const [enabled, setEnabled] = useState(false);
  const [history, setHistory] = useState(false);
  const [findRequest, setFindRequest] = useState(0);
  const [stopList, setStopList] = useState<Awaited<ReturnType<RpcClient["taskSessions"]["activeRuns"]>> | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!botId) return;
    const tasks = await rpc.taskSessions.list({ botId });
    setRows({ botId, tasks });
  }, [rpc, botId]);
  useEffect(() => {
    let alive = true;
    setEnabled(false);
    void rpc.taskSessions.capabilities({}).then(result => { if (alive) setEnabled(result.enabled); }).catch(() => {});
    return () => { alive = false; };
  }, [rpc]);
  useEffect(() => {
    if (!botId || !enabled) return;
    let alive = true;
    const update = async () => { try { await refresh(); if (alive) setError(null); } catch { if (alive) setError("任务状态暂时无法读取"); } };
    void update();
    const timer = window.setInterval(() => void update(), 3000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [botId, enabled, refresh]);
  const change = useCallback((next: Layout) => {
    setLayout(next);
    try { localStorage.setItem(`rakazo.taskTabs.${scope}.${botId}`, JSON.stringify(next)); } catch { setError("页签布局未能保存到此设备"); }
  }, [botId, scope]);
  const select = useCallback((key: string | null) => { navigateTask(key); change({ ...current,
    drafts: key?.startsWith("draft:") && !current.drafts.includes(key) ? [...current.drafts, key] : current.drafts,
    selected: key, opened: key && !current.opened.includes(key) ? [...current.opened, key] : current.opened,
  }); }, [current, change, navigateTask]);
  useEffect(() => {
    if (!routeTask || !enabled || !botId) return;
    const latest = readLayout(botId, scope);
    if (latest.selected === routeTask && latest.opened.includes(routeTask)) return;
    change({ ...latest, selected: routeTask,
      opened: latest.opened.includes(routeTask) ? latest.opened : [...latest.opened, routeTask] });
  }, [routeTask, enabled, botId, scope, change]);
  const close = (key: string) => { if (current.selected === key) navigateTask(null); change({ ...current, opened: current.opened.filter(id => id !== key), selected: current.selected === key ? null : current.selected }); };
  const tasks = rows.botId === botId ? rows.tasks : [];
  const adopt = (draftId: string, session: TaskSession) => {
    // A late server acceptance updates this draft's layout only; it cannot redirect a different tab.
    const latest = readLayout(botId, scope);
    const wasOpen = latest.opened.includes(draftId);
    if (latest.selected === draftId) navigateTask(session.id);
    change({ botId, drafts: latest.drafts.filter(id => id !== draftId), opened: latest.opened.map(id => id === draftId ? session.id : id),
      selected: latest.selected === draftId ? session.id : latest.selected });
    if (wasOpen) setRows(previous => ({ botId, tasks: [session, ...(previous.botId === botId ? previous.tasks.filter(t => t.id !== session.id) : [])] }));
    void refresh();
  };
  return { enabled: enabled && Boolean(bot), selected: current.selected, opened: current.opened, drafts: current.drafts, tasks, select, close,
    create: () => select(`draft:${crypto.randomUUID()}`), history, setHistory, error, refresh, adopt, findRequest, requestFind: () => setFindRequest(value => value + 1),
    stopList, setStopList, stopping,
    prepareStopAll: async () => { try { setStopList(await rpc.taskSessions.activeRuns({ botId })); } catch { setError("当前任务列表无法读取，请重试"); } },
    stopAll: async () => { if (!stopList?.length || stopping) return; setStopping(true); try {
      await rpc.taskSessions.stopAll({ botId, runIds: stopList.map(run => run.id) }); await refresh(); setStopList(null);
    } catch { setError("部分任务尚未确认停止，请核实状态后重试"); } finally { setStopping(false); } },
  };
}
export type BotTaskTabs = ReturnType<typeof useBotTaskTabs>;

export function TaskTabs({ state }: { state: BotTaskTabs }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  if (!state.enabled) return null;
  const opened = state.opened.map(id => ({ id, task: state.tasks.find(t => t.id === id) }));
  const active = (task: TaskSession) => !["completed", "failed", "cancelled"].includes(task.status) || Boolean(task.resourceWaitReason);
  const filtered = state.tasks.filter(task => task.title.toLowerCase().includes(query.toLowerCase()) &&
    (filter === "all" || filter === "active" && active(task) || filter === "attention" && ["waiting_input", "waiting_takeover"].includes(task.status) || filter === "ended" && !active(task)));
  return <>
    <div className="relative z-10 flex items-center gap-1 border-b border-border/60 px-3 py-1.5" aria-label="任务导航">
      <div className="hidden min-w-0 flex-1 gap-1 overflow-x-auto md:flex" role="tablist" aria-label="打开的任务">
        <Button size="sm" variant={state.selected === null ? "secondary" : "ghost"} role="tab" aria-selected={state.selected === null} onClick={() => state.select(null)}>主聊天</Button>
        {opened.map(({ id, task }) => <div key={id} className="flex shrink-0 items-center rounded-lg bg-transparent">
          <Button size="sm" variant={state.selected === id ? "secondary" : "ghost"} role="tab" aria-selected={state.selected === id} title={task?.title} onClick={() => state.select(id)}>
            <span className="max-w-36 truncate">{task?.title ?? (id.startsWith("draft:") ? "新任务" : "读取任务…")}</span>
            {task ? <span className={task.status === "waiting_input" ? "text-warning" : "text-muted-foreground"}>{taskStatus(task)}{task.unread ? " ·" : ""}</span> : null}
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={`收起任务 ${task?.title ?? "新任务"}`} title="收起任务" onClick={() => state.close(id)}><X size={13} /></Button>
        </div>)}
      </div>
      <select aria-label="当前任务" className="min-w-0 flex-1 bg-background text-sm md:hidden" value={state.selected ?? "main"} onChange={event => state.select(event.target.value === "main" ? null : event.target.value)}>
        <option value="main">主聊天</option>{opened.map(({ id, task }) => <option key={id} value={id}>{task ? `${task.title} · ${taskStatus(task)}` : "新任务"}</option>)}
      </select>
      {state.selected ? <Button size="icon-sm" variant="ghost" className="md:hidden" aria-label="收起当前任务" onClick={() => state.close(state.selected!)}><X size={14} /></Button> : null}
      <Button size="sm" variant="ghost" onClick={state.create}><Plus size={14} />新任务</Button>
      <Button size="sm" variant="ghost" onClick={() => state.setHistory(true)} aria-label="全部任务"><History size={14} /><span className="hidden sm:inline">全部任务</span>{state.tasks.length + state.drafts.length || ""}</Button>
    </div>
    <Dialog open={state.history} onOpenChange={state.setHistory}>
      <DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>全部任务</DialogTitle></DialogHeader>
        <Button size="sm" variant="ghost" className="justify-self-end text-destructive" onClick={() => void state.prepareStopAll()}>停止全部当前任务</Button>
        <Input aria-label="搜索任务名称" placeholder="搜索任务名称" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="flex gap-1">{([["all", "全部"], ["active", "进行中"], ["attention", "待处理"], ["ended", "已结束"]] as const).map(([key, title]) =>
          <Button key={key} size="sm" variant={filter === key ? "secondary" : "ghost"} onClick={() => setFilter(key)}>{title}</Button>)}</div>
        {state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
        {state.drafts.length && (filter === "all" || filter === "active") && !query ? <div>
          <p className="px-3 text-xs text-muted-foreground">此设备上的草稿</p>{state.drafts.map((id, index) => <button key={id} className="flex w-full justify-between rounded-lg px-3 py-2 text-sm hover:bg-muted" onClick={() => { state.select(id); state.setHistory(false); }}><span>新任务 {index + 1}</span><span className="text-muted-foreground">未发送</span></button>)}
        </div> : null}
        <div className="max-h-96 overflow-y-auto">{filtered.length ? filtered.sort((a, b) => Number(active(b)) - Number(active(a))).map(task =>
          <button key={task.id} className="flex w-full items-center justify-between gap-4 rounded-lg px-3 py-3 text-left hover:bg-muted focus-visible:outline-ring" onClick={() => { state.select(task.id); state.setHistory(false); }}>
            <span className="min-w-0"><span className="block truncate text-sm font-medium">{task.title}</span><span className="text-xs text-muted-foreground">{new Date(task.updatedAt).toLocaleString()}</span></span>
            <span className="shrink-0 text-sm text-muted-foreground">{taskStatus(task)}</span>
          </button>) : <p className="py-8 text-center text-sm text-muted-foreground">没有符合条件的任务</p>}</div>
      </DialogContent>
    </Dialog>
    <Dialog open={state.stopList !== null} onOpenChange={open => { if (!open && !state.stopping) state.setStopList(null); }}>
      <DialogContent><DialogHeader><DialogTitle>停止全部当前任务</DialogTitle></DialogHeader>
        {state.stopList?.length ? <><p className="text-sm text-muted-foreground">将停止以下执行，后续例行日程保留。</p>
          <ul className="max-h-64 overflow-auto text-sm">{state.stopList.map(run => <li key={run.id} className="py-2">{run.title}</li>)}</ul>
          <Button variant="destructive" disabled={state.stopping} onClick={() => void state.stopAll()}>{state.stopping ? "正在停止…" : "停止这些任务"}</Button></> : <p className="text-sm text-muted-foreground">当前没有正在执行的任务</p>}
        {state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
      </DialogContent>
    </Dialog>
  </>;
}
