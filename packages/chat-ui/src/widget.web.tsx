import type { WidgetVisual } from "@livingbot/contracts";
import { INLINE_VISUAL_REFERENCE_EVENT, inlineVisualMarkdown } from "@livingbot/contracts";
import { WIDGET_VIEWER_PATH } from "@livingbot/contracts/content-security-policy";
import { appearanceColorScheme, webTokensForAppearance } from "@livingbot/ui-tokens";
import { Button, Dialog, DialogContent, DialogTitle } from "@livingbot/ui-web";
import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { InlineVisualReferenceContext } from "./markdown";
import { useMarkdownCopy } from "./markdown-copy";
import { useChatAppearance } from "./mermaid.web";
import { widgetDocument } from "./widget-document";

function save(data: string, filename: string) {
  const link = document.createElement("a");
  link.href = data;
  link.download = filename;
  link.click();
}

function WidgetFrame({
  visual,
  streaming,
  onPrompt,
  exportRequested = 0,
}: {
  visual: WidgetVisual;
  streaming: boolean;
  onPrompt: (text: string) => void;
  exportRequested?: number;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useId();
  const appearance = useChatAppearance();
  const [loads, setLoads] = useState(0);
  const [height, setHeight] = useState(320);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const exportPending = useRef(false);
  const [pendingPrompt, setPendingPrompt] = useState("");
  const copy = useMarkdownCopy();
  const html = useMemo(
    () =>
      widgetDocument(
        visual,
        webTokensForAppearance(appearance),
        appearanceColorScheme(appearance),
        channel,
        !streaming,
      ),
    [visual, appearance, channel, streaming],
  );
  const filename = visual.title.replace(/[^\p{L}\p{N}_-]/gu, "_") || "visual";
  useEffect(() => {
    if (!loads) return;
    setError("");
    setReady(false);
    exportPending.current = false;
    setPendingPrompt("");
    frame.current?.contentWindow?.postMessage(
      { channel, type: "render", document: html, complete: !streaming },
      "*",
    );
  }, [loads, html, channel, streaming]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.channel !== channel) return;
      const data = event.data;
      if (data.type === "resize" && Number.isFinite(data.height))
        setHeight(Math.max(80, Math.min(1600, data.height)));
      if (data.type === "ready") setReady(true);
      if (data.type === "error") {
        exportPending.current = false;
        setError(copy.renderError);
      }
      if (
        data.type === "prompt" &&
        !streaming &&
        typeof data.text === "string" &&
        data.text.length <= 2000
      )
        setPendingPrompt(data.text);
      if (
        data.type === "image" &&
        exportPending.current &&
        typeof data.data === "string" &&
        data.data.length <= 16_000_000 &&
        /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(data.data)
      ) {
        exportPending.current = false;
        save(data.data, `${filename}.png`);
      }
    };
    addEventListener("message", receive);
    return () => removeEventListener("message", receive);
  }, [channel, copy.renderError, filename, onPrompt, streaming]);
  useEffect(() => {
    if (exportRequested && !streaming) {
      exportPending.current = true;
      frame.current?.contentWindow?.postMessage({ channel, type: "export" }, "*");
    }
  }, [exportRequested, channel, streaming]);
  return (
    <div className="rk-widget-frame">
      {streaming || !ready ? (
        <div role="status" className="rk-widget-loading">
          {visual.loadingMessages?.[0] ?? visual.title}
        </div>
      ) : null}
      <iframe
        ref={frame}
        title={visual.title}
        src={WIDGET_VIEWER_PATH}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
        onLoad={() => setLoads((count) => count + 1)}
        style={{ height }}
      />
      {error ? <p role="status">{error}</p> : null}
      {pendingPrompt ? (
        <div>
          <p>{pendingPrompt}</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onPrompt(pendingPrompt);
              setPendingPrompt("");
            }}
          >
            {copy.addToConversation}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function WidgetView({
  visual,
  streaming = false,
}: {
  visual: WidgetVisual;
  streaming?: boolean;
}) {
  const copy = useMarkdownCopy();
  const reference = useContext(InlineVisualReferenceContext);
  const [expanded, setExpanded] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [exportRequested, setExportRequested] = useState(0);
  const appearance = useChatAppearance();
  const sendReference = (text: string) =>
    reference
      ? reference(text)
      : window.dispatchEvent(new CustomEvent(INLINE_VISUAL_REFERENCE_EVENT, { detail: { text } }));
  const filename = visual.title.replace(/[^\p{L}\p{N}_-]/gu, "_") || "visual";
  const download = () => {
    const text =
      visual.format === "svg"
        ? visual.code
        : widgetDocument(
            visual,
            webTokensForAppearance(appearance),
            appearanceColorScheme(appearance),
            "download",
          );
    const url = URL.createObjectURL(
      new Blob([text], { type: visual.format === "svg" ? "image/svg+xml" : "text/html" }),
    );
    save(url, `${filename}.${visual.format}`);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <figure className="rk-inline-visual rk-widget" data-testid="inline-widget">
      <figcaption>{visual.title}</figcaption>
      <WidgetFrame
        visual={visual}
        streaming={streaming}
        onPrompt={sendReference}
        exportRequested={exportRequested}
      />
      {!streaming ? (
        <div className="rk-inline-visual-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => sendReference(inlineVisualMarkdown(visual))}
          >
            {copy.addToConversation}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
            {copy.expandDiagram}
          </Button>
          <Button variant="ghost" size="sm" onClick={download}>
            {copy.downloadFile}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setExportRequested((n) => n + 1)}>
            {copy.downloadImage}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSourceOpen((v) => !v)}
            aria-expanded={sourceOpen}
          >
            {copy.viewSource}
          </Button>
        </div>
      ) : null}
      {sourceOpen ? (
        <div>
          <pre>
            <code>{visual.code}</code>
          </pre>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void navigator.clipboard?.writeText(visual.code)}
          >
            {copy.copyCode}
          </Button>
        </div>
      ) : null}
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-4xl">
          <DialogTitle>{visual.title}</DialogTitle>
          {expanded ? (
            <WidgetFrame visual={visual} streaming={false} onPrompt={sendReference} />
          ) : null}
        </DialogContent>
      </Dialog>
    </figure>
  );
}
