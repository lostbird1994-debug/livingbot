import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CalendarClock, Pause, Pencil, Play, Plus } from "lucide-react";
import { Button } from "@livingbot/ui-web/components/ui/button";
import { Input } from "@livingbot/ui-web/components/ui/input";
import { Textarea } from "@livingbot/ui-web/components/ui/textarea";
import { NativeSelect, NativeSelectOption } from "@livingbot/ui-web/components/ui/native-select";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@livingbot/ui-web/components/ui/dialog";
import type { Bot, Conversation } from "../../../packages/workbench/src/contracts.ts";
import type { Routine, RoutineInput, RoutineReceipt } from "../../../packages/workbench/src/routines.ts";
import type { RoutineSchedule } from "../../../packages/kernel-runtime/src/routines.ts";
import type { WorkbenchClient } from "./client.ts";

function when(timestamp?: number): string {
  return timestamp === undefined ? "—" : new Date(timestamp).toLocaleString("zh-CN", {
    ...(new Date(timestamp).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}
function rhythm(schedule: RoutineSchedule): string {
  if (schedule.kind === "at") return `一次 · ${when(Date.parse(schedule.at))}`;
  if (schedule.kind === "every") return `每 ${schedule.everyMs / 60_000} 分钟`;
  return `${schedule.expr} · ${schedule.tz}`;
}
const delivery = { delivered: "已送达", "not-delivered": "未送达", unknown: "送达待确认" };
const completion = { succeeded: "已完成", failed: "失败", unknown: "结果待确认" };
function ended(routine: Routine): boolean {
  return routine.schedule.kind === "at" && routine.lastRunAt !== undefined &&
    routine.lastRunAt >= Date.parse(routine.schedule.at) && !routine.enabled;
}
function localDate(at: string): string {
  const date = new Date(at);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function RoutineCenter({ client, bots, revision, onOpen }: {
  client: WorkbenchClient; bots: Bot[]; revision: number; onOpen: (conversationId: string) => void;
}) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [receipts, setReceipts] = useState<RoutineReceipt[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Routine>();
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [repeat, setRepeat] = useState("daily");
  const [time, setTime] = useState("09:00");
  const [date, setDate] = useState("");
  const [weekday, setWeekday] = useState(String(new Date().getDay()));
  const [minutes, setMinutes] = useState("60");
  const [expression, setExpression] = useState("");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef<RoutineInput | undefined>(undefined);
  const selected = routines.find((routine) => routine.id === selectedId);
  useEffect(() => {
    let live = true;
    void client.request<{ routines: Routine[] }>("/api/routines").then((page) => {
      if (live) setRoutines(page.routines);
    }).catch((cause: unknown) => { if (live) setError(String(cause)); });
    return () => { live = false; };
  }, [client, revision]);
  useEffect(() => {
    let live = true;
    setReceipts([]);
    if (selectedId) void client.request<{ entries: RoutineReceipt[] }>(`/api/routines/${encodeURIComponent(selectedId)}/history`)
      .then((page) => { if (live) setReceipts(page.entries); })
      .catch((cause: unknown) => { if (live) setError(String(cause)); });
    return () => { live = false; };
  }, [client, selectedId, revision]);
  function populate(input: RoutineInput) {
    setBotId(input.botId); setName(input.name); setMessage(input.message);
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const schedule = input.schedule;
    if (schedule.kind === "at") {
      setRepeat("once");
      setDate(localDate(schedule.at));
    } else if (schedule.kind === "every") {
      setRepeat("interval"); setMinutes(String(schedule.everyMs / 60_000));
    } else {
      setTimezone(schedule.tz); setExpression(schedule.expr);
      const fields = schedule.expr.split(/\s+/);
      const simple = fields.length === 5 && fields[2] === "*" && fields[3] === "*" &&
        /^\d+$/.test(fields[0]) && /^\d+$/.test(fields[1]) &&
        Number(fields[0]) <= 59 && Number(fields[1]) <= 23;
      const repeat = simple && fields[4] === "*" ? "daily" : simple && fields[4] === "1-5" ? "weekdays" :
        simple && /^[0-6]$/.test(fields[4]) ? "weekly" : "custom";
      setRepeat(repeat);
      if (repeat !== "custom") {
        setTime(`${fields[1].padStart(2, "0")}:${fields[0].padStart(2, "0")}`);
        if (repeat === "weekly") setWeekday(fields[4]);
      }
    }
  }
  function beginCreate() {
    setEditing(undefined); setError(undefined);
    if (pending.current) populate(pending.current);
    else {
      setName(""); setMessage(""); setRepeat("daily"); setTime("09:00"); setDate("");
      setWeekday(String(new Date().getDay())); setMinutes("60"); setExpression("");
      setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    }
    setOpen(true);
  }
  function beginEdit(routine: Routine) {
    setError(undefined); setEditing(routine); populate(routine); setOpen(true);
  }
  async function save() {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      if (editing || !pending.current) {
        const [hour, minute] = time.split(":").map(Number);
        if (!botId || !name.trim() || !message.trim()) throw new Error("请选择伙伴并填写名称和任务");
        if (["daily", "weekdays", "weekly"].includes(repeat) && (!Number.isInteger(hour) || hour < 0 || hour > 23 ||
          !Number.isInteger(minute) || minute < 0 || minute > 59)) throw new Error("请选择有效时间");
        const unchangedDate = repeat === "once" && editing?.schedule.kind === "at" &&
          date === localDate(editing.schedule.at);
        if (repeat === "once" && (!Number.isFinite(Date.parse(date)) || !unchangedDate && Date.parse(date) <= Date.now())) {
          throw new Error("请选择未来的日期和时间");
        }
        const schedule: RoutineSchedule = repeat === "once" ? {
          kind: "at", at: unchangedDate && editing?.schedule.kind === "at" ? editing.schedule.at : new Date(date).toISOString(),
        } :
          repeat === "interval" ? { kind: "every", everyMs: Number(minutes) * 60_000 } : {
            kind: "cron", expr: repeat === "custom" ? expression :
              `${minute} ${hour} * * ${repeat === "weekdays" ? "1-5" : repeat === "weekly" ? weekday : "*"}`,
            tz: timezone,
          };
        if (editing) {
          const saved = await client.request<Routine>(`/api/routines/${encodeURIComponent(editing.id)}/update`, {
            revision: editing.revision, name: name.trim(), message: message.trim(), schedule,
          });
          setRoutines((current) => current.map((routine) => routine.id === saved.id ? saved : routine));
          setSelectedId(saved.id); setOpen(false); setEditing(undefined);
          return;
        }
        const conversation = await client.request<Conversation>(`/api/bots/${encodeURIComponent(botId)}/private-conversation`, {});
        pending.current = {
          id: crypto.randomUUID(), botId, conversationId: conversation.id, name: name.trim(), message: message.trim(),
          schedule,
        };
      }
      const saved = await client.request<Routine>("/api/routines", pending.current);
      setRoutines((current) => [...current.filter((routine) => routine.id !== saved.id), saved]);
      setSelectedId(saved.id); setOpen(false); pending.current = undefined; setName(""); setMessage("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function change(routine: Routine) {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      const updated = routine.state === "pending"
        ? await client.request<Routine>("/api/routines", routine)
        : await client.request<Routine>(`/api/routines/${encodeURIComponent(routine.id)}/access`, {
          enabled: !routine.enabled, revision: routine.revision,
        });
      setRoutines((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="catalog-page routine-center">
    <div className="group-heading"><h1>定时工作</h1><Button onClick={beginCreate} disabled={!bots.length}><Plus />新建安排</Button></div>
    {error && !open && <p role="alert" className="text-destructive">{error}</p>}
    {!routines.length && <p className="empty-label">还没有安排</p>}
    {routines.map((routine) => <article className="routine-row" key={routine.id}>
      <button type="button" className="routine-summary" aria-expanded={selectedId === routine.id}
        onClick={() => setSelectedId(selectedId === routine.id ? undefined : routine.id)}>
        <CalendarClock size={20} /><span><strong>{routine.name}</strong><small>{bots.find((bot) => bot.id === routine.botId)?.name} · {rhythm(routine.schedule)}</small></span>
        <span className="routine-next">{routine.state === "pending" ? "待确认" : routine.runningAt ? "正在工作" : ended(routine) ? "已执行" : routine.enabled ? `下次 ${when(routine.nextRunAt)}` : "已暂停"}</span>
      </button>
      {!ended(routine) && <Button type="button" variant="ghost" size="sm" disabled={busy}
        aria-label={`${routine.state === "pending" ? "确认安排" : routine.enabled ? "暂停" : "启用"}：${routine.name}`}
        onClick={() => void change(routine)}>{routine.state === "pending" ? "确认安排" : routine.enabled ? <Pause /> : <Play />}</Button>}
    </article>)}
    {selected && <section className="routine-detail" aria-label={`${selected.name}的执行记录`}>
      <header><h2>{selected.name}</h2>
        <Button variant="ghost" size="sm" disabled={busy || selected.state !== "ready"} onClick={() => beginEdit(selected)}><Pencil />编辑</Button>
        <Button variant="ghost" size="sm" onClick={() => onOpen(selected.conversationId)}>查看对话<ArrowUpRight /></Button></header>
      <p>{selected.message}</p>
      {selected.error && <p role="alert" className="text-destructive">{selected.error}</p>}
      {selected.disabledReason && <p role="status">已自动暂停 · {selected.disabledReason}</p>}
      {!receipts.length && <p className="empty-label">尚无执行记录</p>}
      {receipts.toReversed().map((receipt) => <article className="routine-outcome" key={receipt.id}>
        <header><time>{when(receipt.startedAt ?? receipt.timestamp)}</time><span>{receipt.status === "skipped" ? "已跳过" : receipt.completion ? completion[receipt.completion] : receipt.status === "error" ? "失败" : "结果待确认"}</span>{receipt.delivery !== "not-requested" && <span>{delivery[receipt.delivery]}</span>}</header>
        {receipt.summary && <p>{receipt.summary}</p>}
        {receipt.error && <p className="text-destructive">{receipt.error}</p>}
      </article>)}
    </section>}
    <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
      <DialogContent><DialogTitle>{editing ? "编辑安排" : "新建安排"}</DialogTitle>
        <form className="routine-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <fieldset disabled={busy || !editing && Boolean(pending.current)}>
            <label>伙伴<NativeSelect disabled={Boolean(editing)} value={botId} onChange={(event) => setBotId(event.target.value)}>{bots.map((bot) => <NativeSelectOption key={bot.id} value={bot.id}>{bot.name}</NativeSelectOption>)}</NativeSelect></label>
            <label>名称<Input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required /></label>
            <label>做什么<Textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={16_000} required /></label>
            <div className="routine-time">
              <label>重复<NativeSelect value={repeat} onChange={(event) => setRepeat(event.target.value)}>
                <NativeSelectOption value="once">一次</NativeSelectOption><NativeSelectOption value="daily">每天</NativeSelectOption>
                <NativeSelectOption value="weekdays">工作日</NativeSelectOption><NativeSelectOption value="weekly">每周</NativeSelectOption>
                <NativeSelectOption value="interval">间隔</NativeSelectOption>
                {repeat === "custom" && <NativeSelectOption value="custom">自定义</NativeSelectOption>}
              </NativeSelect></label>
              {repeat === "interval" ? <label>分钟<Input type="number" min={1} max={525600} step="any" value={minutes}
                onChange={(event) => setMinutes(event.target.value)} required /></label> :
                repeat === "custom" ? <label>表达式<Input value={expression} onChange={(event) => setExpression(event.target.value)} required /></label> :
                <label>时间<Input type={repeat === "once" ? "datetime-local" : "time"} required
                value={repeat === "once" ? date : time} onChange={(event) => repeat === "once" ? setDate(event.target.value) : setTime(event.target.value)} /></label>
              }
            </div>
            {repeat === "weekly" && <label>星期<NativeSelect value={weekday} onChange={(event) => setWeekday(event.target.value)}>
              {["日", "一", "二", "三", "四", "五", "六"].map((day, index) => <NativeSelectOption key={day} value={String(index)}>周{day}</NativeSelectOption>)}
            </NativeSelect></label>}
            {repeat !== "once" && repeat !== "interval" && (repeat === "custom" || timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone) &&
              <label>时区<Input value={timezone} onChange={(event) => setTimezone(event.target.value)} required /></label>}
          </fieldset>
          {error && <p role="alert" className="text-destructive">{error}</p>}
          <DialogFooter><Button type="submit" disabled={busy || !name.trim() || !message.trim()}>{editing ? busy ? "保存中" : "保存" : busy ? "安排中" : pending.current ? "确认安排" : "安排"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </section>;
}
