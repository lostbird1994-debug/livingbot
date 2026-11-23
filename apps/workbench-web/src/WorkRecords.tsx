import { ArrowUpRight, Check, Layers, MessageSquare } from "lucide-react";
import { Button } from "@livingbot/ui-web/components/ui/button";
import type { Bot, Conversation, ResultNotification, Task } from "../../../packages/workbench/src/contracts.ts";
import { taskActivity } from "../../../packages/workbench/src/task-state.ts";

export function WorkRecords({ tasks, bots, conversations, notifications, statuses, onOpen, onOpenReport }: {
  tasks: Task[];
  bots: Bot[];
  conversations: Conversation[];
  notifications: ResultNotification[];
  statuses: Record<ReturnType<typeof taskActivity>, string>;
  onOpen: (conversationId: string, taskId: string) => void;
  onOpenReport: (notification: ResultNotification) => void;
}) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.parentTaskId || !byId.has(task.parentTaskId)) continue;
    const siblings = children.get(task.parentTaskId) ?? [];
    siblings.push(task);
    children.set(task.parentTaskId, siblings);
  }
  function record(task: Task) {
    const activity = taskActivity(task);
    const source = conversations.find((conversation) => conversation.id === task.conversationId);
    const assigned = children.get(task.id) ?? [];
    const report = notifications.filter((notice) => notice.taskId === task.id &&
      notice.conversationId === task.reportConversationId && notice.conversationId !== task.conversationId)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
    return <li key={task.id} data-record-task-id={task.id}>
      <div className="work-record">
        <button className="task-row" onClick={() => onOpen(task.conversationId, task.id)}>
          <span className={`task-icon status-${activity}`}>{activity === "completed" ? <Check size={18} /> : <Layers size={18} />}</span>
          <span className="task-row-title">{task.title}<small>{bots.find((bot) => bot.id === task.botId)?.name}
            {task.delegation && <> → {task.delegation.executor === "codex" ? "Codex" : task.delegation.executor === "workbuddy" ? "WorkBuddy" : task.delegation.executor}</>}
            {source && <> · {source.title}</>}
          </small></span>
          <span>{task.inputDisposition === "steered" ? "补充已送达" : statuses[activity]}</span><ArrowUpRight size={16} />
        </button>
        {report && <Button variant="text" className="work-record-report" onClick={() => onOpenReport(report)}
          aria-label={`查看 ${bots.find((bot) => bot.id === task.botId)?.name ?? "伙伴"} 的私聊汇报：${task.title}`}>
          <MessageSquare size={14} />私聊汇报<ArrowUpRight size={14} />
        </Button>}
      </div>
      {assigned.length > 0 && <details className="work-record-assignments" open>
        <summary>{assigned.length} 项分派</summary>
        <ul className="work-records">{assigned.map(record)}</ul>
      </details>}
    </li>;
  }
  return <section className="catalog-page">
    <p className="eyebrow">THE WORK, IN PROGRESS</p><h1>工作记录</h1>
    {tasks.length === 0 && <p className="empty-label">还没有工作记录</p>}
    <ul className="work-records">{[...tasks].reverse()
      .filter((task) => !task.parentTaskId || !byId.has(task.parentTaskId)).map(record)}</ul>
  </section>;
}
