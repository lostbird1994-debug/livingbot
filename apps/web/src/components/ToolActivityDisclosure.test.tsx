// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The macro compiles away in the app build; tests run the source, so expand the
// plural by hand to assert the singular vs plural English forms.
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));

/** The words a reader sees, with each element's text as its own word. */
const visibleText = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

import {
  ActivityTimeline,
  LIVE_TOOL_STEP_WINDOW,
  ReasoningActivity,
  StandaloneToolActivity,
  ToolActivityDisclosure,
  ToolOnlyNarration,
  ToolSteps,
} from "./ToolActivityDisclosure";

function markup(props: {
  live: boolean;
  stepCount: number;
  durationMs?: number;
  steps?: Array<{ label: string; count: number }>;
}) {
  return renderToStaticMarkup(
    <ToolActivityDisclosure
      live={props.live}
      toolCount={props.stepCount}
      durationMs={props.durationMs}
    >
      <ToolSteps steps={props.steps ?? [{ label: "Shell", count: props.stepCount }]} />
    </ToolActivityDisclosure>,
  );
}

function stepsOf(n: number) {
  return Array.from({ length: n }, (_, i) => ({ label: `step-${i}`, count: 1 }));
}

const OPEN_TRIGGER = /aria-expanded="true"/;

function mountCard() {
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (live: boolean, stepCount = 2) =>
    flushSync(() =>
      root.render(
        <ToolActivityDisclosure live={live} toolCount={stepCount}>
          <ToolSteps steps={stepsOf(stepCount)} />
        </ToolActivityDisclosure>,
      ),
    );
  const details = () => container.querySelector("button[aria-expanded]");
  const summary = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]");
  return { render, details, summary, unmount: () => root.unmount() };
}

describe("ToolActivityDisclosure", () => {
  it("leads a finished card with how long the run took", () => {
    const html = markup({ live: false, stepCount: 2, durationMs: 88_000 });
    expect(visibleText(html)).toContain("Completed 1m 28s");
  });

  it("counts the tools when the run recorded no duration", () => {
    expect(visibleText(markup({ live: false, stepCount: 1 }))).toContain("Done 1 tool");
    expect(visibleText(markup({ live: false, stepCount: 3 }))).toContain("Done 3 tools");
    expect(visibleText(markup({ live: false, stepCount: 3 }))).not.toMatch(/Done 3 tools \d/);
  });

  it("shows the live label while working", () => {
    const html = markup({ live: true, stepCount: 2 });
    expect(visibleText(html)).toContain("Working… 2 tools");
    expect(html).toContain('data-live="true"');
  });

  it("starts open while working", () => {
    expect(markup({ live: true, stepCount: 2 })).toMatch(OPEN_TRIGGER);
  });

  it("folds a finished run away so the chat stays readable", () => {
    const html = markup({ live: false, stepCount: 2 });
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Shell ×2");
  });

  it("closes itself when the run finishes", () => {
    const card = mountCard();
    card.render(true);
    expect(card.details()?.getAttribute("aria-expanded")).toBe("true");

    card.render(false);
    expect(card.details()?.getAttribute("aria-expanded")).toBe("false");
    card.unmount();
  });

  it("keeps a manual collapse while more tools arrive in the same run", () => {
    const card = mountCard();
    card.render(true, 2);
    flushSync(() => card.summary()?.click());
    expect(card.details()?.getAttribute("aria-expanded")).toBe("false");

    card.render(true, 3);
    expect(card.details()?.getAttribute("aria-expanded")).toBe("false");
    expect(card.summary()?.textContent).toContain("Working…3 tools");
    card.unmount();
  });
});

