import { parseInlineVisual } from "@livingbot/contracts";
import { darkTokens, lightTokens } from "@livingbot/ui-tokens";
import { describe, expect, it } from "vitest";
import { inlineVisualSvg, visualCanvas, visualPaint } from "./inline-visual";

describe("trusted visual markup", () => {
  it("uses the selected appearance for both named ramps and custom RGB pairs", () => {
    expect(visualPaint({ light: "#123456", dark: "#FEDCBA" }, lightTokens, "light")).toBe(
      "#123456",
    );
    expect(visualPaint({ light: "#123456", dark: "#FEDCBA" }, darkTokens, "dark")).toBe("#FEDCBA");
    expect(visualPaint("blueFill", lightTokens, "light")).not.toBe(
      visualPaint("blueFill", darkTokens, "dark"),
    );
  });
  it("escapes text as text and resolves paint exclusively from semantic tokens", () => {
    const visual = parseInlineVisual(
      JSON.stringify({
        version: 1,
        kind: "diagram",
        title: "<Title>",
        description: "A & B",
        canvas: {
          height: 100,
          elements: [
            { type: "text", x: 24, y: 40, text: '<script>alert("x")</script>', fill: "success" },
            { type: "line", x: 24, y: 60, toX: 200, toY: 60, arrow: true },
          ],
        },
      }),
    )!;
    const canvas = visualCanvas(visual, 0);
    const svg = inlineVisualSvg(canvas, visual.title, visual.description, darkTokens);
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain("<script>");
    expect(svg).toContain(`fill="${darkTokens.success}"`);
    expect(svg).toContain("<desc>A &amp; B</desc>");
    expect(svg).toContain('marker-end="url(#arrow)"');
    const light = inlineVisualSvg(canvas, visual.title, visual.description, lightTokens);
    expect(light).toContain(`fill="${lightTokens.success}"`);
    expect(light).not.toEqual(svg);
  });
});
