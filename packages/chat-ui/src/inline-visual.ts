import type { InlineVisual, VisualCanvas, VisualPaint } from "@livingbot/contracts";
import type { ColorTokens } from "@livingbot/ui-tokens";
import { visualColorTokens } from "@livingbot/ui-tokens";

export function visualCanvas(visual: InlineVisual, index: number): VisualCanvas {
  if (visual.kind === "comparison" || visual.kind === "widget") throw new Error("This visual has no primitive canvas");
  return visual.kind === "diagram"
    ? visual.canvas
    : (visual.steps[index]?.canvas ?? visual.steps[0]!.canvas);
}

export function visualPaint(
  paint: VisualPaint,
  palette: ColorTokens,
  scheme: "light" | "dark",
): string {
  if (typeof paint !== "string") return paint[scheme];
  if (paint === "none") return "none";
  const colors = visualColorTokens[scheme];
  return paint in colors
    ? colors[paint as keyof typeof colors]
    : palette[paint as keyof ColorTokens];
}

function escapeXml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!,
  );
}

/** Markup is built solely from validated data and trusted semantic tokens on every surface. */
export function inlineVisualSvg(
  canvas: VisualCanvas,
  title: string,
  description: string,
  palette: ColorTokens,
  scheme: "light" | "dark" = "light",
): string {
  const color = (name: VisualPaint | undefined, fallback: VisualPaint) =>
    escapeXml(visualPaint(name ?? fallback, palette, scheme));
  const elements = canvas.elements
    .map((element) => {
      const stroke = color(element.stroke, "border");
      const fill = color(
        element.fill,
        element.type === "text"
          ? "foreground"
          : element.type === "rect" || element.type === "ellipse"
            ? "muted"
            : "none",
      );
      const paint = `fill="${fill}" stroke="${stroke}" stroke-width="1.5"`;
      switch (element.type) {
        case "rect":
          return `<rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" rx="12" ${paint}/>`;
        case "ellipse":
          return `<ellipse cx="${element.cx}" cy="${element.cy}" rx="${element.rx}" ry="${element.ry}" ${paint}/>`;
        case "text":
          return `<text x="${element.x}" y="${element.y}" fill="${fill}" font-size="${element.size ?? 18}" text-anchor="${element.align ?? "start"}" dominant-baseline="middle">${escapeXml(element.text)}</text>`;
        case "line":
          return `<line x1="${element.x}" y1="${element.y}" x2="${element.toX}" y2="${element.toY}" stroke="${color(element.stroke, "mutedForeground")}" stroke-width="1.5"${element.arrow ? ' marker-end="url(#arrow)"' : ""}/>`;
        case "path":
          return `<path d="${escapeXml(element.d)}" ${paint}/>`;
      }
      return "";
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="680" height="${canvas.height}" viewBox="0 0 680 ${canvas.height}" role="img"><title>${escapeXml(title)}</title><desc>${escapeXml(description)}</desc><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1L9 5L1 9" fill="none" stroke="${color("mutedForeground", "foreground")}"/></marker></defs><g font-family="system-ui, sans-serif">${elements}</g></svg>`;
}
