import { useLingui } from "@lingui/react/macro";
import type { Bot, TaskSession } from "@livingbot/contracts";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
} from "@livingbot/ui-web";
import { MoreHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { composerDraftBindingsKey, composerDraftStorageKey } from "../../lib/composer-draft";
import type { DocumentTab } from "../../lib/document-tabs";
import { localConnected, useLocalJournalRefresh } from "../../lib/local-workbench";
import type { RpcClient } from "../../lib/rpc";
import { clearTaskDraftFiles } from "../../lib/task-draft-files";

export function taskStatus(task: Pick<TaskSession, "status" | "resourceWaitReason">) {
  if (task.resourceWaitReason === "unconfirmed") return "核实状态中";
  if (task.resourceWaitReason === "stopping") return "正在停止";
  if (task.resourceWaitReason === "computer") return "等待电脑";
  if (task.resourceWaitReason === "task_slot") return "等待执行名额";
  return (
    (
      {
        queued: "已接收",
        leased: "准备中",
        running: "执行中",
        waiting_input: "待你确认",
        waiting_takeover: "待你操作",
        completed: "已完成",
        failed: "失败",
        cancelled: "已停止",
      } as Record<string, string>
    )[task.status] ?? "未发送"
  );
}

/**
 * Tabs carry a mark instead of status text: a pulsing ring while the task works,
 * a steady dot when it waits on you or has failed.
 */
function taskTabMark(
  task: Pick<TaskSession, "status" | "resourceWaitReason">,
): "working" | "attention" | "failed" | null {
  if (
    task.resourceWaitReason === "unconfirmed" ||
    task.resourceWaitReason === "stopping" ||
    task.resourceWaitReason === "computer" ||
    task.resourceWaitReason === "task_slot"
  ) {
    return "working";
  }
  if (task.status === "queued" || task.status === "leased" || task.status === "running") {
    return "working";
  }
  if (task.status === "waiting_input" || task.status === "waiting_takeover") return "attention";
  if (task.status === "failed") return "failed";
  return null;
}

function TabMark({ kind }: { kind: "working" | "attention" | "failed" }) {
  const tone =
    kind === "working"
      ? "bg-status-working"
      : kind === "attention"
        ? "bg-warning"
        : "bg-destructive";
  return (
    <span className="relative flex size-1.5 shrink-0">
      {kind === "working" ? (
        <span
          className={`absolute inline-flex size-full animate-ping rounded-full opacity-70 motion-reduce:animate-none ${tone}`}
        />
      ) : null}
      <span className={`relative inline-flex size-1.5 rounded-full ${tone}`} />
    </span>
  );
}

interface Layout {
  botId: string;
  opened: string[];
  selected: string | null;
  drafts: string[];
  titles?: Record<string, string>;
}
function readLayout(botId: string, scope: string): Layout {
  try {
    const value = JSON.parse(localStorage.getItem(`rakazo.taskTabs.${scope}.${botId}`) ?? "null");
    if (value?.botId === botId && Array.isArray(value.opened))
      return {
        ...value,
        drafts: value.drafts ?? value.opened.filter((id: string) => id.startsWith("draft:")),
      };
  } catch {
    /* A corrupt local layout never changes server records. */
  }
  return { botId, opened: [], selected: null, drafts: [] };
}
export function useBotTaskTabs(
  bot: Bot | undefined,
  rpc: RpcClient,
  scope: string,
  routeTask: string | null,
) {
  const botId = bot?.id ?? "";
  const [, setSearchParams] = useSearchParams();
  const navigateTask = useCallback(
    (key: string | null) => {
      if (window.location.pathname !== `/app/${botId}`) return;
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (key && !key.startsWith("draft:")) next.set("task", key);
          else next.delete("task");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams, botId],
  );
  const [layout, setLayout] = useState(() => readLayout(botId, scope));
  const current = useMemo(
    () => (layout.botId === botId ? layout : readLayout(botId, scope)),
    [layout, botId, scope],
  );
  const [rows, setRows] = useState<{ botId: string; tasks: TaskSession[] }>({
    botId: "",
    tasks: [],
  });
  const [enabled, setEnabled] = useState(false);
  const [history, setHistory] = useState(false);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [findRequest, setFindRequest] = useState(0);
  const [stopList, setStopList] = useState<Awaited<
    ReturnType<RpcClient["taskSessions"]["activeRuns"]>
  > | null>(null);
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
    void rpc.taskSessions
      .capabilities({})
      .then((result) => {
        if (alive) setEnabled(result.enabled);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [rpc]);
  useEffect(() => {
    if (!botId || !enabled) return;
    let alive = true;
    const update = async () => {
      try {
        await refresh();
        if (alive) setError(null);
      } catch {
        if (alive) setError("会话状态暂时无法读取");
      }
    };
    void update();
    const timer = localConnected() ? undefined : window.setInterval(() => void update(), 3000);
    return () => {
      alive = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [botId, enabled, refresh]);
  // Native sessions use the durable journal, including its reconnect replay.
  useLocalJournalRefresh(["tasks.changed", "conversations.changed", "runs.changed"], () => {
    if (botId && enabled) void refresh().catch(() => undefined);
  });
  const change = useCallback(
    (next: Layout) => {
      setLayout(next);
      try {
        localStorage.setItem(`rakazo.taskTabs.${scope}.${botId}`, JSON.stringify(next));
      } catch {
        setError("页签布局未能保存到此设备");
      }
    },
    [botId, scope],
  );
  const select = useCallback(
    (key: string | null) => {
      navigateTask(key);
      change({
        ...current,
        drafts:
          key?.startsWith("draft:") && !current.drafts.includes(key)
            ? [...current.drafts, key]
            : current.drafts,
        selected: key,
        opened: key && !current.opened.includes(key) ? [...current.opened, key] : current.opened,
      });
    },
    [current, change, navigateTask],
  );
  useEffect(() => {
    if (!routeTask || !enabled || !botId) return;
    const latest = readLayout(botId, scope);
    if (latest.selected === routeTask && latest.opened.includes(routeTask)) return;
    change({
      ...latest,
      selected: routeTask,
      opened: latest.opened.includes(routeTask) ? latest.opened : [...latest.opened, routeTask],
    });
  }, [routeTask, enabled, botId, scope, change]);
  const close = (key: string) => {
    if (current.selected === key) navigateTask(null);
    change({
      ...current,
      opened: current.opened.filter((id) => id !== key),
      selected: current.selected === key ? null : current.selected,
    });
  };
  /** Closing a draft tab keeps its text; discarding it also drops the draft entry and its
   *  saved text and attachments, which is the only way to remove one from this device. */
  const discard = useCallback(
    (key: string) => {
      const latest = readLayout(botId, scope);
      const opened = latest.opened.filter((id) => id !== key);
      const selected =
        latest.selected === key
          ? (opened[Math.max(0, latest.opened.indexOf(key) - 1)] ?? null)
          : latest.selected;
      if (latest.selected === key) navigateTask(selected);
      const titles = { ...latest.titles };
      delete titles[key];
      change({
        ...latest,
        titles,
        drafts: latest.drafts.filter((id) => id !== key),
        opened,
        selected,
      });
      const draftKey = `task:${scope}:${botId}:${key}`;
      try {
        localStorage.removeItem(composerDraftStorageKey(draftKey));
        localStorage.removeItem(composerDraftBindingsKey(draftKey));
        localStorage.removeItem(`${draftKey}:model`);
      } catch {
        /* The entry is gone from the list even if storage refuses. */
      }
      void clearTaskDraftFiles(draftKey).catch(() => undefined);
    },
    [botId, scope, change, navigateTask],
  );
  const tasks = rows.botId === botId ? rows.tasks : [];
  useEffect(() => {
    if (rows.botId !== botId) return;
    const deleted = new Set(rows.tasks.filter((task) => task.archivedAt).map((task) => task.id));
    if (!current.opened.some((id) => deleted.has(id)) && !deleted.has(current.selected ?? ""))
      return;
    const opened = current.opened.filter((id) => !deleted.has(id));
    const selected = deleted.has(current.selected ?? "") ? (opened[0] ?? null) : current.selected;
    change({ ...current, opened, selected });
    navigateTask(selected);
  }, [rows, botId, current, change, navigateTask]);
  const adopt = (draftId: string, session: TaskSession) => {
    // A late server acceptance updates this draft's layout only; it cannot redirect a different tab.
    const latest = readLayout(botId, scope);
    const wasOpen = latest.opened.includes(draftId);
    if (latest.selected === draftId) navigateTask(session.id);
    change({
      ...latest,
      botId,
      drafts: latest.drafts.filter((id) => id !== draftId),
      opened: latest.opened.map((id) => (id === draftId ? session.id : id)),
      selected: latest.selected === draftId ? session.id : latest.selected,
    });
    if (wasOpen)
      setRows((previous) => ({
        botId,
        tasks: [
          session,
          ...(previous.botId === botId ? previous.tasks.filter((t) => t.id !== session.id) : []),
        ],
      }));
    void refresh();
  };
  const forget = (id: string) => {
    const latest = readLayout(botId, scope);
    const index = latest.opened.indexOf(id);
    const opened = latest.opened.filter((key) => key !== id);
    const selected =
      latest.selected === id ? (opened[Math.max(0, index - 1)] ?? null) : latest.selected;
    if (latest.selected === id) navigateTask(selected);
    change({ ...latest, opened, selected });
  };
  const mutate = async (operation: () => Promise<void>) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await operation();
    } catch {
      setError("操作未完成，请重试");
    } finally {
      setSaving(false);
    }
  };
  return {
    enabled: enabled && Boolean(bot),
    selected: current.selected,
    opened: current.opened,
    drafts: current.drafts,
    draftTitle: (id: string) => current.titles?.[id],
    editing,
    setEditing,
    deleting,
    setDeleting,
    saving,
    rename: () =>
      mutate(async () => {
        if (!editing?.title.trim()) return;
        if (editing.id.startsWith("draft:")) {
          const latest = readLayout(botId, scope);
          change({ ...latest, titles: { ...latest.titles, [editing.id]: editing.title.trim() } });
        } else {
          await rpc.taskSessions.rename({
            botId,
            taskSessionId: editing.id,
            title: editing.title.trim(),
          });
          await refresh();
        }
        setEditing(null);
      }),
    remove: () =>
      mutate(async () => {
        if (!deleting) return;
        if (deleting.startsWith("draft:")) discard(deleting);
        else {
          await rpc.taskSessions.delete({ botId, taskSessionId: deleting });
          forget(deleting);
          await refresh();
        }
        setDeleting(null);
      }),
    restore: (id: string) =>
      mutate(async () => {
        await rpc.taskSessions.archive({ botId, taskSessionId: id, archived: false });
        await refresh();
      }),
    tasks,
    select,
    close,
    discard,
    create: () => select(`draft:${crypto.randomUUID()}`),
    history,
    setHistory,
    error,
    refresh,
    adopt,
    findRequest,
    requestFind: () => setFindRequest((value) => value + 1),
    stopList,
    setStopList,
    stopping,
    prepareStopAll: async () => {
      try {
        setStopList(await rpc.taskSessions.activeRuns({ botId }));
      } catch {
        setError("当前会话列表无法读取，请重试");
      }
    },
    stopAll: async () => {
      if (!stopList?.length || stopping) return;
      setStopping(true);
      try {
        await rpc.taskSessions.stopAll({ botId, runIds: stopList.map((run) => run.id) });
        await refresh();
        setStopList(null);
      } catch {
        setError("部分会话尚未确认停止，请核实状态后重试");
      } finally {
        setStopping(false);
      }
    },
  };
}
export type BotTaskTabs = ReturnType<typeof useBotTaskTabs>;

export function TaskTabs({
  state,
  documents = [],
  selectedDocument,
  onSelectDocument,
  onCloseDocument,
}: {
  state: BotTaskTabs;
  documents?: DocumentTab[];
  selectedDocument?: string;
  onSelectDocument?: (id: string) => void;
  onCloseDocument?: (id: string) => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  if (!state.enabled && !documents.length) return null;
  const opened = (state.enabled ? state.opened : []).map((id) => ({
    id,
    task: state.tasks.find((t) => t.id === id),
  }));
  const active = (task: TaskSession) =>
    !["completed", "failed", "cancelled"].includes(task.status) || Boolean(task.resourceWaitReason);
  const filtered = state.tasks.filter(
    (task) =>
      (filter === "deleted" ? Boolean(task.archivedAt) : !task.archivedAt) &&
      task.title.toLowerCase().includes(query.toLowerCase()) &&
      (filter === "all" ||
        filter === "deleted" ||
        (filter === "active" && active(task)) ||
        (filter === "attention" && ["waiting_input", "waiting_takeover"].includes(task.status)) ||
        (filter === "ended" && !active(task))),
  );
  // The row only appears once a session or document is open; the new/all session
  // actions live in the chat header menu at every size.
  return (
    <>
      {opened.length || documents.length ? (
        <nav
          className="relative z-10 flex items-center gap-1 border-b border-border/60 px-3 py-1.5"
          aria-label="会话导航"
        >
          <div
            className="hidden min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto md:flex"
            role="tablist"
            aria-label="打开的会话"
          >
            <div
              className={`flex min-w-24 flex-1 basis-0 items-center rounded-t-lg ${
                !selectedDocument && state.selected === null ? "bg-muted" : "hover:bg-muted/50"
              }`}
            >
              <Button
                size="sm"
                variant="ghost"
                role="tab"
                aria-selected={!selectedDocument && state.selected === null}
                onClick={() => state.select(null)}
                className="min-w-0 flex-1 justify-start rounded-t-lg px-2.5 text-muted-foreground hover:bg-transparent aria-selected:text-foreground"
              >
                <span className="min-w-0 truncate">主会话</span>
              </Button>
            </div>
            {opened.map(({ id, task }) => {
              const selected = !selectedDocument && state.selected === id;
              const title =
                task?.title ??
                (id.startsWith("draft:") ? (state.draftTitle?.(id) ?? "新会话") : "读取会话…");
              const mark = task ? taskTabMark(task) : null;
              return (
                <ContextMenu key={id}>
                  <ContextMenuTrigger
                    render={<div />}
                    className="flex min-w-24 flex-1 basis-0 items-center"
                  >
                    <div
                      className={`group/tab flex min-w-24 flex-1 basis-0 items-center rounded-t-lg ${
                        selected ? "bg-muted" : "hover:bg-muted/50"
                      }`}
                    >
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`收起会话 ${title}`}
                        title="收起会话"
                        onClick={() => state.close(id)}
                        className="pointer-events-none order-first ms-1 size-5 shrink-0 rounded-full text-muted-foreground opacity-0 transition-opacity group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 motion-reduce:transition-none"
                      >
                        <X size={12} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        role="tab"
                        aria-selected={selected}
                        title={task ? `${title} · ${taskStatus(task)}` : title}
                        onClick={() => state.select(id)}
                        className="min-w-0 flex-1 justify-start gap-1.5 rounded-t-lg px-1 text-muted-foreground hover:bg-transparent aria-selected:text-foreground"
                      >
                        <span className="min-w-0 truncate">{title}</span>
                        {mark ? <TabMark kind={mark} /> : null}
                        {task?.unread && !mark ? (
                          <span className="size-1.5 shrink-0 rounded-full bg-foreground/40" />
                        ) : null}
                      </Button>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem
                      onClick={() =>
                        state.setEditing({
                          id,
                          title: task?.title ?? state.draftTitle?.(id) ?? "新会话",
                        })
                      }
                    >
                      重命名
                    </ContextMenuItem>
                    <ContextMenuItem
                      className="text-destructive"
                      onClick={() => state.setDeleting(id)}
                    >
                      删除
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
            {documents.map((document) => (
              <div
                key={document.id}
                className={`group/tab flex min-w-24 flex-1 basis-0 items-center rounded-t-lg ${
                  selectedDocument === document.id ? "bg-muted" : "hover:bg-muted/50"
                }`}
              >
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`${t`Close preview`} ${document.name}`}
                  onClick={() => onCloseDocument?.(document.id)}
                  className="pointer-events-none order-first ms-1 size-5 shrink-0 rounded-full text-muted-foreground opacity-0 transition-opacity group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 motion-reduce:transition-none"
                >
                  <X size={12} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  role="tab"
                  aria-selected={selectedDocument === document.id}
                  title={document.name}
                  onClick={() => onSelectDocument?.(document.id)}
                  className="min-w-0 flex-1 justify-start rounded-t-lg px-1 text-muted-foreground hover:bg-transparent aria-selected:text-foreground"
                >
                  <span className="min-w-0 truncate">{document.name}</span>
                </Button>
              </div>
            ))}
          </div>
          <select
            aria-label="当前会话"
            className="min-w-0 flex-1 bg-background text-sm md:hidden"
            value={selectedDocument ? `document:${selectedDocument}` : (state.selected ?? "main")}
            onChange={(event) => {
              if (event.target.value.startsWith("document:"))
                onSelectDocument?.(event.target.value.slice("document:".length));
              else state.select(event.target.value === "main" ? null : event.target.value);
            }}
          >
            <option value="main">主会话</option>
            {opened.map(({ id, task }) => (
              <option key={id} value={id}>
                {task
                  ? `${task.title} · ${taskStatus(task)}`
                  : (state.draftTitle?.(id) ?? "新会话")}
              </option>
            ))}
            {documents.map((document) => (
              <option key={document.id} value={`document:${document.id}`}>
                {document.name}
              </option>
            ))}
          </select>
          {selectedDocument ? (
            <Button
              size="icon-sm"
              variant="ghost"
              className="md:hidden"
              aria-label={t`Close preview`}
              onClick={() => onCloseDocument?.(selectedDocument)}
            >
              <X size={14} />
            </Button>
          ) : state.selected ? (
            <Button
              size="icon-sm"
              variant="ghost"
              className="md:hidden"
              aria-label="收起当前会话"
              onClick={() => state.close(state.selected!)}
            >
              <X size={14} />
            </Button>
          ) : null}
        </nav>
      ) : null}
      {state.enabled ? (
        <TaskHistoryDialogs
          state={state}
          query={query}
          filter={filter}
          setQuery={setQuery}
          setFilter={setFilter}
          active={active}
          filtered={filtered}
        />
      ) : null}
    </>
  );
}

function TaskHistoryDialogs({
  state,
  query,
  filter,
  setQuery,
  setFilter,
  active,
  filtered,
}: {
  state: BotTaskTabs;
  query: string;
  filter: string;
  setQuery: (value: string) => void;
  setFilter: (value: string) => void;
  active: (task: TaskSession) => boolean;
  filtered: TaskSession[];
}) {
  return (
    <>
      <Dialog
        open={Boolean(state.editing)}
        onOpenChange={(open) => {
          if (!open && !state.saving) state.setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void state.rename();
            }}
            className="grid gap-3"
          >
            <Input
              autoFocus
              aria-label="会话名称"
              maxLength={100}
              value={state.editing?.title ?? ""}
              onChange={(event) => {
                if (state.editing)
                  state.setEditing({ ...state.editing, title: event.target.value });
              }}
            />
            {state.error ? (
              <p role="alert" className="text-sm text-destructive">
                {state.error}
              </p>
            ) : null}
            <Button type="submit" disabled={state.saving || !state.editing?.title.trim()}>
              保存
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(state.deleting)}
        onOpenChange={(open) => {
          if (!open && !state.saving) state.setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除会话？</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {state.deleting?.startsWith("draft:") ? "草稿及其内容将被移除。" : "可从“已删除”恢复。"}
          </p>
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          ) : null}
          <Button variant="destructive" disabled={state.saving} onClick={() => void state.remove()}>
            {state.tasks.some((task) => task.id === state.deleting && active(task))
              ? "停止并删除"
              : "删除"}
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog open={state.history} onOpenChange={state.setHistory}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>全部会话</DialogTitle>
          </DialogHeader>
          <Button
            size="sm"
            variant="ghost"
            className="justify-self-end text-destructive"
            onClick={() => void state.prepareStopAll()}
          >
            停止全部当前会话
          </Button>
          <Input
            aria-label="搜索会话名称"
            placeholder="搜索会话名称"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="flex gap-1">
            {(
              [
                ["all", "全部"],
                ["active", "进行中"],
                ["attention", "待处理"],
                ["ended", "已结束"],
                ["deleted", "已删除"],
              ] as const
            ).map(([key, title]) => (
              <Button
                key={key}
                size="sm"
                variant={filter === key ? "secondary" : "ghost"}
                onClick={() => setFilter(key)}
              >
                {title}
              </Button>
            ))}
          </div>
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          ) : null}
          {state.drafts.length && (filter === "all" || filter === "active") && !query ? (
            <div>
              <p className="px-3 text-xs text-muted-foreground">此设备上的草稿</p>
              {state.drafts.map((id, index) => (
                <div key={id} className="flex items-center gap-1">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 justify-between rounded-lg px-3 py-2 text-sm hover:bg-muted"
                    onClick={() => {
                      state.select(id);
                      state.setHistory(false);
                    }}
                  >
                    <span>{state.draftTitle?.(id) ?? `新会话 ${index + 1}`}</span>
                    <span className="text-muted-foreground">未发送</span>
                  </button>
                  <TaskMenu
                    state={state}
                    id={id}
                    title={state.draftTitle?.(id) ?? `新会话 ${index + 1}`}
                  />
                </div>
              ))}
            </div>
          ) : null}
          <div className="max-h-96 overflow-y-auto">
            {filtered.length ? (
              filtered
                .sort((a, b) => Number(active(b)) - Number(active(a)))
                .map((task) => (
                  <div key={task.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={Boolean(task.archivedAt)}
                      className="flex min-w-0 flex-1 items-center justify-between gap-4 rounded-lg px-3 py-3 text-left hover:bg-muted focus-visible:outline-ring"
                      onClick={() => {
                        if (task.archivedAt) return;
                        state.select(task.id);
                        state.setHistory(false);
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{task.title}</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(task.updatedAt).toLocaleString()}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm text-muted-foreground">
                        {taskStatus(task)}
                      </span>
                    </button>
                    <TaskMenu
                      state={state}
                      id={task.id}
                      title={task.title}
                      deleted={Boolean(task.archivedAt)}
                    />
                  </div>
                ))
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">没有符合条件的会话</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={state.stopList !== null}
        onOpenChange={(open) => {
          if (!open && !state.stopping) state.setStopList(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>停止全部当前会话</DialogTitle>
          </DialogHeader>
          {state.stopList?.length ? (
            <>
              <p className="text-sm text-muted-foreground">将停止以下执行，后续例行日程保留。</p>
              <ul className="max-h-64 overflow-auto text-sm">
                {state.stopList.map((run) => (
                  <li key={run.id} className="py-2">
                    {run.title}
                  </li>
                ))}
              </ul>
              <Button
                variant="destructive"
                disabled={state.stopping}
                onClick={() => void state.stopAll()}
              >
                {state.stopping ? "正在停止…" : "停止这些会话"}
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">当前没有正在执行的会话</p>
          )}
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function TaskMenu({
  state,
  id,
  title,
  deleted = false,
}: {
  state: BotTaskTabs;
  id: string;
  title: string;
  deleted?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`会话操作 ${title}`}
        className="shrink-0 rounded-md p-2 hover:bg-muted"
      >
        <MoreHorizontal size={14} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {deleted ? (
          <DropdownMenuItem disabled={state.saving} onClick={() => void state.restore(id)}>
            恢复
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuItem onClick={() => state.setEditing({ id, title })}>
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem className="text-destructive" onClick={() => state.setDeleting(id)}>
              删除
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
