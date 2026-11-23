import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function NativePreviewFrame({ source, title = "内容预览", nativeDocument = false, onPrompt }: {
  source: string; title?: string; nativeDocument?: boolean; onPrompt?: (text: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const promptHandler = useRef(onPrompt);
  useEffect(() => { promptHandler.current = onPrompt; }, [onPrompt]);
  const [height, setHeight] = useState(340);
  useLayoutEffect(() => {
    if (!nativeDocument) return;
    setHeight(340);
    let promptPort: MessagePort | undefined;
    function offer(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== "openclaw:widget-prompt-offer") return;
      const port = event.ports[0];
      if (!port) return;
      if (promptPort || !promptHandler.current) { port.close(); return; }
      promptPort = port;
      port.onmessage = (message: MessageEvent) => {
        const text = message.data?.prompt;
        if (message.data?.type !== "openclaw:widget-prompt" || typeof text !== "string" ||
          !text.trim() || text.length > 500_000 || !navigator.userActivation.isActive) return;
        promptHandler.current?.(text);
      };
      port.start();
      port.postMessage({ type: "openclaw:widget-prompt-host-ready" });
    }
    function resize(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== "openclaw:widget-size" ||
        typeof event.data.height !== "number" || !Number.isFinite(event.data.height)) return;
      setHeight(Math.max(48, Math.min(8000, Math.ceil(event.data.height))));
    }
    function theme() {
      const root = document.documentElement;
      const style = getComputedStyle(root);
      const mapping: Record<string, string> = {
        surface: "background", card: "card", elevated: "popover",
        text: "foreground", "text-strong": "foreground", muted: "muted-foreground",
        border: "border", "border-strong": "border", accent: "primary",
        "accent-fill": "primary", "accent-fg": "primary-foreground",
        ok: "success", warn: "warning", danger: "destructive",
        radius: "radius", "font-body": "font-sans", "font-mono": "font-mono",
      };
      frame.current?.contentWindow?.postMessage({
        type: "openclaw:widget-theme", mode: root.dataset.theme === "dark" ? "dark" : "light",
        tokens: Object.fromEntries(Object.entries(mapping).map(([name, token]) => [name, style.getPropertyValue(`--${token}`).trim()])),
      }, "*");
    }
    const element = frame.current;
    element?.addEventListener("load", theme);
    const appearance = new MutationObserver(theme);
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    theme();
    window.addEventListener("message", resize);
    window.addEventListener("message", offer);
    return () => {
      window.removeEventListener("message", resize);
      window.removeEventListener("message", offer);
      promptPort?.close();
      element?.removeEventListener("load", theme);
      appearance.disconnect();
    };
  }, [nativeDocument, source]);
  return <iframe className="w-full border-0" ref={frame} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer"
    style={nativeDocument ? { height, minHeight: 0 } : undefined} srcDoc={
    nativeDocument ? source : `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">${source}`
  } />;
}
