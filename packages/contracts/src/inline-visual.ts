import { z } from "zod";

export const INLINE_VISUAL_FENCE = "livingbot-visual";
export const INLINE_VISUAL_REFERENCE_EVENT = "livingbot:visual-reference";
export const INLINE_VISUAL_MAX_CHARS = 96_000;

export const WidgetVisualSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("widget"),
    title: z.string().trim().min(1).max(100),
    description: z.string().max(500),
    format: z.enum(["svg", "html"]),
    code: z.string().trim().min(1).max(64_000),
    loadingMessages: z.array(z.string().trim().min(1).max(100)).min(1).max(4).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const error = validateWidgetCode(value.code, value.format);
    if (error) ctx.addIssue({ code: "custom", path: ["code"], message: error });
  });
export type WidgetVisual = z.infer<typeof WidgetVisualSchema>;

/** Input guidance checks; the browser sandbox, rather than a text filter, is the execution boundary. */
export function validateWidgetCode(code: string, format: "svg" | "html"): string | undefined {
  if (/<(?:!doctype|html|head|body|base|meta|iframe|object|embed|form)\b/i.test(code))
    return "Provide a fragment without document wrappers, nested browsing contexts or forms.";
  if (/\b(?:localStorage|sessionStorage|document\.cookie)\b/.test(code))
    return "Widgets have no persistent browser storage or cookies. Keep state in memory.";
  if (/position\s*:\s*fixed\b/i.test(code))
    return "Use in-flow layout instead of fixed positioning.";
  if (
    format === "svg" &&
    (!/^<svg\b/i.test(code.trim()) ||
      (code.match(/<svg\b/gi) ?? []).length !== 1 ||
      !/viewBox\s*=\s*["']0\s+0\s+680\s+[\d.]+["']/i.test(code))
  )
    return "Provide one SVG with viewBox='0 0 680 H'.";
  return undefined;
}
const coordinate = z.number().finite().min(0).max(1_200);
const semanticInk = z.enum([
  "foreground",
  "mutedForeground",
  "card",
  "muted",
  "border",
  "success",
  "warning",
  "destructive",
  "none",
  "blueFill",
  "blueStroke",
  "blueText",
  "tealFill",
  "tealStroke",
  "tealText",
  "purpleFill",
  "purpleStroke",
  "purpleText",
  "coralFill",
  "coralStroke",
  "coralText",
  "amberFill",
  "amberStroke",
  "amberText",
  "roseFill",
  "roseStroke",
  "roseText",
]);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const VisualPaintSchema = z.union([
  semanticInk,
  z.object({ light: hexColor, dark: hexColor }).strict(),
]);
export type VisualPaint = z.infer<typeof VisualPaintSchema>;
const ink = VisualPaintSchema;
const paint = { fill: ink.optional(), stroke: ink.optional() };

/** Colors are data too: only named paints or explicit light/dark RGB pairs, never CSS. */
export const VisualElementSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("rect"),
      x: coordinate,
      y: coordinate,
      width: coordinate,
      height: coordinate,
      ...paint,
    })
    .strict(),
  z
    .object({
      type: z.literal("ellipse"),
      cx: coordinate,
      cy: coordinate,
      rx: coordinate,
      ry: coordinate,
      ...paint,
    })
    .strict(),
  z
    .object({
      type: z.literal("text"),
      x: coordinate,
      y: coordinate,
      text: z.string().min(1).max(100),
      size: z.number().int().min(14).max(28).optional(),
      align: z.enum(["start", "middle", "end"]).optional(),
      ...paint,
    })
    .strict(),
  z
    .object({
      type: z.literal("line"),
      x: coordinate,
      y: coordinate,
      toX: coordinate,
      toY: coordinate,
      arrow: z.boolean().optional(),
      ...paint,
    })
    .strict(),
  z
    .object({
      type: z.literal("path"),
      d: z
        .string()
        .min(1)
        .max(4_000)
        .regex(/^[MmLlHhVvCcSsQqTtAaZz0-9.,+\-\s]+$/),
      ...paint,
    })
    .strict(),
]);

export const VisualCanvasSchema = z
  .object({
    height: z.number().int().min(80).max(1_200),
    elements: z.array(VisualElementSchema).min(1).max(80),
  })
  .strict();