describe("ToolSteps", () => {
  it("names what a call acted on beside the verb for its tool", () => {
    const html = renderToStaticMarkup(
      <ToolSteps
        steps={[
          { label: "Read file", count: 1, tool: "read_file", detail: "memory-organization.ts" },
        ]}
      />,
    );
    expect(visibleText(html)).toBe("Read memory-organization.ts");
    expect(html).toContain('title="Read file: memory-organization.ts"');
  });

  it("prefers the intent the tool asked the model for", () => {
    const html = renderToStaticMarkup(
      <ToolSteps
        steps={[
          {
            label: "Exec",
            count: 1,
            tool: "exec",
            detail: "git diff --stat",
            action: "统计本次改动",
          },
        ]}
      />,
    );
    expect(visibleText(html)).toBe("统计本次改动");
    expect(html).toContain('title="Exec: git diff --stat"');
  });

  it("says what a shell command was for, not which program ran", () => {
    const html = renderToStaticMarkup(
      <ToolSteps steps={[{ label: "Exec", count: 1, tool: "exec", detail: "git diff --stat" }]} />,
    );
    expect(visibleText(html)).toBe("Reviewing changes");
    // The command stays reachable on the row itself rather than in the list.
    expect(html).toContain('title="Exec: git diff --stat"');
  });

  it("keeps the command when its intent cannot be named", () => {
    const html = renderToStaticMarkup(
      <ToolSteps steps={[{ label: "Exec", count: 1, tool: "exec", detail: "kubectl get pods" }]} />,
    );
    expect(visibleText(html)).toBe("Ran kubectl get pods");
  });

  it("names a tool that reports no target instead of showing its English name", () => {
    const html = renderToStaticMarkup(
      <ToolSteps steps={[{ label: "Process", count: 2, tool: "process" }]} />,
    );
    expect(visibleText(html)).toBe("Waiting on a command ×2");
  });

  it("falls back to the recorded label when a step has no target", () => {
    const html = renderToStaticMarkup(<ToolSteps steps={[{ label: "Web search", count: 1 }]} />);
    expect(visibleText(html)).toBe("Web search");
  });

  it("lists only the last steps and counts the earlier ones when limited", () => {
    const steps = stepsOf(LIVE_TOOL_STEP_WINDOW + 3);
    const html = renderToStaticMarkup(
      <ToolSteps steps={steps} currentIndex={steps.length - 1} limit={LIVE_TOOL_STEP_WINDOW} />,
    );
    expect(html).toContain("Show 3 earlier steps");
    for (const hidden of ["step-0<", "step-1<", "step-2<"]) expect(html).not.toContain(hidden);
    for (let i = 3; i < steps.length; i++) expect(html).toContain(`step-${i}<`);
    // The running marker stays on the latest step after the window shifts the indexes.
    expect(html.match(/data-running="true"/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`data-running="true"[\\s\\S]*step-${steps.length - 1}<`));
  });

  it("uses the singular for one hidden step", () => {
    const html = renderToStaticMarkup(
      <ToolSteps steps={stepsOf(LIVE_TOOL_STEP_WINDOW + 1)} limit={LIVE_TOOL_STEP_WINDOW} />,
    );
    expect(html).toContain("Show 1 earlier step<");
  });

  it("exposes the full label as the title of a truncated step", () => {
    const label = "Read apps/web/src/components/ToolActivityDisclosure.tsx";
    const html = renderToStaticMarkup(<ToolSteps steps={[{ label, count: 2 }]} />);
    expect(html).toContain(`title="${label}"`);
  });

  it("lists every step when not limited or when the list fits", () => {
    const all = renderToStaticMarkup(<ToolSteps steps={stepsOf(9)} />);
    const fits = renderToStaticMarkup(
      <ToolSteps steps={stepsOf(LIVE_TOOL_STEP_WINDOW)} limit={LIVE_TOOL_STEP_WINDOW} />,
    );
    expect(all).not.toContain("earlier");
    expect(fits).not.toContain("earlier");
    for (let i = 0; i < 9; i++) expect(all).toContain(`step-${i}<`);
  });

  it("shows what the bot wrote before a step above it", () => {
    const html = renderToStaticMarkup(
      <ToolSteps
        steps={[
          { label: "Read calendar", count: 1 },
          { label: "Save event", count: 1, note: "The meeting is with **Anna**." },
        ]}
      />,
    );
    expect(visibleText(html)).toBe("Read calendar The meeting is with Anna . Save event");
    expect(html).toContain("<strong>Anna</strong>");
  });
});

describe("StandaloneToolActivity", () => {
  it("renders as a plain line, not a chat bubble", () => {
    const html = renderToStaticMarkup(
      <StandaloneToolActivity live={false} steps={stepsOf(2)} toolCount={2} durationMs={4000} />,
    );
    expect(html).toContain('data-testid="tool-activity-line"');
    expect(visibleText(html)).toContain("Completed 4s");
    expect(html).not.toContain("bg-muted");
    expect(html).not.toContain("rounded-[20px]");
  });

  it("keeps a windowed list while live, and lists every step once opened", () => {
    const steps = stepsOf(20);
    const live = renderToStaticMarkup(<StandaloneToolActivity live steps={steps} toolCount={20} />);
    expect(live).toMatch(OPEN_TRIGGER);
    expect(live).toContain("Show 8 earlier steps");

    const done = renderToStaticMarkup(
      <StandaloneToolActivity live={false} steps={steps} toolCount={20} />,
    );
    expect(done).toContain('aria-expanded="false"');
    expect(done).not.toContain("earlier");
    for (let i = 0; i < 20; i++) expect(done).toContain(`step-${i}<`);
  });
});

