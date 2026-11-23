import { hasReplyContent, isSilentReply } from "./reply-content.ts";
import type { Artifact, Message } from "./contracts.ts";

/** Read projection only: retain legacy receipts on disk and merge only exact run ownership. */
export function deliveredMessages(messages: Message[], artifacts: Artifact[]): Message[] {
  const superseded = new Set(artifacts.flatMap((file) => file.supersedesId ? [file.supersedesId] : []));
  const output = messages.map((message) => ({ ...message, blocks: message.blocks.filter((block) =>
    (block.kind !== "file" || !superseded.has(block.artifactId)) &&
    (block.kind !== "text" || !isSilentReply(block.text))) }));
  const removed = new Set<string>();
  for (const file of output) {
    if (!file.id.startsWith("file:") || file.role !== "assistant" || !file.runId || !file.taskId ||
      file.blocks.some((block) => block.kind !== "file")) continue;
    const owner = output.find((message) => (message.id === `engine:${file.runId}` || message.id === `report:${file.taskId}`) &&
      message.role === "assistant" && message.conversationId === file.conversationId &&
      message.botId === file.botId && message.taskId === file.taskId && message.runId === file.runId);
    if (!owner) continue;
    for (const block of file.blocks) if (!owner.blocks.some((candidate) => candidate.id === block.id)) owner.blocks.push(block);
    removed.add(file.id);
  }
  return output.filter((message) => !removed.has(message.id) && (message.role !== "assistant" ||
    (!message.final || hasReplyContent(message.blocks, message.silent)))).map((message) => ({ ...message,
    blocks: [...message.blocks.filter((block) => block.kind !== "file"), ...message.blocks.filter((block) => block.kind === "file")],
  }));
}
