import type { MessageBlock } from "@rakazo/contracts";

type Ask = Extract<MessageBlock, { kind: "ask" }>;

const ZH_TOOLS: Record<string, string> = {
  schedule_update: "修改定时任务",
  schedule_create: "创建定时任务",
  schedule_cancel: "取消定时任务",
  create_child_routine: "创建子任务",
  gmail_send_email: "发送邮件",
  send_email: "发送邮件",
  web_fetch: "访问网站",
  paid_request: "发送付费请求",
  user_computer_shell: "在你的电脑运行命令",
  user_computer_act: "操作你的电脑",
  user_computer_observe: "查看你的电脑",
  delete_bot: "删除机器人",
  archive_bot: "归档机器人",
  update_bot: "修改机器人设置",
  generate_image: "生成图片",
  generate_video: "生成视频",
  create_space: "创建空间",
  save_shared_memory: "保存共享记忆",
  forget_memory: "删除记忆",
  forget_secret: "删除凭据",
  create_group: "创建群组",
  update_group: "修改群组",
  set_child_instructions: "修改子机器人指令",
  set_child_bot_model: "修改子机器人模型",
  respond_agent_connection: "处理机器人连接",
};
const ZH_FIELDS: Record<string, string> = {
  name: "任务名称",
  prompt: "任务内容",
  cron: "执行时间（Cron）",
  every: "执行间隔",
  unit: "间隔单位",
  active: "是否启用",
  timezone: "时区",
  runAt: "执行时间",
  startAt: "开始时间",
  delayMinutes: "延迟分钟数",
  delaySeconds: "延迟秒数",
  watch: "触发条件",
  previous_schedule: "原执行时间（Cron）",
};
const ZH_REASONS: Record<NonNullable<Ask["approvalContext"]>["reason"], string> = {
  new_schedule_site: "该自动任务包含尚未授权的网站，后续任务可能自动访问该网站，需要你确认。",
  command_watch: "这个任务会定时运行命令，需要你确认具体命令。",
  unattended: "这项操作由自动任务或外部消息触发，需要你确认。",
  explicit: "这项操作需要由你本人明确确认。",
  policy: "当前审批规则要求你确认这项操作。",
  review: "自动审查未能确认这项操作符合你的授权，需要你确认。",
};
const EN_REASONS: Record<keyof typeof ZH_REASONS, string> = {
  new_schedule_site:
    "This saves a new, unapproved website in an unattended task. Confirm the destination.",
  command_watch: "This task will run a command unattended. Confirm the command.",
  unattended: "An automatic task or outside message requested this action.",
  explicit: "This action requires your explicit confirmation.",
  policy: "Your current approval rules require confirmation.",
  review: "Automatic review could not confirm this action fits your authorization.",
};

/** Presentation only. Decisions and resolved changes come from the backend. */
export function approvalPresentation(
  block: Ask,
  locale: string,
): { title: string; detail?: string; expandedDetail?: string; expandedLabel?: string } {
  const chinese = locale.toLowerCase().startsWith("zh");
  const context = block.approvalContext;
  if (!context) {
    const prefix = "Review before ";
    return {
      title:
        chinese && block.approvalEffectId && block.text.startsWith(prefix)
          ? `请确认：${ZH_TOOLS[block.text.slice(prefix.length)] ?? block.text.slice(prefix.length)}`
          : block.text,
      detail: block.detail,
    };
  }
  const operation = chinese ? (ZH_TOOLS[context.tool] ?? `执行操作 ${context.tool}`) : context.tool;
  const lines = [
    `${chinese ? "需要确认的原因" : "Reason"}：${(chinese ? ZH_REASONS : EN_REASONS)[context.reason]}`,
    ...(context.target ? [`${chinese ? "任务" : "Task"}：${context.target}`] : []),
    ...(context.sites?.length
      ? [`${chinese ? "待授权网站" : "Websites to approve"}：${context.sites.join(", ")}`]
      : []),
  ];
  const expanded: string[] = [];
  const value = (field: string, text: string) => {
    if (!chinese) return text;
    if (field === "active") return text === "true" ? "启用" : text === "false" ? "暂停" : text;
    if (field === "unit")
      return (
        ({ minutes: "分钟", hours: "小时", days: "天", seconds: "秒" } as Record<string, string>)[
          text
        ] ?? text
      );
    return text;
  };
  for (const change of context.changes ?? []) {
    if (change.before === change.after) continue;
    const field = chinese ? (ZH_FIELDS[change.field] ?? change.field) : change.field;
    const after = value(change.field, change.after);
    const changeText =
      change.before === undefined
        ? `${field}：${after}`
        : `${field}：\n${chinese ? "修改前" : "Before"}：${value(change.field, change.before)}\n${chinese ? "修改后" : "After"}：${after}`;
    if (change.field === "prompt") expanded.push(changeText);
    else lines.push(changeText);
  }
  // Other approval kinds already have a bounded, redacted detail from the backend.
  if (!context.changes?.length && block.detail) lines.push(block.detail);
  return {
    title: `${chinese ? "请确认：" : "Confirm: "}${operation}${context.target ? `「${context.target}」` : ""}`,
    detail: lines.join("\n\n"),
    ...(expanded.length
      ? {
          expandedDetail: expanded.join("\n\n"),
          expandedLabel: chinese ? "查看任务内容修改详情" : "View task instruction changes",
        }
      : {}),
  };
}
