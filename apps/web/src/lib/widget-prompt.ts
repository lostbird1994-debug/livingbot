export type WidgetPrompt = { submissionId: string; message: string };

const prefix = "livingbot:widget-prompt:";

export function readWidgetPrompt(key: string): WidgetPrompt | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(`${prefix}${key}`) ?? "null");
    if (value?.version === 1 && typeof value.submissionId === "string" && value.submissionId &&
      typeof value.message === "string" && value.message.trim()) {
      return { submissionId: value.submissionId, message: value.message };
    }
  } catch { /* An unavailable tab store does not prevent ordinary message sending. */ }
}

export function saveWidgetPrompt(key: string, input?: WidgetPrompt): void {
  try {
    sessionStorage.setItem(`${prefix}${key}`, JSON.stringify(input ? { version: 1, ...input } : null));
  } catch { /* The mounted widget retains its pending submission identity. */ }
}
