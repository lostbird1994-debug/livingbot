// @vitest-environment jsdom
import { InlineVisualSchema, inlineVisualMarkdown } from "@livingbot/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMarkdown } from "./markdown.web";

const canvas = (text: string) => ({
  height: 120,
  elements: [{ type: "text", x: 24, y: 50, text }],
});
const visual = InlineVisualSchema.parse({
  version: 1,
  kind: "steps",
  title: "Login",
  description: "Follow one request",
  steps: [
    { title: "Send", text: "The browser sends a request.", canvas: canvas("Request") },
    { title: "Reply", text: "The service returns a response.", canvas: canvas("Response") },
  ],
});
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete document.documentElement.dataset.theme;
});
async function render(source: string, streaming = false) {
  await act(async () => root.render(<ChatMarkdown streaming={streaming}>{source}</ChatMarkdown>));
}
describe("inline explanation in a response", () => {
  it("renders responsive comparison cards as text without executing their labels", async () => {
    const comparison = InlineVisualSchema.parse({
      version: 1,
      kind: "comparison",
      title: "Two approaches",
      description: "Compare tradeoffs",
      columns: ["Server session", "Signed token"].map((title) => ({
        title,
        tone: "blue",
        items: [{ label: "State", text: '<img src=x onerror="alert(1)">' }],
      })),
    });
    await render(`Before\n\n${inlineVisualMarkdown(comparison)}\n\nAfter`);
    expect(container.querySelectorAll(".rk-inline-comparison-column")).toHaveLength(2);
    expect(container.querySelector("dl")?.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector("a[download]")).toBeNull();
  });
  it("mixes prose with an interactive visual and exports the selected frame", async () => {
    await render(`Before\n\n${inlineVisualMarkdown(visual)}\n\nAfter`);
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).toContain("Before");
    expect(container.textContent).toContain("After");
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "The service returns a response.",
    );
    const download = container.querySelector('a[download="diagram.svg"]')!;
    expect(decodeURIComponent(download.getAttribute("href")!)).toContain("Response</text>");
    expect(container.querySelector("img")?.alt).toBe("Login: Reply");
  });
  it("waits for the real closing fence during streaming and preserves malformed data as code", async () => {
    const fence = inlineVisualMarkdown(visual);
    await render(fence.slice(0, -4), true);
    expect(container.querySelector('[data-testid="inline-visual"]')).toBeNull();
    await render(`${fence}\n\nContinuing`, true);
    expect(container.querySelector('[data-testid="inline-visual"]')).not.toBeNull();
    await render('```livingbot-visual\n{"html":"<script>"}\n```');
    expect(container.querySelector("pre")).not.toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });
  it("redraws with the selected app palette", async () => {
    await render(inlineVisualMarkdown(visual));
    const before = container.querySelector("img")!.src;
    await act(async () => {
      document.documentElement.dataset.theme = "light";
    });
    expect(container.querySelector("img")!.src).not.toBe(before);
  });
});
