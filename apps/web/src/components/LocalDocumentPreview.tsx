import { useCallback, useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@livingbot/ui-web";
import { NativePreviewFrame as PreviewFrame } from "@livingbot/ui-web/native-preview";
import { localPreviewClient as client } from "../lib/local-workbench";
import type { ThreadMessage } from "@livingbot/contracts";


import { readWidgetPrompt, saveWidgetPrompt } from "../lib/widget-prompt";
import type { WidgetPrompt } from "../lib/widget-prompt";

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content],{type}));
  const link = document.createElement("a"); link.href=url; link.download=name; link.click(); URL.revokeObjectURL(url);
}

export function LocalDocumentPreview({ preview, message }: {
  preview: {blockId:string;title:string}; message:ThreadMessage;
}) {
  const block = {id:preview.blockId,title:preview.title};
  const messageId = message.id;
  const storageKey = JSON.stringify([client.origin, messageId, block.id]);
  const [html, setHtml] = useState<string>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const pending = useRef<WidgetPrompt | undefined>(readWidgetPrompt(storageKey));
  const sending = useRef(false);
  const [sendingPrompt, setSendingPrompt] = useState(false);
  const [promptError, setPromptError] = useState<string | undefined>(() =>
    pending.current ? "上次发送尚未确认" : undefined);
  const sendPrompt = useCallback(async (text: string) => {
    if (sending.current || !message.botId || message.role !== "bot") return;
    if (pending.current && pending.current.message !== text) {
      setPromptError("请先重试上次尚未确认的发送"); return;
    }
    const input = pending.current ?? { submissionId: crypto.randomUUID(), message: text };
    pending.current = input;
    saveWidgetPrompt(storageKey, input);
    sending.current = true; setSendingPrompt(true); setPromptError(undefined);
    try {
      await client.send({ ...input, botId: message.botId, conversationId: message.threadId });
      pending.current = undefined;
      saveWidgetPrompt(storageKey);
    } catch (reason) {
      setPromptError(reason instanceof Error ? reason.message : "发送尚未确认");
    } finally { sending.current = false; setSendingPrompt(false); }
  }, [client, message.botId, message.role, message.threadId, storageKey]);
  useEffect(() => {
    let active = true;
    setError(undefined); setHtml(undefined);
    void client.request<{ html: string }>(
      `/api/messages/${encodeURIComponent(messageId)}/widgets/${encodeURIComponent(block.id)}`,
    ).then((value) => { if (active) setHtml(value.html); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "预览暂不可用"); });
    return () => { active = false; };
  }, [client, messageId, block.id, attempt]);
  return <section className="min-w-0 space-y-2" aria-label={block.title}>
    <div className="flex items-center justify-between gap-2 text-muted-foreground"><span>{block.title}</span>
      {html !== undefined && <Button variant="ghost" size="icon-sm" aria-label="导出预览"
        onClick={() => download("preview.html", html, "text/html;charset=utf-8")}><Download /></Button>}
    </div>
    {html !== undefined ? <PreviewFrame source={html} title={block.title} nativeDocument
      onPrompt={message.botId && message.role === "bot" ? (text) => void sendPrompt(text) : undefined} /> : error
      ? <div role="alert">{error}<Button variant="ghost" onClick={() => setAttempt(attempt + 1)}>重试</Button></div>
      : <span role="status">正在载入预览</span>}
    {sendingPrompt && <span role="status">正在发送…</span>}
    {promptError && <div role="alert">{promptError}
      <Button variant="ghost" disabled={sendingPrompt} onClick={() => {
        if (pending.current) void sendPrompt(pending.current.message);
      }}>重试发送</Button>
    </div>}
  </section>;
}