export const InlineVisualSchema = z.discriminatedUnion("kind", [
  WidgetVisualSchema,
  z
    .object({
      version: z.literal(1),
      kind: z.literal("comparison"),
      title: z.string().trim().min(1).max(100),
      description: z.string().trim().min(1).max(500),
      columns: z
        .array(
          z
            .object({
              title: z.string().trim().min(1).max(80),
              subtitle: z.string().max(160).optional(),
              tone: z.enum(["blue", "teal", "purple", "coral", "amber", "rose"]).optional(),
              items: z
                .array(
                  z
                    .object({
                      label: z.string().trim().min(1).max(80),
                      text: z.string().trim().min(1).max(300),
                    })
                    .strict(),
                )
                .min(1)
                .max(8),
            })
            .strict(),
        )
        .min(2)
        .max(4),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("diagram"),
      title: z.string().trim().min(1).max(100),
      description: z.string().trim().min(1).max(500),
      canvas: VisualCanvasSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("steps"),
      title: z.string().trim().min(1).max(100),
      description: z.string().trim().min(1).max(500),
      steps: z
        .array(
          z
            .object({
              title: z.string().trim().min(1).max(80),
              text: z.string().max(600),
              canvas: VisualCanvasSchema,
            })
            .strict(),
        )
        .min(2)
        .max(6),
    })
    .strict(),
]);

export type InlineVisual = z.infer<typeof InlineVisualSchema>;
export type VisualCanvas = z.infer<typeof VisualCanvasSchema>;

export function parseInlineVisual(source: string): InlineVisual | undefined {
  if (source.length > INLINE_VISUAL_MAX_CHARS) return undefined;
  try {
    const parsed = InlineVisualSchema.safeParse(JSON.parse(source));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function inlineVisualMarkdown(visual: InlineVisual): string {
  // Escape fence characters in labels so user content cannot close the enclosing fence.
  const json = JSON.stringify(visual).replace(/`/g, "\\u0060");
  return `\`\`\`${INLINE_VISUAL_FENCE}\n${json}\n\`\`\``;
}

export const INLINE_WIDGET_FENCES = ["show_widget", "widget", "livingbot-widget"] as const;

export function parseWidgetFence(source: string): WidgetVisual | undefined {
  if (source.length > INLINE_VISUAL_MAX_CHARS) return;
  try {
    const args = JSON.parse(source);
    if (typeof args?.widget_code !== "string") return;
    const value = WidgetVisualSchema.safeParse({
      version: 1,
      kind: "widget",
      title: args.title,
      description: args.title,
      format: args.widget_code.trim().startsWith("<svg") ? "svg" : "html",
      code: args.widget_code,
    });
    return value.success ? value.data : undefined;
  } catch {
    return;
  }
}

/** Read only top-level JSON string fields. An unfinished code string is a display-only preview. */
export function parseStreamingWidget(source: string): WidgetVisual | undefined {
  if (source.length > INLINE_VISUAL_MAX_CHARS) return;
  const values: Record<string, string> = Object.create(null);
  const stringAt = (start: number) => {
    let value = "";
    for (let i = start + 1; i < source.length; i++) {
      const c = source[i]!;
      if (c === '"') return { value, end: i + 1, complete: true };
      if (c !== "\\") {
        value += c;
        continue;
      }
      const escapedCharacter = source[++i];
      if (escapedCharacter === undefined) break;
      if (escapedCharacter === "u") {
        const hex = source.slice(i + 1, i + 5);
        if (!/^[0-9a-f]{4}$/i.test(hex)) break;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
      } else {
        const decoded: Record<string, string> = {
          n: "\n",
          r: "\r",
          t: "\t",
          b: "\b",
          f: "\f",
          '"': '"',
          "\\": "\\",
          "/": "/",
        };
        if (!(escapedCharacter in decoded)) break;
        value += decoded[escapedCharacter];
      }
    }
    return { value, end: source.length, complete: false };
  };
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    else if (source[i] === '"') {
      const key = stringAt(i);
      i = key.end - 1;
      if (depth !== 1 || !key.complete) continue;
      let j = key.end;
      while (/\s/.test(source[j] ?? "x")) j++;
      if (source[j++] !== ":") continue;
      while (/\s/.test(source[j] ?? "x")) j++;
      if (source[j] !== '"') continue;
      const value = stringAt(j);
      values[key.value] = value.value;
      i = value.end - 1;
    }
  }
  const code = values.code ?? values.widget_code;
  const format = values.format ?? (code?.trim().startsWith("<svg") ? "svg" : "html");
  if (
    (values.kind !== "widget" && !values.widget_code) ||
    !code ||
    code.length > 64_000 ||
    !values.title ||
    values.title.length > 100 ||
    !["svg", "html"].includes(format)
  )
    return;
  return {
    version: 1,
    kind: "widget",
    title: values.title,
    description: values.description ?? values.title,
    format: format as "svg" | "html",
    code,
  };
}
