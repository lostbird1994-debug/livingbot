import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { ArrowDownLeft, ArrowUpRight, Bell, Blocks, Brain, CalendarClock, CircleStop, Command, FolderOpen, Grid2X2, Layers, MessageSquare, Moon, Paperclip, PanelLeftClose, Send, Sun, UsersRound, WifiOff, X } from "lucide-react";
import { Button } from "@livingbot/ui-web/components/ui/button";
import { Input } from "@livingbot/ui-web/components/ui/input";
import { Textarea } from "@livingbot/ui-web/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@livingbot/ui-web/components/ui/dialog";
import { SectionHeading } from "../../../packages/ui-web/src/section-heading.tsx";
import { visualColorTokens } from "@livingbot/ui-tokens";
import { LoadingState } from "@livingbot/ui-web/ai";
import type { Ability, Bot, Conversation, Interaction, Message, ProductEvent, ResultNotification, Snapshot, Task } from "../../../packages/workbench/src/contracts.ts";
import { fileLimits } from "../../../packages/workbench/src/contracts.ts";
import { WorkbenchClient } from "./client.ts";
import type { WorkbenchSnapshot } from "./client.ts";
import { Reply } from "./Reply.tsx";
import { orderMessages } from "./message-order.ts";
import { MessageShare } from "./MessageShare.tsx";
import { InteractionCard } from "./InteractionCard.tsx";
import type { InteractionDraft } from "./InteractionCard.tsx";
import { AbilityCenter } from "./AbilityCenter.tsx";
import { Groups } from "./Groups.tsx";
import { MemoryCenter } from "./MemoryCenter.tsx";
import { MigrationCenter } from "./MigrationCenter.tsx";
import { TaskProcesses } from "./TaskProcesses.tsx";
import { TaskRecovery } from "./TaskRecovery.tsx";
import { RoutineCenter } from "./RoutineCenter.tsx";
import { NotificationCenter } from "./NotificationCenter.tsx";
import { activeTurnStatuses, hasTaskWork, primaryBotTask, taskActivity } from "../../../packages/workbench/src/task-state.ts";
import type { MigrationPreview } from "../../../packages/workbench/src/migration.ts";
import { ModelSettings } from "./ModelSettings.tsx";
import { desktopBridge } from "./desktop.ts";
import { FileCenter } from "./FileCenter.tsx";
import { FileBatches } from "./FileBatches.tsx";
import { WorkRecords } from "./WorkRecords.tsx";

const statuses: Record<ReturnType<typeof taskActivity>, string> = {
  queued: "已排队", running: "正在工作", waiting: "等待你", stopping: "停止中",
  completed: "已完成", failed: "失败", cancelled: "已停止", interrupted: "已中断",
  background: "后台运行", unconfirmed: "状态待确认",
};
type View = "panorama" | "conversation" | "tasks" | "abilities" | "groups" | "memory" | "migration" | "routines" | "notifications" | "model" | "files";
type PendingInput = { submissionId: string; conversationId: string; botId: string; botIds?: string[]; message: string; attachmentIds?: string[]; queueMode?: "followup" | "steer" };
type DraftFile = { id: string; file: File; state: "uploading" | "ready" | "failed"; error?: string };
const themeKey = "livingbot:appearance";

function upsert<T extends { id: string }>(values: T[], next: T): T[] {
  return values.some((value) => value.id === next.id) ? values.map((value) => value.id === next.id ? next : value) : [...values, next];
}

function avatarStyle(bot: Bot, dark: boolean): CSSProperties {
  const palette = visualColorTokens[dark ? "dark" : "light"];
  const key = `${["blue", "teal", "purple", "coral", "amber", "rose"].includes(bot.color) ? bot.color : "teal"}`;
  return {
    "--bot-fill": palette[`${key}Fill` as keyof typeof palette],
    "--bot-stroke": palette[`${key}Stroke` as keyof typeof palette],
    "--bot-text": palette[`${key}Text` as keyof typeof palette],
  } as CSSProperties;
}

function BotPortrait({ bot, dark, small = false }: { bot: Bot; dark: boolean; small?: boolean }) {
  return <span className={`bot-portrait ${small ? "portrait-small" : ""}`} style={avatarStyle(bot, dark)} aria-hidden="true">
    <svg viewBox="0 0 120 120" fill="none">
      <path d="M27 58C27 36 39 24 60 24s33 12 33 34v19c0 16-14 25-33 25S27 93 27 77V58Z" fill="var(--bot-fill)" stroke="var(--bot-stroke)" strokeWidth="1.5" />
      <path d="M35 38c10-17 41-17 50 0M23 63h4m66 0h4M60 24v-9" stroke="var(--bot-stroke)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="60" cy="14" r="4" fill="var(--bot-stroke)" />
      <rect x="36" y="48" width="48" height="29" rx="14.5" fill="var(--bot-text)" />
      <path d="M46 60v6m28-6v6" stroke="var(--bot-fill)" strokeWidth="4" strokeLinecap="round" />
      <path d="M53 88h14" stroke="var(--bot-stroke)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  </span>;
}

