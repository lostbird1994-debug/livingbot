import type { WidgetVisual } from "@livingbot/contracts";
import type { ColorTokens } from "@livingbot/ui-tokens";
import { visualColorTokens } from "@livingbot/ui-tokens";

export const WIDGET_CDNS = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://esm.sh",
] as const;
export const WIDGET_CSP = `default-src 'none'; script-src 'unsafe-inline' ${WIDGET_CDNS.join(" ")}; style-src 'unsafe-inline' ${WIDGET_CDNS.join(" ")}; connect-src ${WIDGET_CDNS.join(" ")}; img-src data: blob:; font-src data: ${WIDGET_CDNS.join(" ")}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
const attr = (s: string) =>
  s.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!);

/** Runs only inside the innermost opaque-origin frame. No LivingBot API is exposed here. */
function widgetBootstrap(channel: string, complete: boolean) {
  const send = parent.postMessage.bind(parent);
  document.currentScript?.remove();
  const post = (type: string, payload: Record<string, unknown> = {}) =>
    send({ channel, type, ...payload }, "*");
  let activatedUntil = 0;
  const activate = (event: Event) => {
    if (event.isTrusted) activatedUntil = Date.now() + 1000;
  };
  document.addEventListener("click", activate, true);
  document.addEventListener("keydown", activate, true);
  Object.defineProperty(window, "sendPrompt", {
    value: (text: unknown) => {
      if (
        Date.now() <= activatedUntil &&
        typeof text === "string" &&
        text.trim() &&
        text.length <= 2000
      )
        post("prompt", { text });
    },
  });
  document.addEventListener(
    "click",
    (event) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!link) return;
      const href = link.getAttribute("href") ?? "";
      event.preventDefault();
      if (/^#[\w-]+$/.test(href)) document.getElementById(href.slice(1))?.scrollIntoView();
    },
    true,
  );
  document.addEventListener("submit", (event) => event.preventDefault(), true);
  addEventListener("error", (event) =>
    post("error", { message: event.message || "A widget resource could not load." }),
  );
  addEventListener("unhandledrejection", () =>
    post("error", { message: "The widget could not finish rendering." }),
  );
  let lastHeight = 0;
  const measure = () => {
    const height = Math.min(1600, Math.max(80, Math.ceil(document.body?.scrollHeight ?? 320)));
    if (height !== lastHeight) {
      lastHeight = height;
      post("resize", { height });
    }
  };
  const ready = () => {
    new ResizeObserver(measure).observe(document.body);
    measure();
    post("ready");
  };
  if (document.readyState === "loading")
    addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
  addEventListener("message", (event) => {
    if (
      event.source !== parent ||
      event.data?.channel !== channel ||
      event.data?.type !== "export" ||
      !complete
    )
      return;
    try {
      const sourceCanvas = document.querySelector("canvas");
      if (sourceCanvas) {
        post("image", { data: sourceCanvas.toDataURL("image/png") });
        return;
      }
      const original = document.querySelector("svg") ?? document.body;
      const clone = original.cloneNode(true) as Element;
      const originals = [original, ...original.querySelectorAll("*")];
      const clones = [clone, ...clone.querySelectorAll("*")];
      const properties = [
        "color",
        "background-color",
        "fill",
        "stroke",
        "stroke-width",
        "font-family",
        "font-size",
        "font-weight",
        "text-anchor",
        "dominant-baseline",
        "display",
        "padding",
        "margin",
        "border",
        "border-radius",
        "gap",
        "grid-template-columns",
        "line-height",
        "width",
        "height",
      ];
      originals.forEach((node, i) => {
        const style = getComputedStyle(node);
        clones[i]?.setAttribute(
          "style",
          properties.map((p) => `${p}:${style.getPropertyValue(p)}`).join(";"),
        );
      });
      clone.querySelectorAll("script,iframe,object,embed").forEach((node) => {
        node.remove();
      });
      const width = Math.min(1600, Math.ceil(original.getBoundingClientRect().width));
      const height = Math.min(1600, Math.ceil(original.getBoundingClientRect().height));
      const markup = new XMLSerializer().serializeToString(clone);
      const svg =
        original.tagName.toLowerCase() === "svg"
          ? markup
          : `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${markup}</div></foreignObject></svg>`;
      const image = new Image();
      image.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = width * 2;
          canvas.height = height * 2;
          const context = canvas.getContext("2d")!;
          context.scale(2, 2);
          context.drawImage(image, 0, 0, width, height);
          post("image", { data: canvas.toDataURL("image/png") });
        } catch {
          post("error", { message: "Image export is unavailable; download the source instead." });
        }
      };
      image.onerror = () =>
        post("error", { message: "Image export is unavailable; download the source instead." });
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    } catch {
      post("error", { message: "Image export is unavailable; download the source instead." });
    }
  });
}

export function widgetDocument(
  visual: WidgetVisual,
  palette: ColorTokens,
  scheme: "light" | "dark",
  channel: string,
  complete = true,
): string {
  const vars: Record<string, string> = {
    "color-background-primary": palette.background,
    "color-background-secondary": palette.card,
    "color-background-tertiary": palette.muted,
    "color-text-primary": palette.foreground,
    "color-text-secondary": palette.mutedForeground,
    "color-text-tertiary": palette.faintForeground,
    "color-border-primary": palette.mutedForeground,
    "color-border-secondary": palette.border,
    "color-border-tertiary": palette.border,
    "color-text-info": palette.link,
    "color-text-danger": palette.destructive,
    "color-text-success": palette.success,
    "color-text-warning": palette.warning,
    "font-sans": "system-ui,sans-serif",
    "font-serif": "Georgia,serif",
    "font-mono": "ui-monospace,monospace",
    "border-radius-md": "8px",
    "border-radius-lg": "12px",
    "border-radius-xl": "16px",
    ...visualColorTokens[scheme],
  };
  for (const [name, tone] of [
    ["info", "blue"],
    ["success", "teal"],
    ["warning", "amber"],
    ["danger", "rose"],
  ] as const) {
    vars[`color-background-${name}`] = visualColorTokens[scheme][`${tone}Fill`];
    vars[`color-border-${name}`] = visualColorTokens[scheme][`${tone}Stroke`];
  }
  const css = `:root{color-scheme:${scheme};${Object.entries(vars)
    .map(([k, v]) => `--${k}:${v}`)
    .join(
      ";",
    )}}*{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--color-text-primary);font:14px/1.6 var(--font-sans)}body{padding:8px}svg{max-width:100%;height:auto}button,input,select,textarea{font:inherit;color:inherit;border:1px solid var(--color-border-secondary);border-radius:8px;background:var(--color-background-primary);padding:.4rem .7rem}button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--color-text-info);outline-offset:2px}.t,.th{font:14px var(--font-sans);fill:var(--color-text-primary)}.th{font-weight:500}.ts{font:12px var(--font-sans);fill:var(--color-text-secondary)}.box{fill:var(--color-background-secondary);stroke:var(--color-border-tertiary)}.arr{fill:none;stroke:var(--color-text-secondary);stroke-width:1.5}.leader{fill:none;stroke:var(--color-border-secondary);stroke-dasharray:4 4}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}`;
  // Scripts and event attributes do not run at all in streaming frames (sandbox has no allow-scripts).
  const bootstrap = `(${widgetBootstrap.toString()})(${JSON.stringify(channel)},${complete});`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${attr(WIDGET_CSP)}"><style>${css}</style><script>${bootstrap}</script>${visual.code}`;
}

