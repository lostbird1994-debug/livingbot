// @vitest-environment jsdom
import type { ConversationUsage } from "@livingbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((s, part, i) => s + (i ? String(values[i - 1]) : "") + part, ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { ComposerUsage, compactTokens } from "./composer-usage";

describe("composer usage", () => {
  it("keeps the footer mounted through loading and refresh failure and shows all reported metrics", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    const total = {
      calls: 1,
      reportedCalls: 1,
      tokens: 97900,
      knownTokens: 97900,
      inputTokens: 97000,
      outputTokens: 900,
      cacheReadTokens: 27160,
      cacheHitRate: 0.28,
      tokensPerSecond: 237.6,
      modelDurationMs: 3788,
    };
    const usage: ConversationUsage = {
      threadId: "thread-fixture",
      total: { ...total, tokens: 1400000, knownTokens: 1400000 },
      latest: {
        ...total,
        runId: "run-fixture",
        status: "completed",
        startedAt: null,
        completedAt: null,
      },
      context: null,
    };
    try {
      act(() => root.render(<ComposerUsage usage={undefined} />));
      const footer = container.firstElementChild;
      expect(footer?.classList.contains("min-h-8")).toBe(true);
      expect(container.textContent).toBe("");
      act(() => root.render(<ComposerUsage usage={usage} />));
      expect(container.firstElementChild).toBe(footer);
      expect(container.textContent).toContain("Latest 97.9K tok");
      expect(container.textContent).toContain("Cache hit 28%");
      expect(container.textContent).toContain("237.6 tok/s");
      expect(container.textContent).toContain("Conversation 1.4M tok");
      act(() => root.render(<ComposerUsage usage={usage} failed />));
      expect(container.firstElementChild).toBe(footer);
      expect(container.textContent).toContain("97.9K tok");
      act(() => root.render(<ComposerUsage usage={undefined} />));
      expect(container.firstElementChild).toBe(footer);
      expect(container.textContent).toBe("");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
  it("formats token counts without claiming context size", () => {
    expect([0, 999, 18200, 29100000].map(compactTokens)).toEqual(["0", "999", "18.2K", "29.1M"]);
  });
  it("labels native request time in details and does not present it as generation speed", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const total = {
      calls: 2, reportedCalls: 2, tokens: 100, knownTokens: 100,
      inputTokens: 80, outputTokens: 20, cacheReadTokens: 0, cacheHitRate: 0,
      tokensPerSecond: null, modelDurationMs: null,
    };
    try {
      await act(async () => root.render(<ComposerUsage usage={{
        threadId: "thread-fixture", total, context: null,
        latest: { ...total, runId: "run-fixture", status: "completed",
          startedAt: null, completedAt: null, modelRequestDurationMs: 1734 },
      }} />));
      await act(async () => container.querySelector("button")!.click());
      expect(document.body.textContent).toContain("模型请求耗时");
      expect(document.body.textContent).toContain("1.7 s");
      expect(container.textContent).not.toContain("tok/s");
      expect(document.body.textContent).not.toContain("Latest model time");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
  it("shows a partial cumulative total and leaves unavailable speed blank", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    const total = {
      calls: 3,
      reportedCalls: 2,
      tokens: null,
      knownTokens: 18200,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheHitRate: null,
      tokensPerSecond: null,
      modelDurationMs: null,
    };
    const usage: ConversationUsage = {
      threadId: "thread-fixture",
      total,
      latest: {
        ...total,
        runId: "run-fixture",
        status: "completed",
        startedAt: null,
        completedAt: null,
      },
      context: null,
    };
    try {
      act(() => root.render(<ComposerUsage usage={usage} />));
      expect(container.textContent).toContain("At least 18.2K tok");
      expect(container.textContent).not.toContain("tok/s");
      expect(container.textContent).not.toContain("0 tok/s");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
  it("does not turn completely missing bridge usage into a zero token lower bound", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    const total = {
      calls: 1,
      reportedCalls: 0,
      tokens: null,
      knownTokens: 0,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheHitRate: null,
      tokensPerSecond: null,
      modelDurationMs: null,
    };
    try {
      act(() =>
        root.render(
          <ComposerUsage
            usage={{
              threadId: "thread-fixture",
              total,
              latest: null,
              context: null,
            }}
          />,
        ),
      );
      expect(container.textContent).toBe("");
      expect(container.textContent).not.toContain("At least 0");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