export function App() {
  const [client, setClient] = useState<WorkbenchClient>();
  const [origin, setOrigin] = useState(location.origin);
  const [token, setToken] = useState("");
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [routineRevision, setRoutineRevision] = useState(0);
  const [fileRevision, setFileRevision] = useState(0);
  const [filesBotId, setFilesBotId] = useState<string>();
  const [view, setView] = useState<View>("panorama");
  const [migration, setMigration] = useState<MigrationPreview>();
  const [conversationId, setConversationId] = useState<string>();
  const [taskTarget, setTaskTarget] = useState<{ conversationId: string; taskId: string; messageId?: string; notification?: ResultNotification }>();
  const [desktopResultId, setDesktopResultId] = useState<string>();
  const [error, setError] = useState<string>();
  const [connected, setConnected] = useState(false);
  const [dark, setDark] = useState(() => {
    // A chosen appearance survives a reload; storage may be unavailable.
    try { return localStorage.getItem(themeKey) === "dark"; } catch { return false; }
  });
  const [sidebar, setSidebar] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftFiles, setDraftFiles] = useState<Record<string, DraftFile[]>>({});
  const [sendingIds, setSendingIds] = useState<string[]>([]);
  const [pendingInputs, setPendingInputs] = useState<Record<string, PendingInput>>({});
  const [recipients, setRecipients] = useState<Record<string, string[]>>({});
  const [memoryBotId, setMemoryBotId] = useState<string>();
  const [interactionDrafts, setInteractionDrafts] = useState<Record<string, InteractionDraft>>({});
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchInstruction, setBatchInstruction] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<string>();
  const [pendingBatchId, setPendingBatchId] = useState<string>();
  const submitLocks = useRef(new Set<string>());
  const bottom = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const cursor = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => desktopBridge()?.onOpenResult(setDesktopResultId), []);
  useEffect(() => {
    const desktop = desktopBridge();
    if (!desktop) return;
    let active = true;
    void desktop.connect().then(async ({ origin, token }) => {
      const client = new WorkbenchClient(origin, token);
      if (!active) return;
      setClient(client);
      const settings = await client.request<{ configured: boolean }>("/api/model-settings");
      if (active && !settings.configured) setView("model");
    }).catch(() => { if (active) setError("无法连接本机内核，请重新打开应用"); });
    return () => { active = false; };
  }, []);
  const uploadReservations = useRef(new Map<string, Map<string, number>>());
  const receiveAbilities = useCallback((items: Ability[]) => setSnapshot((current) => current ? {
    ...current, abilities: items.reduce((all, item) => upsert(all, item), current.abilities),
  } : current), []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "porcelain";
    try { localStorage.setItem(themeKey, dark ? "dark" : "light"); } catch { /* The choice stays in memory. */ }
  }, [dark]);

  useEffect(() => {
    if (!client) return;
    const abort = new AbortController();
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    const receive = (event: ProductEvent) => {
      if (event.cursor <= cursor.current) return;
      cursor.current = event.cursor;
      setConnected(true);
      if (event.type.startsWith("messages.")) {
        setMessages((current) => upsert(current, event.data as Message)); return;
      }
      if (event.type === "routines.changed" || event.type === "routineReceipts.changed") setRoutineRevision((current) => current + 1);
      if (event.type === "artifacts.changed") setFileRevision((current) => current + 1);
      setSnapshot((current) => {
        if (!current) return current;
        const next = { ...current, cursor: event.cursor };
        if (event.type === "bots.changed") next.bots = upsert(next.bots, event.data as Bot);
        if (event.type === "conversations.changed") next.conversations = upsert(next.conversations, event.data as Conversation);
        if (event.type === "tasks.changed") next.tasks = upsert(next.tasks, event.data as Task);
        if (event.type === "abilities.changed") next.abilities = upsert(next.abilities, event.data as WorkbenchSnapshot["abilities"][number]);
        if (event.type === "interactions.changed") next.interactions = upsert(next.interactions, event.data as Interaction);
        if (event.type === "notifications.changed") next.notifications = upsert(next.notifications, event.data as ResultNotification);
        if (event.type === "fileBatches.changed") next.fileBatches = upsert(next.fileBatches, event.data as Snapshot["fileBatches"][number]);
        if (event.type === "kernel.phase") next.kernel = { phase: (event.data as { phase: string }).phase };
        return next;
      });
      if (event.type === "operation.failed") {
        const failure = event.data as { stage: string; message: string };
        if (failure.stage !== "continuation") setError(failure.message);
      }
      if (event.type === "migration.changed") setMigration(event.data as MigrationPreview);
    };
    const connect = async () => {
      try {
        if (abort.signal.aborted) return;
        await client.events(cursor.current, abort.signal, receive, () => { setConnected(true); retries = 0; });
      } catch (cause) {
        if (abort.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (abort.signal.aborted) return;
      setConnected(false);
      reconnect = setTimeout(() => void connect(), Math.min(10_000, 500 * 2 ** Math.min(retries++, 5)));
    };
    void client.snapshot().then((initial) => {
      if (abort.signal.aborted) return;
      cursor.current = initial.cursor; setSnapshot(initial); setToken("");
      void connect();
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) { setError(cause instanceof Error ? cause.message : String(cause)); setClient(undefined); }
    });
    return () => { abort.abort(); clearTimeout(reconnect); };
  }, [client]);

  useEffect(() => {
    if (!client || !conversationId) return;
    let live = true;
    void client.messages(conversationId).then((page) => {
      if (!live) return;
      setMessages((current) => page.messages.reduce((all, message) => {
        const newer = all.find((item) => item.id === message.id && item.updatedAt > message.updatedAt);
        return newer ? all : upsert(all, message);
      }, current));
    }).catch((cause: unknown) => { if (live) setError(String(cause)); });
    return () => { live = false; };
  }, [client, conversationId]);

  const conversation = snapshot?.conversations.find((item) => item.id === conversationId);
  const draft = conversationId ? drafts[conversationId] ?? "" : "";
  const pending = conversationId ? pendingInputs[conversationId] : undefined;
  const attached = conversationId ? draftFiles[conversationId] ?? [] : [];
  const filesReady = attached.every((item) => item.state === "ready");
  const sending = conversationId ? sendingIds.includes(conversationId) : false;
  const selectedBot = snapshot?.bots.find((bot) => bot.id === conversation?.botIds[0]);
  const selectedRecipients = conversation ? recipients[conversation.id] ?? conversation.botIds : [];
  const visibleMessages = orderMessages(messages.filter((message) => message.conversationId === conversationId));
  const working = snapshot?.tasks.filter(hasTaskWork) ?? [];
  const localWorking = working.filter((task) => task.conversationId === conversationId);
  const localTurns = localWorking.filter((task) => activeTurnStatuses.has(task.status));

  useEffect(() => { followBottom.current = true; }, [conversationId]);
  useEffect(() => {
    if (view !== "conversation") return;
    if (taskTarget && taskTarget.conversationId === conversationId) {
      const target = [...(thread.current?.querySelectorAll<HTMLElement>(".task-recovery[data-task-id]") ?? []),
        ...(thread.current?.querySelectorAll<HTMLElement>(".reply-assistant[data-task-id]") ?? [])]
        .find((node) => taskTarget.messageId ? node.dataset.messageId === taskTarget.messageId :
          taskTarget.notification ? node.dataset.messageId === taskTarget.notification.messageId :
          node.dataset.taskId === taskTarget.taskId);
      // Messages may still be loading after a task in another conversation is
      // selected. Keep the target until its actual reply has been rendered.
      if (target) {
        followBottom.current = false;
        target.scrollIntoView({ behavior: "instant", block: "start" });
        target.focus({ preventScroll: true });
        if (client && taskTarget.notification?.readAt === undefined && taskTarget.notification) {
          void client.request<ResultNotification>(`/api/notifications/${encodeURIComponent(taskTarget.notification.id)}/read`, {})
            .then((updated) => setSnapshot((current) => current ? {
              ...current, notifications: upsert(current.notifications, updated),
            } : current)).catch((cause: unknown) => setError(String(cause)));
        }
        setTaskTarget(undefined);
      }
      return;
    }
    if (followBottom.current) bottom.current?.scrollIntoView({ behavior: "instant", block: "end" });
  }, [client, conversationId, messages, snapshot?.interactions, snapshot?.tasks, view, taskTarget]);

  function openConversation(id: string, taskId?: string, messageId?: string) {
    setTaskTarget(taskId ? { conversationId: id, taskId, messageId } : undefined);
    followBottom.current = !taskId;
    setConversationId(id); setView("conversation");
  }

  function openNotification(notification: ResultNotification) {
    followBottom.current = false;
    setTaskTarget({ conversationId: notification.conversationId, taskId: notification.taskId, notification });
    setConversationId(notification.conversationId); setView("conversation");
  }

  useEffect(() => {
    if (!desktopResultId || !snapshot) return;
    const notification = snapshot.notifications.find((item) => item.id === desktopResultId);
    if (!notification) return;
    openNotification(notification);
    setDesktopResultId(undefined);
  }, [desktopResultId, snapshot]);

  async function openBot(bot: Bot) {
    if (!client || !snapshot) return;
    let target = snapshot.conversations.find((item) => item.kind === "private" && item.botIds[0] === bot.id);
    try {
      target ??= await client.request<Conversation>(`/api/bots/${encodeURIComponent(bot.id)}/private-conversation`, {});
      setSnapshot((current) => current ? { ...current, conversations: upsert(current.conversations, target!) } : current);
      openConversation(target.id);
    } catch (cause) { setError(String(cause)); }
  }

  async function submit(event?: FormEvent, queueMode: "followup" | "steer" = "followup") {
    event?.preventDefault();
    if (!client || !conversation || submitLocks.current.has(conversation.id) || !selectedBot ||
      (!pending && ((!draft.trim() && !attached.length) || !filesReady))) return;
    const input = pending ?? {
      submissionId: crypto.randomUUID(), conversationId: conversation.id,
      botId: selectedBot.id, message: draft.trim(), queueMode,
      ...(conversation.kind === "group" ? { botIds: selectedRecipients } : {}),
      ...(attached.length ? { attachmentIds: attached.map((item) => item.id) } : {}),
    };
    submitLocks.current.add(conversation.id);
    followBottom.current = true;
    setSendingIds((current) => [...current, conversation.id]);
    setPendingInputs((current) => ({ ...current, [conversation.id]: input }));
    setError(undefined);
    try {
      if (input.botIds) {
        const receipt = await client.sendGroup({ ...input, botIds: input.botIds });
        const uncertain = receipt.outcomes.filter((outcome) => !outcome.accepted);
        if (uncertain.length) {
          throw new Error(`${uncertain.map((outcome) => snapshot?.bots.find((bot) => bot.id === outcome.botId)?.name ?? "伙伴").join("、")}尚未确认接收，重试会继续原任务`);
        }
      } else await client.send(input);
      setPendingInputs((current) => { const next = { ...current }; delete next[conversation.id]; return next; });
      setDrafts((current) => ({ ...current, [conversation.id]: "" }));
      setDraftFiles((current) => ({ ...current, [conversation.id]: [] }));
      uploadReservations.current.delete(conversation.id);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      submitLocks.current.delete(conversation.id);
      setSendingIds((current) => current.filter((id) => id !== conversation.id));
    }
  }

  async function uploadFile(item: DraftFile, targetConversationId: string, botId: string) {
    if (!client) return;
    setDraftFiles((current) => ({ ...current, [targetConversationId]: (current[targetConversationId] ?? []).map((file) =>
      file.id === item.id ? { ...file, state: "uploading", error: undefined } : file) }));
    try {
      await client.upload({ id: item.id, conversationId: targetConversationId, botId, file: item.file });
      setDraftFiles((current) => ({ ...current, [targetConversationId]: (current[targetConversationId] ?? []).map((file) =>
        file.id === item.id ? { ...file, state: "ready", error: undefined } : file) }));
    } catch (cause) {
      setDraftFiles((current) => ({ ...current, [targetConversationId]: (current[targetConversationId] ?? []).map((file) =>
        file.id === item.id ? { ...file, state: "failed", error: cause instanceof Error ? cause.message : String(cause) } : file) }));
    }
  }

  async function submitFileBatch() {
    if (!client || !conversation || !selectedBot || batchBusy || !batchInstruction.trim() ||
      attached.length < 2 || !filesReady) return;
    const storageKey = `livingbot:file-batch:${JSON.stringify([client.origin, selectedBot.id, conversation.id])}`;
    let id = pendingBatchId;
    if (!id) {
      try { id = sessionStorage.getItem(storageKey) ?? undefined; } catch { /* Keep the active-page identity. */ }
      id ??= crypto.randomUUID();
      setPendingBatchId(id);
      try { sessionStorage.setItem(storageKey, id); } catch { /* Keep the active-page identity. */ }
    }
    setBatchBusy(true); setBatchError(undefined);
    try {
      const receipt = await client.sendFileBatch({
        id, botId: selectedBot.id, conversationId: conversation.id,
        instruction: batchInstruction.trim(), attachmentIds: attached.map((item) => item.id),
      });
      setSnapshot((current) => current ? {
        ...current, fileBatches: upsert(current.fileBatches, receipt.batch),
        tasks: receipt.outcomes.reduce((items, outcome) => upsert(items, outcome.task), current.tasks),
      } : current);
      if (receipt.outcomes.every((outcome) => outcome.accepted)) {
        try { sessionStorage.removeItem(storageKey); } catch { /* The API receipt remains authoritative. */ }
        setPendingBatchId(undefined); setBatchInstruction(""); setBatchOpen(false);
        setDraftFiles((current) => ({ ...current, [conversation.id]: [] }));
        uploadReservations.current.delete(conversation.id);
      } else setBatchError("部分文件的接收状态尚未确认，重试会沿用原批次。");
    } catch (cause) { setBatchError(cause instanceof Error ? cause.message : "批次尚未确认，请重试"); }
    finally { setBatchBusy(false); }
  }

  function selectFiles(files: FileList | null) {
    if (!files || !conversationId || !selectedBot || pending) return;
    const reservations = uploadReservations.current.get(conversationId) ?? new Map<string, number>();
    const items = Array.from(files).map((file) => ({ id: crypto.randomUUID(), file, state: "uploading" as const }));
    const bytes = [...reservations.values()].reduce((total, size) => total + size, 0) +
      items.reduce((total, item) => total + item.file.size, 0);
    if (reservations.size + items.length > fileLimits.attachments || bytes > fileLimits.bytes) {
      setError("每条消息最多 10 个文件，合计 25 MB"); return;
    }
    for (const item of items) reservations.set(item.id, item.file.size);
    uploadReservations.current.set(conversationId, reservations);
    setDraftFiles((current) => ({ ...current, [conversationId]: [...(current[conversationId] ?? []), ...items] }));
    for (const item of items) void uploadFile(item, conversationId, selectedBot.id);
  }

  function navigate(next: View) { setView(next); }

  if (!client || !snapshot) return <main className="connection-screen">
    <div className="connection-brand"><Command size={26} /><span>LivingBot<sup>2</sup></span></div>
    <form onSubmit={(event) => {
      event.preventDefault();
      try { setError(undefined); setClient(new WorkbenchClient(origin, token)); }
      catch (cause) { setError(String(cause)); }
    }}>
      <SectionHeading as="h2">进入工作室</SectionHeading>
      <label htmlFor="origin">本机地址</label><Input id="origin" value={origin} onChange={(event) => setOrigin(event.target.value)} required />
      <label htmlFor="token">访问密钥</label><Input id="token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} required />
      <Button type="submit" size="lg" disabled={!token || Boolean(client)}>连接<ArrowUpRight /></Button>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </form>
  </main>;

  return <div className={`studio-shell ${sidebar ? "" : "sidebar-collapsed"}`}>
    <a className="skip-link" href="#studio-main">跳到主要内容</a>
    <aside className="studio-sidebar">
      <div className="brand"><Command size={21} /><span>LivingBot<sup>2</sup></span>
        <Button size="icon-sm" variant="ghost" aria-label="收起导航" onClick={() => setSidebar(false)}><PanelLeftClose /></Button></div>
      <nav aria-label="主导航">
        {([
          ["panorama", Grid2X2, "工作室"], ["groups", UsersRound, "群聊"], ["tasks", Layers, "工作记录"], ["routines", CalendarClock, "定时工作"], ["abilities", Blocks, "能力"], ["model", Command, "模型"],
        ] as const).map(([target, Icon, label]) => <Button key={target} variant="ghost" aria-current={view === target ? "page" : undefined}
          aria-label={label} className={`nav-item ${view === target ? "selected" : ""}`} onClick={() => navigate(target)}><Icon />{label}
          {target === "tasks" && working.length > 0 && <span className="nav-count">{working.length}</span>}</Button>)}
      </nav>
      <div className="bot-list-title"><SectionHeading variant="label">伙伴</SectionHeading><span>{snapshot.bots.length}</span></div>
      <div className="compact-bots">{snapshot.bots.map((bot) => {
        const busy = primaryBotTask(working, bot.id);
        return <Button key={bot.id} className={`compact-bot ${selectedBot?.id === bot.id && conversation?.kind === "private" && view === "conversation" ? "selected" : ""}`}
          variant="ghost" onClick={() => void openBot(bot)}><BotPortrait bot={bot} dark={dark} small /><span>{bot.name}</span>
          {busy && <span className="activity-dot" aria-label={statuses[taskActivity(busy)]} />}</Button>;
      })}</div>
      <div className="sidebar-footer"><span className="local-indicator"><span className={connected ? "connection-dot" : ""} />{connected ? "本机工作台" : "连接中"}</span>
        <Button size="icon-sm" variant="ghost" aria-label={dark ? "浅色外观" : "深色外观"} onClick={() => setDark(!dark)}>{dark ? <Sun /> : <Moon />}</Button></div>
    </aside>
    <main className="studio-main" id="studio-main">
      <header className="studio-toolbar">
        {!sidebar && <Button size="icon-sm" variant="ghost" aria-label="展开导航" onClick={() => setSidebar(true)}><PanelLeftClose /></Button>}
        <span>工作室</span><span className="toolbar-slash">/</span>
        <span>{view === "conversation" ? conversation?.title : view === "tasks" ? "工作记录" : view === "routines" ? "定时工作" : view === "notifications" ? "通知" : view === "abilities" ? "能力" : view === "groups" ? "群聊" : view === "memory" ? "记忆" : view === "migration" ? "导入伙伴" : view === "model" ? "模型" : view === "files" ? "文件" : "全景"}</span>
        <div className="toolbar-right">{!connected && <span className="connection-warning"><WifiOff size={14} />重连中</span>}
          <Button size="icon-sm" variant="ghost" className="notification-button"
            aria-label={`通知${snapshot.notifications.some((item) => item.readAt === undefined) ? "，有未读结果" : ""}`}
            aria-pressed={view === "notifications"} onClick={() => setView("notifications")}>
            <Bell />{snapshot.notifications.some((item) => item.readAt === undefined) && <span className="notification-unread" />}
          </Button><span className="edition-label">LOCAL EDITION</span></div>
      </header>
      {error && <div className="error-strip" role="alert"><span>{error}</span><Button size="icon-sm" variant="ghost" aria-label="关闭提示" onClick={() => setError(undefined)}><X /></Button></div>}
      {view === "notifications" && <NotificationCenter notifications={snapshot.notifications} bots={snapshot.bots} tasks={snapshot.tasks} onOpen={openNotification} />}
      {view === "model" && <ModelSettings client={client} />}
      {view === "files" && snapshot.bots.filter((bot) => bot.id === filesBotId).map((bot) =>
        <FileCenter key={bot.id} client={client} bot={bot} conversations={snapshot.conversations}
          tasks={snapshot.tasks} revision={fileRevision} onOpen={(file) => openConversation(file.conversationId, file.taskId,
            file.origin === "delivery" ? `file:${file.id}:${file.conversationId}` : undefined)} />)}
      {view === "panorama" && <section className="panorama">
        <header className="panorama-heading">
          <div><p className="eyebrow">YOUR OWN LITTLE STUDIO</p><h1>各就其位，<br /><span>一起做点什么。</span></h1></div>
          <p className="studio-summary"><span className="summary-number">{String(snapshot.bots.length).padStart(2, "0")}</span><span>位伙伴<span className="summary-divider">/</span>{working.length} 项进行中</span></p>
        </header>
        <div className="panorama-floor">{snapshot.bots.map((bot, index) => {
          const task = primaryBotTask(working, bot.id);
          return <article key={bot.id} className={`bot-station-shell${task ? " has-work" : ""}`}
            style={{ "--station-index": index, ...avatarStyle(bot, dark) } as CSSProperties}>
            <button className="bot-station" onClick={() => void openBot(bot)} aria-label={`与 ${bot.name} 私聊`}>
              <span className="station-number">{String(index + 1).padStart(2, "0")}</span>
              <div className="portrait-stage"><BotPortrait bot={bot} dark={dark} /><span className="station-platform" /></div>
              <div className="station-body">
                <div className="station-identity"><span>{bot.name}</span>
                  <span className="station-destination" aria-hidden="true"><MessageSquare size={12} />私聊</span></div>
                {task
                  ? <span className="station-state"><span className="station-dot is-active" />{statuses[taskActivity(task)]}</span>
                  : <>
                    {bot.description ? <p className="station-description">{bot.description}</p> : null}
                    <span className="station-status"><span />空闲</span>
                  </>}
              </div>
            </button>
            {task && <Button variant="text" className="station-task" aria-label={`打开 ${bot.name} 的工作：${task.title}`}
              onClick={() => openConversation(task.conversationId, task.id)}>
              <span className="station-task-title">{task.title}</span>
              <span className="station-task-go" aria-hidden="true"><ArrowUpRight size={13} />工作</span></Button>}
          </article>;
        })}
          {/* At two columns an odd Bot leaves one empty slot; this closes the floor. */}
          {snapshot.bots.length % 2 === 1 && <div className="bot-station-shell station-filler" aria-hidden="true" />}
        </div>
        <div className="panorama-footer"><span><ArrowDownLeft size={16} />点一位伙伴，开始对话</span>
          <Button variant="text" onClick={() => setView("migration")}>导入伙伴<ArrowUpRight /></Button></div>
      </section>}
      {view === "conversation" && <section className="conversation-layout">
        <header className="conversation-header">{conversation?.kind === "group" ? <UsersRound size={28} /> : selectedBot && <BotPortrait bot={selectedBot} dark={dark} small />}
          <div><SectionHeading as="h2">{conversation?.title}</SectionHeading><span>{conversation?.kind === "group"
            ? conversation.botIds.map((id) => snapshot.bots.find((bot) => bot.id === id)?.name).join("、")
            : selectedBot?.description || "你的工作伙伴"}</span></div>
          {localWorking.length > 0 && <span className="conversation-activity">{statuses[taskActivity(localTurns[0] ?? localWorking[0])]}</span>}
          {conversation?.kind === "private" && <Button type="button" size="icon-sm" variant="ghost" aria-label="查看文件"
            onClick={() => { setFilesBotId(selectedBot?.id); setView("files"); }}><FolderOpen /></Button>}
          {conversation?.kind === "private" && <Button type="button" size="icon-sm" variant="ghost" aria-label="查看记忆"
            onClick={() => { setMemoryBotId(selectedBot?.id); setView("memory"); }}><Brain /></Button>}
        </header>
        <div ref={thread} className="thread" role="log" aria-label="对话记录" onScroll={(event) => {
          const node = event.currentTarget;
          followBottom.current = node.scrollHeight - node.clientHeight - node.scrollTop < 80;
        }}>
          {!visibleMessages.length && <div className="empty-conversation"><MessageSquare size={28} /><h2>从一个想法开始。</h2></div>}
          {visibleMessages.map((message) => {
            const task = snapshot.tasks.find((item) => item.id === message.taskId);
            const owner = snapshot.bots.find((bot) => bot.id === message.botId)?.name ?? conversation?.title ?? "伙伴";
            const executor = task?.delegation?.executor;
            const executorName = executor === "codex" ? "Codex" : executor === "workbuddy" ? "WorkBuddy" : executor;
            const source = task && task.conversationId !== message.conversationId
              ? snapshot.conversations.find((item) => item.id === task.conversationId) : undefined;
            const showProcesses = task?.processes?.length && message.role === "assistant" && message.final &&
              visibleMessages.findLast((entry) => entry.role === "assistant" && entry.taskId === task.id)?.id === message.id;
            const privateReport = conversation?.kind === "group" && task && message.role === "assistant" && message.final &&
              visibleMessages.findLast((entry) => entry.role === "assistant" && entry.taskId === task.id)?.id === message.id
              ? snapshot.notifications.find((notice) => notice.taskId === task.id &&
                notice.conversationId === task.reportConversationId && notice.conversationId !== conversationId)
              : undefined;
            return <Reply key={message.id} message={message} client={client} activity={task ? taskActivity(task) : undefined}
            steeringDelivered={task?.inputDisposition === "steered"}
            reportSource={source ? { title: source.title, open: () => openConversation(source.id, task?.id) } : undefined}
            reportTarget={privateReport ? () => openNotification(privateReport) : undefined}
            taskControls={showProcesses && task ? <TaskProcesses task={task} client={client} /> : undefined}
            shareControl={conversation?.kind === "private" && message.final &&
              ["user", "assistant"].includes(message.role) &&
              message.blocks.some((block) => block.kind === "text" && block.text.trim()) &&
              snapshot.conversations.some((item) => item.kind === "group")
              ? <MessageShare message={message} groups={snapshot.conversations.filter((item) => item.kind === "group")} client={client} />
              : undefined}
            name={executorName ? `${owner} → ${executorName}` : owner}>
            {message.role === "assistant" && snapshot.interactions.filter((prompt) =>
              prompt.conversationId === conversationId && prompt.runId === message.runId).map((prompt) =>
              <InteractionCard key={prompt.id} prompt={prompt} client={client} draft={interactionDrafts[prompt.id]}
                onDraftChange={(draft) => setInteractionDrafts((current) => ({ ...current, [prompt.id]: draft }))} onResolved={(updated) =>
                setSnapshot((current) => current ? { ...current, interactions: upsert(current.interactions, updated) } : current)} />)}
          </Reply>;
          })}
          {snapshot.interactions.filter((prompt) => prompt.conversationId === conversationId &&
            !visibleMessages.some((message) => message.role === "assistant" && message.runId === prompt.runId)).map((prompt) =>
            <InteractionCard key={prompt.id} prompt={prompt} client={client} draft={interactionDrafts[prompt.id]}
              onDraftChange={(draft) => setInteractionDrafts((current) => ({ ...current, [prompt.id]: draft }))} onResolved={(updated) =>
              setSnapshot((current) => current ? { ...current, interactions: upsert(current.interactions, updated) } : current)} />)}
          {localTurns.length > 0 && !visibleMessages.some((message) => !message.final) && <div className="working-state"><LoadingState label={statuses[localTurns[0].status]} startedAt={localTurns[0].createdAt} /></div>}
          {snapshot.tasks.filter((task) => task.conversationId === conversationId && !task.delegation &&
            task.stopRequestedAt === undefined && (task.status === "interrupted" || task.status === "failed" || task.continuationSubmissionId)).map((task) =>
            <TaskRecovery key={task.id} task={task} client={client}
              name={snapshot.bots.find((bot) => bot.id === task.botId)?.name ?? "伙伴"} />)}
          <div ref={bottom} />
        </div>
        <form className="composer" onSubmit={(event) => void submit(event)}>
          {conversation?.kind === "group" && <div className="group-recipients" role="group" aria-label="收件伙伴">
            <span>交给</span>
            <Button type="button" size="sm" variant="ghost" aria-pressed={selectedRecipients.length === conversation.botIds.length}
              disabled={Boolean(pending)} onClick={() => setRecipients((current) => ({ ...current, [conversation.id]: conversation.botIds }))}>所有伙伴</Button>
            {conversation.botIds.map((id) => <Button key={id} type="button" size="sm" variant="ghost"
              aria-pressed={selectedRecipients.includes(id)} disabled={Boolean(pending)}
              onClick={() => setRecipients((current) => ({ ...current, [conversation.id]: selectedRecipients.includes(id)
                ? selectedRecipients.length > 1 ? selectedRecipients.filter((value) => value !== id) : selectedRecipients
                : [...selectedRecipients, id] }))}>{snapshot.bots.find((bot) => bot.id === id)?.name}</Button>)}
          </div>}
          <input ref={fileInput} type="file" multiple hidden aria-label="选择附件" onChange={(event) => {
            selectFiles(event.target.files); event.target.value = "";
          }} />
          {attached.length > 0 && <div className="draft-files">{attached.map((item) => <div className="draft-file" key={item.id}>
            <Paperclip size={14} /><span>{item.file.name}</span>
            {item.state === "uploading" && <small role="status">上传中</small>}
            {item.state === "failed" && <><small role="alert">{item.error}</small><Button type="button" variant="ghost" size="sm"
              onClick={() => selectedBot && conversationId && void uploadFile(item, conversationId, selectedBot.id)}>重试</Button></>}
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`移除附件 ${item.file.name}`} disabled={Boolean(pending)} onClick={() => {
              if (!conversationId) return;
              uploadReservations.current.get(conversationId)?.delete(item.id);
              setDraftFiles((current) => ({ ...current, [conversationId]: (current[conversationId] ?? []).filter((file) => file.id !== item.id) }));
            }}><X /></Button>
          </div>)}</div>}
          {attached.length > 1 && <Button type="button" variant="outline" size="sm"
            disabled={!filesReady || Boolean(pending)} onClick={() => setBatchOpen(true)}>逐个处理 {attached.length} 个文件</Button>}
          <Textarea aria-label="消息" placeholder="交给伙伴一件事…" value={draft} disabled={Boolean(pending)} onChange={(event) => {
            if (conversationId) setDrafts((current) => ({ ...current, [conversationId]: event.target.value }));
          }}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
          <div className="composer-bottom"><span>{conversation?.kind === "group" ? `${selectedRecipients.length} 位伙伴` : selectedBot?.name}<span className="composer-separator">·</span>OpenClaw</span><div className="composer-actions">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="添加附件" disabled={Boolean(pending)} onClick={() => fileInput.current?.click()}><Paperclip /></Button>
            {localTurns.length > 0 && <Button type="button" variant="ghost" aria-label="停止当前工作" onClick={() => {
              void Promise.allSettled(localTurns.map((task) => client.cancel(task.id))).then((results) => {
                const failed = results.find((result) => result.status === "rejected");
                if (failed?.status === "rejected") setError(String(failed.reason));
              });
            }}><CircleStop />停止</Button>}
            {localTurns.some((task) => task.status === "running" || task.status === "waiting") && !pending &&
              <Button type="button" variant="ghost" disabled={sending || (!draft.trim() && !attached.length) || !filesReady}
                onClick={() => void submit(undefined, "steer")}>补充当前工作</Button>}
            <Button type="submit" size={pending ? "default" : "icon"} disabled={sending || (!pending && ((!draft.trim() && !attached.length) || !filesReady))} aria-label={pending ? "重试发送" : "发送消息"}>{pending ? "重试发送" : <Send size={16} />}</Button>
          </div></div>
        </form>
      </section>}
      <Dialog open={batchOpen} onOpenChange={(next) => { if (!batchBusy) setBatchOpen(next); }}>
        <DialogContent>
          <DialogTitle>逐个处理文件</DialogTitle>
          <div className="file-batch-dialog">
            {attached.map((item) => <span key={item.id}>{item.file.name}</span>)}
            <Textarea aria-label="每个文件的处理要求" placeholder="例如：提取每份合同的金额和日期" value={batchInstruction}
              disabled={batchBusy || Boolean(pendingBatchId)} onChange={(event) => setBatchInstruction(event.target.value)} />
            {batchError && <p role="alert" className="text-destructive">{batchError}</p>}
          </div>
          <DialogFooter><Button disabled={batchBusy || !batchInstruction.trim() || !filesReady} onClick={() => void submitFileBatch()}>
            {batchBusy ? "正在提交…" : pendingBatchId ? "重试同一批次" : "开始逐个处理"}
          </Button></DialogFooter>
        </DialogContent>
      </Dialog>
      {view === "tasks" && <WorkRecords tasks={snapshot.tasks} bots={snapshot.bots} conversations={snapshot.conversations}
        notifications={snapshot.notifications} statuses={statuses} onOpen={openConversation} onOpenReport={openNotification} />}
      {view === "tasks" && <FileBatches client={client} batches={snapshot.fileBatches} tasks={snapshot.tasks}
        bots={snapshot.bots} onUpdate={(receipt) => setSnapshot((current) => current ? {
          ...current, fileBatches: upsert(current.fileBatches, receipt.batch),
          tasks: receipt.outcomes.reduce((items, outcome) => upsert(items, outcome.task), current.tasks),
        } : current)} onOpen={openConversation} />}
      {view === "abilities" && <AbilityCenter client={client} bots={snapshot.bots} abilities={snapshot.abilities}
        onChanged={receiveAbilities} />}
      {view === "routines" && <RoutineCenter client={client} bots={snapshot.bots} revision={routineRevision} onOpen={openConversation} />}
      {view === "memory" && <MemoryCenter client={client} bots={snapshot.bots} conversations={snapshot.conversations} initialBotId={memoryBotId} />}
      {view === "migration" && <MigrationCenter client={client} latest={migration} onOpen={async ({ id }) => {
        const updated = await client.snapshot();
        setSnapshot(updated);
        const bot = updated.bots.find((item) => item.id === id);
        if (bot) await openBot(bot);
      }} />}
      {view === "groups" && <Groups client={client} bots={snapshot.bots} conversations={snapshot.conversations}
        onOpen={(target) => openConversation(target.id)}
        onCreated={(target) => {
          setSnapshot((current) => current ? { ...current, conversations: upsert(current.conversations, target) } : current);
          setConversationId(target.id); setView("conversation");
        }} />}
    </main>
  </div>;
}
