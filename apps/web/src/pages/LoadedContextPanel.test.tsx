// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${index ? values[index - 1] : ""}${part}`, ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({
    memory: {
      loadedContext: {
        queryOptions: ({ input }: { input: { botId: string } }) => ({
          queryKey: ["loaded", input.botId],
          queryFn: () => api.preview(input),
        }),
      },
    },
  }),
}));
vi.mock("./KnowledgeSection", () => ({
  KnowledgeSection: () => <div>Memory editor</div>,
  LoadedMemoryEditor: () => <button type="button">Edit full document</button>,
}));
vi.mock("./BotRoleCardEditor", () => ({ BotRoleCardEditor: () => <div>Role editor</div> }));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  SectionHeading: ({
    variant: _variant,
    ...props
  }: ComponentProps<"h3"> & { variant?: string }) => <h3 {...props} />,
  Spinner: (props: ComponentProps<"span">) => <span {...props} />,
}));

import { LoadedContextPanel } from "./LoadedContextPanel";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("shows actual capped excerpts and distinguishes the directory from automatically loaded text", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.preview.mockResolvedValue({
    identity: "Example\nActual instructions",
    scratchpad: "An unfinished task",
    budgets: { body: 60000, shared: 10000, document: 20000, index: 4000 },
    memory: {
      body: "HEAD [omitted] TAIL",
      index: "bot:memory/workflow.md — not in context",
      context: "HEAD [omitted] TAIL\nbot:memory/workflow.md — not in context",
      documents: [
        {
          scope: "bot",
          path: "MEMORY.md",
          revision: 3,
          totalChars: 100,
          shownChars: 8,
          excerpt: "HEAD [omitted] TAIL",
        },
        {
          scope: "user",
          path: "USER.md",
          revision: 1,
          totalChars: 6,
          shownChars: 6,
          excerpt: "Shared",
        },
        {
          scope: "bot",
          path: "memory/workflow.md",
          revision: 2,
          totalChars: 500,
          shownChars: 0,
          excerpt: "",
        },
      ],
    },
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <LoadedContextPanel botId="bot" />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(api.preview).toHaveBeenCalledWith({ botId: "bot" });
    expect(container.textContent).toContain("Actual instructions");
    expect(container.textContent).toContain("MEMORY.md");
    expect(container.textContent).toContain("Partial");
    expect(container.textContent).toContain("HEAD [omitted] TAIL");
    expect(container.textContent).toContain("Shared");
    expect(container.textContent).toContain("An unfinished task");
    expect(container.textContent).toContain("not loaded in full");
    const summaries = [...container.querySelectorAll("summary")].map((row) => row.textContent);
    expect(summaries.some((row) => row?.includes("memory/workflow.md"))).toBe(false);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Refresh loaded context"]')!
        .click();
    });
    expect(api.preview).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});
