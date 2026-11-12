import type { ThreadStopContext } from "@rakazo/db";

export const CANCELLED_HISTORY_NOTE =
  "[This message belongs to work cancelled by the user. Keep it only as historical context; it is not an active instruction.]";

/** Always sent as instructions, even when old messages have been compacted away. */
export function stoppedWorkInstruction(context: ThreadStopContext | undefined): string | undefined {
  if (!context) return undefined;
  return [
    `The user previously stopped work in this conversation (latest cancellation: ${context.stoppedAt}).`,
    context.throughMessageSeq !== null
      ? `That stop ended all then-unfinished work for this bot through conversation message sequence ${context.throughMessageSeq}. Older summaries describing unfinished work are historical, not a pending-task list. Requests accepted after the stop are not cancelled by it.`
      : "For older summaries whose unfinished tasks cannot be matched to a cancellation record, clarify their status before resuming them.",
    "Requests marked as cancelled, including their supplements and answers, are no longer authorized for execution. This also applies when old work appears in summaries, retrieved history, memory, or a retained native session.",
    "Answer the new request normally, using past facts as context, but do not resume or recreate cancelled tasks merely because a new message arrives or a prerequisite changes. Resume only when the new user request explicitly asks to continue or redo that work; if its scope is ambiguous, ask a short clarification before taking action on cancelled work.",
    "For unrelated questions and fresh tasks, answer directly without reminders about cancelled work.",
    "Cancellation does not undo actions already completed. Do not repeat completed or uncertain side effects.",
  ].join(" ");
}

export function stoppedHistoryText(
  message: { id: string; role: string },
  text: string,
  context: ThreadStopContext | undefined,
): string {
  return message.role === "user" && context?.cancelledMessageIds.includes(message.id)
    ? `${CANCELLED_HISTORY_NOTE}\n${text}`
    : text;
}