describe("ToolOnlyNarration", () => {
  it("renders a live tools-only message as an open slim line, not a bubble", () => {
    const html = renderToStaticMarkup(
      <ToolOnlyNarration live blocks={[{ kind: "steps", steps: stepsOf(2) }]} />,
    );
    expect(html).toContain('data-testid="tool-activity-line"');
    expect(visibleText(html)).toContain("Working… 2 tools");
    expect(html).toMatch(OPEN_TRIGGER);
    expect(html).not.toContain("bg-muted");
  });

  it("folds consecutive activity into one line once the run is done", () => {
    const html = renderToStaticMarkup(
      <ToolOnlyNarration
        live={false}
        blocks={[
          { kind: "steps", steps: stepsOf(3), durationMs: 12_000 },
          { kind: "steps", steps: stepsOf(1) },
        ]}
      />,
    );
    expect(html.match(/data-testid="activity-timeline"/g)).toHaveLength(1);
    expect(visibleText(html)).toContain("Completed 12s");
    expect(html.match(/aria-expanded="false"/g)?.length).toBeGreaterThanOrEqual(1);
  });
});

describe("execution timeline", () => {
  it("folds consecutive operations behind their actions and targets", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    flushSync(() =>
      root.render(
        <ActivityTimeline
          live
          blocks={[
            {
              kind: "steps",
              steps: [
                { label: "Read", count: 1, tool: "read", detail: "example.ts" },
                { label: "Search", count: 1, tool: "web_search", detail: "reference" },
              ],
            },
            { kind: "text", text: "The source confirms the cause." },
          ]}
        />,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="tool-operation-group"] > button',
    )!;
    expect(button.textContent).toContain("Read example.ts");
    expect(button.textContent).toContain("Searched reference");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    flushSync(() => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll('[data-testid="tool-step"]')).toHaveLength(2);
    root.unmount();
  });

  it("shows prose and named operations in order, with only reasoning folded inside", () => {
    const html = renderToStaticMarkup(
      <ActivityTimeline
        live
        blocks={[
          { kind: "reasoning", text: "Private provider thought" },
          { kind: "text", text: "I will inspect the source." },
          {
            kind: "steps",
            steps: [{ label: "Read", count: 1, tool: "read", detail: "example.ts" }],
          },
          { kind: "progress", text: "The source confirms the cause." },
        ]}
      />,
    );
    expect(html).not.toContain("Done 1 tool");
    expect(html).toContain("Read");
    expect(html.indexOf("I will inspect the source.")).toBeLessThan(html.indexOf("example.ts"));
    expect(html.indexOf("example.ts")).toBeLessThan(html.indexOf("The source confirms the cause."));
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1); // the outer process only
    expect(html).toContain('data-testid="reasoning-content"');
  });

  it("closes a reasoning block when the model moves to an operation and lets the reader reopen it", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (live: boolean) =>
      flushSync(() => root.render(<ReasoningActivity text="Thought" live={live} />));
    render(true);
    const button = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(button().getAttribute("aria-expanded")).toBe("true");
    await act(async () => render(false));
    expect(button().getAttribute("aria-expanded")).toBe("false");
    flushSync(() => button().click());
    expect(button().getAttribute("aria-expanded")).toBe("true");
    const body = container.querySelector('[data-testid="reasoning-content"]')!;
    expect(body.className).toContain("max-h-[200px]");
    expect(body.className).not.toContain("italic");
    await act(async () => root.unmount());
  });

  it("makes earlier operations accessible instead of permanently hiding them", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    flushSync(() => root.render(<ToolSteps steps={stepsOf(20)} limit={12} />));
    expect(container.querySelectorAll('[data-testid="tool-step"]')).toHaveLength(12);
    flushSync(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="tool-rows-hidden"]')!.click(),
    );
    expect(container.querySelectorAll('[data-testid="tool-step"]')).toHaveLength(20);
    expect(container.querySelector('[data-testid="tool-rows-hidden"]')).toBeNull();
    root.unmount();
  });

  it("pauses reasoning follow while the reader scrolls up and resumes near the bottom", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (text: string) => root.render(<ReasoningActivity text={text} live />);
    await act(async () => render("First thought"));
    const body = container.querySelector<HTMLDivElement>('[data-testid="reasoning-content"]')!;
    let height = 500;
    Object.defineProperties(body, {
      scrollHeight: { get: () => height },
      clientHeight: { get: () => 200 },
    });
    await act(async () => render("First thought continued"));
    body.scrollTop = 300;
    body.dispatchEvent(new Event("scroll", { bubbles: true }));
    body.scrollTop = 50;
    body.dispatchEvent(new Event("scroll", { bubbles: true }));
    height = 600;
    await act(async () => render("Another thought"));
    expect(body.scrollTop).toBe(50);
    body.scrollTop = 400;
    body.dispatchEvent(new Event("scroll", { bubbles: true }));
    height = 700;
    await act(async () => render("Latest thought"));
    expect(body.scrollTop).toBe(700);
    await act(async () => root.unmount());
  });
});
