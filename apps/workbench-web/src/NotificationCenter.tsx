import { ArrowUpRight, Check, CircleAlert } from "lucide-react";
import type { Bot, ResultNotification, Task } from "../../../packages/workbench/src/contracts.ts";

export function NotificationCenter({ notifications, bots, tasks, onOpen }: {
  notifications: ResultNotification[]; bots: Bot[]; tasks: Task[];
  onOpen: (notification: ResultNotification) => void;
}) {
  return <section className="catalog-page notification-center">
    <h1>通知</h1>
    {!notifications.length && <p className="empty-label">还没有工作结果</p>}
    {[...notifications].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).map((notification) =>
      <button key={notification.id} type="button" className="notification-row" onClick={() => onOpen(notification)}>
        <span className={notification.outcome === "failed" ? "text-destructive" : ""}>
          {notification.outcome === "completed" ? <Check size={19} /> : <CircleAlert size={19} />}
        </span>
        <span className="notification-content">
          <strong>{tasks.find((task) => task.id === notification.taskId)?.title || "查看结果"}</strong>
          <small>{bots.find((bot) => bot.id === notification.botId)?.name} · {notification.outcome === "completed" ? "已完成" : "未完成"}
            <time dateTime={new Date(notification.createdAt).toISOString()}>{new Date(notification.createdAt).toLocaleString("zh-CN", {
              month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
            })}</time></small>
        </span>
        {notification.readAt === undefined && <span className="notification-unread" aria-label="未读" />}
        <ArrowUpRight size={17} />
      </button>)}
  </section>;
}
