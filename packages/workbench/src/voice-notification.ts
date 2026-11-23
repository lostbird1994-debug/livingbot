export const DEFAULT_NOTIFICATION_TEMPLATE = "收到{botName}发来的消息：{message}";
export function notificationTemplate(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 300)
    throw new Error("播报模板需为 1–300 字");
  if (/\{[^{}]*\}/g.test(value.replaceAll("{botName}", "").replaceAll("{message}", "")))
    throw new Error("模板仅支持 {botName} 和 {message}");
  return value.trim();
}
export function notificationLine(template: string, botName: string, message: string): string {
  if (!message.trim()) return "";
  return notificationTemplate(template)
    .replace(/\{botName\}|\{message\}/g, (token) => (token === "{botName}" ? botName : message))
    .slice(0, 500);
}
