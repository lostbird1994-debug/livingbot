import type { Block } from "./contracts.ts";

/** Keep native document references, never execute tool-result URLs or HTML. */
export function nativeWidgets(message: unknown, sessionKey: string): Extract<Block, { kind: "widget" }>[] {
  if (!message || typeof message !== "object" || !("content" in message) || !Array.isArray(message.content)) return [];
  const documents = new Map<string, Extract<Block, { kind: "widget" }>>();
  for (const block of message.content) {
    if (block?.type !== "canvas") continue;
    const preview = block.preview;
    if (preview?.kind !== "canvas" || preview.surface !== "assistant_message" ||
      typeof preview.viewId !== "string" || !/^cv_[a-zA-Z0-9-]+$/.test(preview.viewId) || preview.mcpApp) continue;
    documents.set(preview.viewId, {
      id: `widget:${preview.viewId}`, kind: "widget", docId: preview.viewId, sessionKey,
      title: typeof preview.title === "string" && preview.title.trim() ? preview.title : "交互预览",
    });
  }
  return [...documents.values()];
}