/** Trusted relay used by web/Electron and the native WebView; untrusted code runs in the nested frame. */
export function widgetShellDocument(): string {
  const shell = () => {
    const frame = document.getElementById("widget") as HTMLIFrameElement;
    let channel: string | undefined;
    const render = (data: { channel: string; complete: boolean; document: string }) => {
      if (
        typeof data.channel !== "string" ||
        typeof data.document !== "string" ||
        data.document.length > 160_000
      )
        return;
      channel = data.channel;
      frame.sandbox.value = data.complete ? "allow-scripts" : "";
      frame.srcdoc = data.document;
    };
    Object.defineProperty(window, "renderLivingBotWidget", { value: render });
    addEventListener("message", (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (
        event.source === parent &&
        parent !== window &&
        data.type === "render" &&
        typeof data.document === "string" &&
        data.document.length <= 160_000 &&
        typeof data.channel === "string"
      ) {
        render(data);
      } else if (event.source === frame.contentWindow && data.channel === channel) {
        if (data.type === "resize" && Number.isFinite(data.height))
          frame.style.height = `${Math.max(80, Math.min(1600, data.height))}px`;
        parent.postMessage(data, "*");
        const native = (
          window as unknown as { ReactNativeWebView?: { postMessage(data: string): void } }
        ).ReactNativeWebView;
        native?.postMessage(JSON.stringify(data));
      } else if (event.source === parent && data.channel === channel && data.type === "export")
        frame.contentWindow?.postMessage(data, "*");
    });
    // Native posts render instructions to this isolated shell through its trusted outer document.
  };
  const policy = WIDGET_CSP.replace("frame-src 'none'", "frame-src about:");
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${attr(policy)}"><style>html,body{margin:0;background:transparent}iframe{display:block;width:100%;height:320px;border:0;background:transparent}</style><iframe id="widget" title="Visual" sandbox="allow-scripts" referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"></iframe><script>(${shell.toString()})();</script>`;
}
