// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  organizers: vi.fn(),
  setSharedOrganizer: vi.fn(),
  update: vi.fn(),
  diary: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({
    memory: {
      organizers: {
        key: () => ["organizers"],
        queryOptions: () => ({
          queryKey: ["organizers"],
          queryFn: api.organizers,
        }),
      },
      organizationDiary: {
        infiniteOptions: (options: Record<string, unknown>) => ({
          ...options,
          queryKey: ["diary"],
          queryFn: api.diary,
        }),
      },
    },
    models: {
      credentials: { queryOptions: () => ({ queryKey: ["credentials"], queryFn: async () => [] }) },
      list: { queryOptions: () => ({ queryKey: ["catalog"], queryFn: async () => [] }) },
    },
  }),
}));
vi.mock("../lib/space-rpc", () => ({
  useSpaceRpc: () => ({
    memory: { setSharedOrganizer: api.setSharedOrganizer },
    routines: { update: api.update },
  }),
}));
vi.mock("../lib/model-catalog", () => ({
  connectedModelOptions: () => [{ key: "chosen-model", label: "Chosen model" }],
  modelOptionKey: (_provider: string, modelId: string) => modelId,
  parseModelOptionKey: () => ({ provider: "example-provider", modelId: "chosen-model" }),
}));
vi.mock("./ActivityList", () => ({ statusLabel: (value: string) => value }));
vi.mock("@livingbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button type="button" {...props} />
  ),
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  SectionHeading: (props: ComponentProps<"h3">) => <h3 {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  Spinner: (props: ComponentProps<"span">) => <span {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (next: boolean) => void;
    id: string;
  }) => (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    />
  ),
}));

import { MemoryOrganizationSettings } from "./MemoryOrganizationSettings";

const entry = (id: string) => ({
  botName: `Bot ${id}`,
  botModelId: "bot-model",
  shared: id === "a",
  canOrganize: true,
  routine: {
    id,
    active: true,
    modelProvider: null,
    modelId: null,
    prompt: "Actual organizer instructions",
    crons: ["0 18 * * *"],
    timezone: "UTC",
  },
});
afterEach(() => vi.clearAllMocks());
async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.organizers.mockResolvedValue({ sharedRoutineId: "a", routines: [entry("a"), entry("b")] });
  api.setSharedOrganizer.mockResolvedValue({ ok: true });
  api.update.mockResolvedValue({});
  api.diary.mockResolvedValue({
    nextCursor: null,
    runs: [
      {
        id: "run",
        createdAt: "2026-01-01T00:00:00Z",
        status: "completed",
        modelId: "chosen-model",
        unchanged: false,
        error: null,
        changes: [
          {
            path: "user:USER.md",
            status: "applied",
            sourceRevision: 2,
            revision: 3,
            archive: "user:memory/archive/source.v2.md",
            savedCharacters: 900,
          },
        ],
      },
    ],
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryOrganizationSettings />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return {
    container,
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
    },
  };
}
it("shows actual instructions and saves a separate organizer model through the routine API", async () => {
  const view = await mount();
  try {
    expect(view.container.querySelector("textarea")?.value).toBe("Actual organizer instructions");
    expect(view.container.querySelector("textarea")?.readOnly).toBe(true);
    const selects = view.container.querySelectorAll("select");
    await act(async () => {
      selects[2]!.value = "chosen-model";
      selects[2]!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const save = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    )!;
    await act(async () => save.click());
    expect(api.update).toHaveBeenCalledWith({
      routineId: "a",
      active: true,
      modelProvider: "example-provider",
      modelId: "chosen-model",
    });
  } finally {
    await view.close();
  }
});
it("assigns the visible shared owner and renders the durable organization diary", async () => {
  const view = await mount();
  try {
    const owner = view.container.querySelector("select")!;
    await act(async () => {
      owner.value = "b";
      owner.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(api.setSharedOrganizer).toHaveBeenCalledWith({ routineId: "b" });
    const diary = [...view.container.querySelectorAll("details")].find(
      (element) => element.querySelector("summary")?.textContent === "Organization diary",
    )!;
    await act(async () => {
      diary.open = true;
      diary.dispatchEvent(new Event("toggle"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(view.container.textContent).toContain("user:USER.md");
    expect(view.container.textContent).toContain("v2 → v3");
    expect(view.container.textContent).toContain("user:memory/archive/source.v2.md");
  } finally {
    await view.close();
  }
});
