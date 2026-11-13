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
  it("formats token counts without claiming context size", () => {
    expect([0, 999, 18200, 29100000].map(compactTokens)).toEqual(["0", "999", "18.2K", "29.1M"]);
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
      expect(container.textContent).toContain("— tok/s");
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
      expect(container.textContent).toContain("Not reported");
      expect(container.textContent).not.toContain("At least 0");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
