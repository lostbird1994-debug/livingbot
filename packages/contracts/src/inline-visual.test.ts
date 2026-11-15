import { describe, expect, it } from "vitest";
import { inlineVisualMarkdown, parseInlineVisual } from "./inline-visual.js";

const diagram = {
  version: 1,
  kind: "diagram",
  title: "A → B",
  description: "Two roles exchange a request.",
  canvas: { height: 160, elements: [{ type: "text", x: 40, y: 60, text: "Hello ``` <script>" }] },
};

describe("inline visual wire format", () => {
  it("accepts theme-aware custom colors but rejects CSS and incomplete theme pairs", () => {
    const withPaint = (fill: unknown) => ({
      ...diagram,
      canvas: {
        height: 160,
        elements: [{ type: "rect", x: 24, y: 24, width: 100, height: 60, fill }],
      },
    });
    expect(
      parseInlineVisual(JSON.stringify(withPaint({ light: "#123456", dark: "#FEDCBA" }))),
    ).toBeDefined();
    expect(parseInlineVisual(JSON.stringify(withPaint("blueFill")))).toBeDefined();
    for (const paint of [
      { light: "#123456" },
      { light: "url(https://example.test)", dark: "#123456" },
      { light: '#123456" onload="alert(1)', dark: "#123456" },
      "red;filter:url(x)",
    ]) {
      expect(parseInlineVisual(JSON.stringify(withPaint(paint)))).toBeUndefined();
    }
  });
  it("round trips labels without allowing them to close their Markdown fence", () => {
    const visual = parseInlineVisual(JSON.stringify(diagram))!;
    const markdown = inlineVisualMarkdown(visual);
    expect(markdown.match(/```/g)).toHaveLength(2);
    expect(parseInlineVisual(markdown.split("\n")[1]!)).toEqual(visual);
  });

  it.each([
    { ...diagram, version: 2 },
    { ...diagram, html: "<iframe src='https://example.test'>" },
    {
      ...diagram,
      canvas: { height: 160, elements: [{ type: "image", src: "https://example.test" }] },
    },
    {
      ...diagram,
      canvas: {
        height: 160,
        elements: [
          { type: "rect", x: 0, y: 0, width: 50, height: 50, onclick: "fetch('/private')" },
        ],
      },
    },
    {
      ...diagram,
      canvas: { height: 160, elements: [{ type: "path", d: 'M0 0" onload="alert(1)' }] },
    },
    {
      ...diagram,
      canvas: {
        height: 160,
        elements: [{ type: "text", x: 0, y: 0, text: "Hi", fill: "url(https://example.test)" }],
      },
    },
    { ...diagram, canvas: { height: 50_000, elements: diagram.canvas.elements } },
    { ...diagram, canvas: { height: 160, elements: Array(81).fill(diagram.canvas.elements[0]) } },
    { ...diagram, kind: "steps", canvas: undefined, steps: [] },
  ])("rejects executable content, unknown fields and unbounded documents", (input) => {
    expect(parseInlineVisual(JSON.stringify(input))).toBeUndefined();
  });

  it("bounds parsing before JSON validation", () => {
    expect(parseInlineVisual(" ".repeat(96_001))).toBeUndefined();
    expect(parseInlineVisual('{"kind":')).toBeUndefined();
  });
});

import { parseStreamingWidget, parseWidgetFence, WidgetVisualSchema } from "./inline-visual.js";

describe("raw widget contracts", () => {
  it("preserves executable local controls without exposing document contexts", () => {
    const code = '<button onclick="this.textContent=2">1</button><script>let n=1</script>';
    const result = parseWidgetFence(JSON.stringify({ title: "Counter", widget_code: code }));
    expect(result?.code).toBe(code);
    expect(parseInlineVisual(inlineVisualMarkdown(result!).split("\n")[1]!)).toEqual(result);
    for (const unsafe of [
      '<meta http-equiv="refresh" content="0;url=https://example.test">',
      '<iframe src="about:blank"></iframe>',
      "<form></form>",
    ]) {
      expect(WidgetVisualSchema.safeParse({ ...result, code: unsafe }).success).toBe(false);
    }
  });
  it("decodes unfinished strings for display only and validates complete code separately", () => {
    const partial = '{"title":"Steps","widget_code":"<div>\\u4F60\\n';
    expect(parseStreamingWidget(partial)?.code).toBe("<div>你\n");
    expect(parseWidgetFence(partial)).toBeUndefined();
    expect(parseStreamingWidget("x".repeat(96_001))).toBeUndefined();
    expect(
      parseWidgetFence(
        JSON.stringify({
          title: "SVG",
          widget_code: '<svg viewBox="0 0 680 200"><circle cx="30" cy="30" r="20"/></svg>',
        }),
      )?.format,
    ).toBe("svg");
  });
});
