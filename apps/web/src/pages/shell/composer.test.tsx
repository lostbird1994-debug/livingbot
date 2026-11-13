// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentSkillCatalogEntry, ThreadMessage } from "@livingbot/contracts";
import type { ComposerMention } from "@livingbot/core";
import { MODEL_REQUIRED_SEND_ERROR, resolveComposerSendPlan } from "@livingbot/core";
import type { ComponentProps, ReactNode } from "react";
import { act, createRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

vi.mock("../../lib/query", () => ({ useSpaceQueries: () => ({
  capabilities: { list: { queryOptions: () => ({ queryKey: ["test-capabilities"], queryFn: async () => [], initialData: [], enabled: false }) } },
  agentSkills: { list: { queryOptions: () => ({ queryKey: ["test-skills"], queryFn: async () => [], initialData: [], enabled: false }) } },
}) }));

import { dictation } from "../../lib/dictation";
import { Composer } from "./composer";

let root: Root | null = null;
let queryClient: QueryClient;
let container: HTMLDivElement | null = null;
let composerProps: ComponentProps<typeof Composer>;

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  i18n.load("en", {});
  i18n.activate("en");
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  localStorage.clear();
});

const bob: ComposerMention = { kind: "bot", id: "bot-2", name: "Bob" };
const summarize: AgentSkillCatalogEntry = {
  id: "skill-1",
  name: "summarize",
  description: "Summarize a document",
  source: "user",
  readOnly: false,
  onDemand: false,
};

function renderComposer(
  onSend: ComponentProps<typeof Composer>["onSend"],
  overrides: Partial<ComponentProps<typeof Composer>> = {},
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Reduced motion skips the chip-row resize animation, which jsdom cannot run.
  window.matchMedia ??= () =>
    ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  composerProps = {
    artifactTarget: { botId: "bot-1" },
    activeName: "Ada",
    running: false,
    pendingAttachments: [],
    attachmentNotice: null,
    sendError: null,
    onOpenModels: () => {},
    onOpenConnections: () => {},
    runError: null,
    runErrorId: null,
    onRunErrorPresented: () => {},
    onDismissError: () => {},
    sending: false,
    fileInputRef: createRef(),
    onAttachmentPick: () => true,
    onRemoveAttachment: () => {},
    onSend,
    onStop: async () => {},
    draftKey: "bot:bot-1",
    enterToSend: true,
    mentionTargets: [bob],
    agentSkills: [summarize],
    ...overrides,
  };
  rerenderComposer({});
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("composer textarea not found");
  return textarea;
}

function rerenderComposer(overrides: Partial<ComponentProps<typeof Composer>>) {
  composerProps = { ...composerProps, ...overrides };
  act(() => root?.render(<QueryClientProvider client={queryClient}><Composer {...composerProps} /></QueryClientProvider>));
}

it("shows a readable run error with raw details, while preserving send errors", () => {
  const runError = '429: {"message":"Too many requests","metadata":{"provider":"OpenRouter"}}';
  renderComposer(async () => true, { runError, runErrorId: "failed-run" });
  const error = container?.querySelector('[data-testid="composer-error"]');
  expect(error?.textContent).toContain(
    "Your OpenRouter is rate limiting requests. Try again shortly.",
  );
  const details = error?.querySelector("details");
  expect(details?.open).toBe(false);
  expect(details?.querySelector("summary")?.textContent).toBe("Details");
  act(() => details?.querySelector("summary")?.click());
  expect(details?.open).toBe(true);
  expect(details?.querySelector("pre")?.textContent).toBe(runError);

  rerenderComposer({ sendError: "Could not send the message." });
  expect(error?.textContent).toBe("Could not send the message.");
  expect(error?.querySelector("details")).toBeNull();
});

it.each([
  ['402: {"message":"You have no credits remaining."}', "Choose a model", "models"],
  [
    '403: {"type":"FreeTierError","message":"This free tier can only be used from within its own app."}',
    "Choose a model",
    "models",
  ],
  ['404: {"message":"Model example-model does not exist"}', "Choose a model", "models"],
  ['401: {"message":"Invalid API key"}', "Replace key", "connections"],
  ["Connect a model in Settings before running bots.", "Connect a model", "connections"],
  ["Request timed out.", null, null],
  ['429: {"message":"Too many requests"}', null, null],
] as const)("offers the one action that fixes %s", (runError, label, opens) => {
  const onOpenModels = vi.fn();
  const onOpenConnections = vi.fn();
  renderComposer(async () => true, {
    runError,
    runErrorId: "failed-run",
    onOpenModels,
    onOpenConnections,
  });
  const actions = container?.querySelectorAll<HTMLButtonElement>(
    '[data-testid="composer-error-action"]',
  );
  expect(actions?.length).toBe(label ? 1 : 0);
  if (!label) return;
  expect(actions?.[0]?.textContent).toBe(label);
  act(() => actions?.[0]?.click());
  expect(onOpenModels).toHaveBeenCalledTimes(opens === "models" ? 1 : 0);
  expect(onOpenConnections).toHaveBeenCalledTimes(opens === "connections" ? 1 : 0);

  rerenderComposer({ sendError: "Could not send the message." });
  expect(container?.querySelector('[data-testid="composer-error-action"]')).toBeNull();
});

it.each([MODEL_REQUIRED_SEND_ERROR, `  ${MODEL_REQUIRED_SEND_ERROR}  `])(
  "links the missing-model send error to model settings: %s",
  (sendError) => {
    const onOpenModels = vi.fn();
    renderComposer(async () => true, { sendError, onOpenModels });
    const link = container?.querySelector<HTMLButtonElement>(
      '[data-testid="composer-error-open-models"]',
    );
    expect(link?.textContent).toBe(sendError);
    act(() => link?.click());
    expect(onOpenModels).toHaveBeenCalledOnce();

    rerenderComposer({ sendError: "Could not send the message." });
    expect(container?.querySelector('[data-testid="composer-error-open-models"]')).toBeNull();
  },
);

function pickAttachment() {
  const input = container?.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("attachment input not found");
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["notes"], "notes.txt", { type: "text/plain" })],
  });
  act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
}

function type(textarea: HTMLTextAreaElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function nativeDelete(
  textarea: HTMLTextAreaElement,
  selection: [number, number],
  removed: [number, number],
  { key = "Backspace", isComposing = false } = {},
) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => textarea.setSelectionRange(...selection));
  act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
  act(() => {
    setValue?.call(
      textarea,
      textarea.value.slice(0, removed[0]) + textarea.value.slice(removed[1]),
    );
    textarea.setSelectionRange(removed[0], removed[0]);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing }));
  });
}

function pressEnter(textarea: HTMLTextAreaElement) {
  act(() => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

describe("Composer", () => {
  it.each(["Enter", "Tab", "pointer"])(
    "completes an inline bot at the caret with %s",
    async (method) => {
      const onSend = vi.fn().mockResolvedValue(true);
      const textarea = renderComposer(onSend);
      const original = "i need u to message @Bo and do this";
      type(textarea, original);
      act(() => {
        textarea.focus();
        textarea.setSelectionRange(original.indexOf(" and"), original.indexOf(" and"));
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      });
      expect(container?.querySelector('[data-testid="mention-picker"]')).not.toBeNull();
      if (method === "pointer") {
        act(() => container?.querySelector<HTMLButtonElement>('[role="option"]')?.click());
      } else {
        act(() =>
          textarea.dispatchEvent(new KeyboardEvent("keydown", { key: method, bubbles: true })),
        );
      }
      expect(textarea.value).toBe("i need u to message @Bob and do this");
      expect(textarea.selectionStart).toBe("i need u to message @Bob ".length);
      expect(document.activeElement).toBe(textarea);
      pressEnter(textarea);
      await act(async () => {});
      expect(onSend).toHaveBeenCalledWith(
        "i need u to message @Bob and do this",
        [bob],
        expect.any(String),
      );
    },
  );

  it("keeps repeated inline mentions in order with one routing target", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    type(textarea, "ask @Bo");
    pressEnter(textarea);
    type(textarea, `${textarea.value}and then @Bo`);
    pressEnter(textarea);
    expect(textarea.value).toBe("ask @Bob and then @Bob ");
    expect(container?.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(2);
    expect(container?.querySelector('[data-testid="mention-picker"]')).toBeNull();
    expect(textarea.selectionStart).toBe(textarea.value.length);
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("ask @Bob and then @Bob", [bob], expect.any(String));
  });

  it("removes stale routing when a selected token is renamed or deleted", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    type(textarea, "ask @Bo");
    pressEnter(textarea);
    type(textarea, "ask @Bobby later");
    expect(container?.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(0);
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("ask @Bobby later", [], expect.any(String));
  });

  it("draws each completed mention inline in the field instead of beside it", () => {
    const textarea = renderComposer(vi.fn(), {
      mentionTargets: [{ ...bob, color: "#3366FF" }],
    });
    type(textarea, "ask @Bo");
    pressEnter(textarea);
    type(textarea, `${textarea.value}now`);
    const field = container?.querySelector('[data-testid="composer-field"]');
    const card = field?.querySelector('[data-testid="mention-chip"]');
    expect(card?.textContent).toBe("@Bob");
    expect((card as HTMLElement | null)?.style.color).toBe("rgb(51, 102, 255)");
    expect(card?.closest("[inert]")?.textContent).toBe("ask @Bob now");
    expect(container?.querySelector('[aria-label="Remove mention Bob"]')).toBeNull();
    expect(textarea.className).toContain("text-transparent");

    const uploaded = "data:image/png;base64,bmV3";
    rerenderComposer({ mentionTargets: [{ ...bob, color: uploaded }] });
    expect(container?.querySelector('[data-testid="mention-chip"] img')?.getAttribute("src")).toBe(
      uploaded,
    );
  });

  it.each([
    ["Backspace at its end", [9, 9], [8, 9], "Backspace", "ask   ", 5],
    ["Delete at its start", [5, 5], [5, 6], "Delete", "ask   ", 5],
    ["Backspace inside it", [7, 7], [6, 7], "Backspace", "ask   ", 5],
    ["a selection cutting into it", [2, 7], [2, 7], "Backspace", "as ", 2],
    ["a phone keyboard deletion", [9, 9], [8, 9], "Unidentified", "ask   ", 5],
  ] as const)(
    "removes the whole mention after %s",
    (_label, selection, removed, key, value, caret) => {
      const textarea = renderComposer(vi.fn());
      type(textarea, "ask  @Bo");
      pressEnter(textarea);
      expect(textarea.value).toBe("ask  @Bob ");
      nativeDelete(textarea, [...selection], [...removed], { key });
      expect(textarea.value).toBe(value);
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([caret, caret]);
      expect(container?.querySelector('[data-testid="mention-chip"]')).toBeNull();
    },
  );

  it.each([
    ["the space after it", [10, 10], [9, 10], false, "ask  @Bob", 1],
    ["an IME composition edit", [9, 9], [8, 9], true, "ask  @Bo ", 0],
  ] as const)(
    "keeps the native edit for %s",
    (_label, selection, removed, isComposing, value, cards) => {
      const textarea = renderComposer(vi.fn());
      type(textarea, "ask  @Bo");
      pressEnter(textarea);
      nativeDelete(textarea, [...selection], [...removed], { isComposing });
      expect(textarea.value).toBe(value);
      expect(container?.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(cards);
    },
  );

  it("moves the caret past the full token even when completion leaves text unchanged", () => {
    const textarea = renderComposer(vi.fn());
    type(textarea, "ask @Bob, please");
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(7, 7);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    });
    pressEnter(textarea);
    expect(textarea.value).toBe("ask @Bob, please");
    expect(textarea.selectionStart).toBe(8);
    expect(container?.querySelector('[data-testid="mention-picker"]')).toBeNull();
  });

  it("replaces a selected bot without retaining its previous routing target", async () => {
    const bobby: ComposerMention = { kind: "bot", id: "bot-3", name: "Bobby" };
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend, { mentionTargets: [bob, bobby] });
    type(textarea, "ask @Bo");
    pressEnter(textarea);
    act(() => {
      textarea.setSelectionRange(7, 7);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    });
    act(() =>
      container?.querySelector<HTMLButtonElement>('[role="option"][aria-label="@Bobby"]')?.click(),
    );
    expect(textarea.value).toBe("ask @Bobby ");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("ask @Bobby", [bobby], expect.any(String));
  });

  it.each(["bot", "group"] as const)(
    "replaces an overlapping %s name without stale routing",
    async (kind) => {
      const short: ComposerMention = { kind, id: "short", name: "Bob" };
      const long: ComposerMention = { kind: "bot", id: "long", name: "Bob Smith" };
      const onSend = vi.fn().mockResolvedValue(true);
      const textarea = renderComposer(onSend, { mentionTargets: [short, long] });
      type(textarea, "ask @Bo");
      pressEnter(textarea);
      act(() => {
        textarea.setSelectionRange(7, 7);
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      });
      act(() =>
        container
          ?.querySelector<HTMLButtonElement>('[role="option"][aria-label="@Bob Smith"]')
          ?.click(),
      );
      expect(textarea.value).toBe("ask @Bob Smith ");
      expect(container?.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(1);
      pressEnter(textarea);
      await act(async () => {});
      expect(onSend).toHaveBeenCalledWith("ask @Bob Smith", [long], expect.any(String));
    },
  );

  it("replaces the full existing multiword name and preserves a separate short mention", async () => {
    const smith: ComposerMention = { kind: "bot", id: "smith", name: "Bob Smith" };
    const jones: ComposerMention = { kind: "bot", id: "jones", name: "Bob Jones" };
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend, { mentionTargets: [bob, smith, jones] });
    type(textarea, "@Bo");
    pressEnter(textarea);
    type(textarea, `${textarea.value}ask @Bo`);
    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[role="option"][aria-label="@Bob Smith"]')
        ?.click(),
    );
    act(() => {
      textarea.setSelectionRange(12, 12);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    });
    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[role="option"][aria-label="@Bob Jones"]')
        ?.click(),
    );
    expect(textarea.value).toBe("@Bob ask @Bob Jones ");
    nativeDelete(textarea, [4, 4], [3, 4]);
    expect(textarea.value).toBe(" ask @Bob Jones ");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("ask @Bob Jones", [jones], expect.any(String));
  });

  it("keeps Escape dismissal through a delayed native selection event", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    act(() => textarea.focus());
    type(textarea, "@Bo");
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    });
    expect(container?.querySelector('[data-testid="mention-picker"]')).toBeNull();
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("@Bo", [], expect.any(String));
  });

  it("retires the replaced group identity when a bot has the same name", async () => {
    const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend, { mentionTargets: [group, bob] });
    type(textarea, "ask @Bo");
    pressEnter(textarea);
    act(() => {
      textarea.setSelectionRange(7, 7);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    });
    act(() => container?.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click());
    expect(textarea.value).toBe("ask @Bob ");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("ask @Bob", [bob], expect.any(String));
  });

  it.each(["bot", "group"])(
    "deleting only a same-name %s occurrence retires that target",
    async (deleted) => {
      const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
      const onSend = vi.fn().mockResolvedValue(true);
      const textarea = renderComposer(onSend, { mentionTargets: [bob, group] });
      type(textarea, "ask @Bo");
      pressEnter(textarea);
      type(textarea, `${textarea.value}then @Bo`);
      act(() => container?.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click());
      type(textarea, `${textarea.value}please`);
      type(textarea, deleted === "group" ? "ask @Bob then please" : "ask then @Bob please");
      pressEnter(textarea);
      await act(async () => {});
      expect(onSend).toHaveBeenCalledWith(
        deleted === "group" ? "ask @Bob then please" : "ask then @Bob please",
        [expect.objectContaining(deleted === "group" ? bob : group)],
        expect.any(String),
      );
      const [text, mentions] = onSend.mock.calls[0]!;
      expect(
        resolveComposerSendPlan({ text, mentions, hasAttachments: false }).rerouteGroupId,
      ).toBe(deleted === "group" ? null : group.id);
    },
  );

  it.each(["bot", "group"])(
    "deleting a same-name %s card with Backspace removes only its occurrence",
    async (removed) => {
      const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
      const onSend = vi.fn().mockResolvedValue(true);
      const textarea = renderComposer(onSend, { mentionTargets: [bob, group] });
      type(textarea, "ask @Bo");
      pressEnter(textarea);
      type(textarea, `${textarea.value}then @Bo`);
      act(() => container?.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click());
      const end = removed === "group" ? 18 : 8;
      nativeDelete(textarea, [end, end], [end - 1, end]);
      expect(textarea.value).toBe(removed === "group" ? "ask @Bob then  " : "ask  then @Bob ");
      pressEnter(textarea);
      await act(async () => {});
      expect(onSend).toHaveBeenCalledWith(
        removed === "group" ? "ask @Bob then" : "ask  then @Bob",
        [expect.objectContaining(removed === "group" ? bob : group)],
        expect.any(String),
      );
    },
  );

  it("keeps the correct identity after deleting the first of adjacent identical tokens", async () => {
    const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend, { mentionTargets: [bob, group] });
    type(textarea, "@Bo");
    pressEnter(textarea);
    type(textarea, `${textarea.value}@Bo`);
    act(() => container?.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click());
    act(() => {
      textarea.setSelectionRange(0, 5);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    });
    type(textarea, "@Bob ");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith(
      "@Bob",
      [expect.objectContaining(group)],
      expect.any(String),
    );
    const [text, mentions] = onSend.mock.calls[0]!;
    expect(resolveComposerSendPlan({ text, mentions, hasAttachments: false }).shouldOpenGroup).toBe(
      true,
    );
  });

  it("restores occurrence identity after remounting a persisted draft", async () => {
    const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
    const onSend = vi.fn().mockResolvedValue(true);
    let textarea = renderComposer(onSend, { mentionTargets: [bob, group] });
    type(textarea, "ask @Bo");
    pressEnter(textarea);
    type(textarea, `${textarea.value}then @Bo`);
    act(() => container?.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click());
    type(textarea, `${textarea.value}please`);
    act(() => root?.render(<QueryClientProvider client={queryClient}><Composer key="restored" {...composerProps} /></QueryClientProvider>));
    textarea = container!.querySelector("textarea")!;
    expect(textarea.value).toBe("ask @Bob then @Bob please");
    expect(container?.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(2);
    type(textarea, "ask @Bob then please");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("ask @Bob then please", [bob], expect.any(String));
  });

  it("restores text and occurrence identity together after a refused send", async () => {
    const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
    const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const textarea = renderComposer(onSend, { mentionTargets: [bob, group] });
    type(textarea, "ask @Bo");
    pressEnter(textarea);
    type(textarea, `${textarea.value}then @Bo`);
    act(() => container?.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click());
    type(textarea, `${textarea.value}please`);
    pressEnter(textarea);
    await act(async () => {});
    expect(textarea.value).toBe("ask @Bob then @Bob please");
    type(textarea, "ask @Bob then please");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend.mock.calls[1]?.[1]).toEqual([bob]);
  });

  it("restores a legacy raw same-name draft without inventing either target identity", async () => {
    localStorage.setItem("rakazo.composerDraft.bot:bot-1", "@Bob ");
    const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend, { mentionTargets: [bob, group] });
    expect(textarea.value).toBe("@Bob ");
    expect(container?.querySelectorAll('[data-testid="mention-chip"]')).toHaveLength(0);
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("@Bob", [], expect.any(String));
  });

  it("sends only the bound group occurrence through cleanup after a skill prefix and whitespace trim", async () => {
    const group: ComposerMention = { kind: "group", id: "group-bob", name: "Bob" };
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend, { mentionTargets: [bob, group] });
    type(textarea, "/sum");
    act(() =>
      container?.querySelector<HTMLButtonElement>('[aria-label="Skill summarize"]')?.click(),
    );
    type(textarea, "  ask @Bo");
    pressEnter(textarea);
    type(textarea, `${textarea.value}then @Bo`);
    act(() => container?.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click());
    type(textarea, `${textarea.value}please`);
    pressEnter(textarea);
    await act(async () => {});
    const [text, mentions] = onSend.mock.calls[0]!;
    expect(text).toBe("/summarize\nask @Bob then @Bob please");
    expect(resolveComposerSendPlan({ text, mentions, hasAttachments: false })).toMatchObject({
      trimmed: "/summarize\nask @Bob then please",
      rerouteGroupId: group.id,
      mentionPayload: [{ kind: "bot", id: bob.id }],
    });
  });

  it.each([false, true])(
    "keeps the keyboard mention selection when targets refresh (reorder: %s)",
    (reorder) => {
      const alice: ComposerMention = { kind: "bot", id: "bot-3", name: "Alice" };
      const textarea = renderComposer(vi.fn(), { mentionTargets: [alice, bob] });
      type(textarea, "@");
      act(() => {
        textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
      expect(container?.querySelector('[aria-selected="true"]')?.textContent).toContain("Bob");

      rerenderComposer({
        mentionTargets: reorder ? [{ ...bob }, { ...alice }] : [{ ...alice }, { ...bob }],
      });
      pressEnter(textarea);

      expect(container?.querySelector('[data-testid="mention-chip"]')?.textContent).toBe("@Bob");
      expect(container?.querySelector('[data-testid="mention-picker"]')).toBeNull();
    },
  );

  it("falls back to the first mention when the highlighted target disappears", () => {
    const alice: ComposerMention = { kind: "bot", id: "bot-3", name: "Alice" };
    const textarea = renderComposer(vi.fn(), { mentionTargets: [alice, bob] });
    type(textarea, "@");
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });

    rerenderComposer({ mentionTargets: [alice] });
    pressEnter(textarea);

    expect(container?.querySelector('[data-testid="mention-chip"]')?.textContent).toBe("@Alice");
  });

  it.each([false, true])(
    "draws an idle Send button with the primary disabled tokens (running: %s)",
    (running) => {
      renderComposer(vi.fn(), { running });
      const send = container?.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
      expect(send?.disabled).toBe(true);
      expect(send?.className.split(" ")).toEqual(
        expect.arrayContaining([
          "bg-primary",
          "hover:bg-primary-hover",
          "disabled:bg-primary-disabled",
          "disabled:text-foreground/30",
          "disabled:opacity-100",
        ]),
      );
      expect(send?.className).not.toContain("disabled:opacity-50");
    },
  );

  it("clears the draft once the message is sent", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("hello", [], expect.any(String));
    expect(textarea.value).toBe("");
  });

  it("keeps the draft cleared when the send callback rejects", async () => {
    const onSend = vi
      .fn()
      .mockRejectedValueOnce(new Error("unknown outcome"))
      .mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    type(textarea, "@Bo");
    pressEnter(textarea);
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    expect(textarea.value).toBe("");
    expect(container?.querySelector("[data-testid='mention-chip']")).toBeNull();
    type(textarea, "another message");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend.mock.calls[1]?.[2]).not.toBe(onSend.mock.calls[0]?.[2]);
  });

  it("restores the draft and its mentions when the send fails", async () => {
    let finishSend = (_sent: boolean) => {};
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    const textarea = renderComposer(onSend);
    const mentionChips = () =>
      [...(container?.querySelectorAll("[data-testid='mention-chip']") ?? [])].map(
        (chip) => chip.textContent,
      );
    type(textarea, "@Bo");
    pressEnter(textarea);
    type(textarea, "@Bob hello");
    pressEnter(textarea);
    expect(onSend).toHaveBeenCalledWith("@Bob hello", [bob], expect.any(String));
    expect(textarea.value).toBe("");
    expect(mentionChips()).toEqual([]);
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("@Bob hello");
    expect(mentionChips()).toEqual(["@Bob"]);
  });

  it("restores the chosen skill when the send fails", async () => {
    let finishSend = (_sent: boolean) => {};
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    const textarea = renderComposer(onSend);
    const skillChip = () => container?.querySelector("[data-testid='skill-chip']")?.textContent;
    type(textarea, "/sum");
    act(() =>
      container?.querySelector<HTMLButtonElement>("button[aria-label='Skill summarize']")?.click(),
    );
    type(textarea, "the notes");
    pressEnter(textarea);
    expect(onSend).toHaveBeenCalledWith("/summarize\nthe notes", [], expect.any(String));
    expect(skillChip()).toBeUndefined();
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("the notes");
    expect(skillChip()).toBe("summarize");
  });

  it("keeps a newer draft when an earlier send fails", async () => {
    let finishSend = (_sent: boolean) => {};
    const textarea = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    type(textarea, "hello");
    pressEnter(textarea);
    type(textarea, "newer");
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("newer");
  });

  it("does not restore after a newer draft was typed then cleared while sending", async () => {
    let finishSend = (_sent: boolean) => {};
    const textarea = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    type(textarea, "hello");
    pressEnter(textarea);
    type(textarea, "newer");
    type(textarea, "");
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("");
  });

  it("reuses the nonce on an unchanged retry but renews it after an edit", async () => {
    const onSend = vi.fn().mockResolvedValue(false);
    const textarea = renderComposer(onSend);
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    pressEnter(textarea);
    await act(async () => {});
    const firstNonce = onSend.mock.calls[0]?.[2];
    expect(firstNonce).toEqual(expect.any(String));
    expect(onSend.mock.calls[1]?.[2]).toBe(firstNonce);
    type(textarea, "hello edited");
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend.mock.calls[2]?.[2]).not.toBe(firstNonce);
  });

  it("does not restore after an attachment was picked while sending", async () => {
    let finishSend = (_sent: boolean) => {};
    const textarea = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    type(textarea, "hello");
    pressEnter(textarea);
    pickAttachment();
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("");
  });

  it("restores after a rejected attachment pick and preserves the nonce on rejected retry picks", async () => {
    let finishSend = (_sent: boolean) => {};
    const onSend = vi.fn<ComponentProps<typeof Composer>["onSend"]>(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    const onAttachmentPick = vi.fn(() => false);
    const textarea = renderComposer(onSend, { onAttachmentPick });
    type(textarea, "hello");
    pressEnter(textarea);
    pickAttachment();
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("hello");
    pickAttachment();
    pressEnter(textarea);
    await act(async () => finishSend(false));
    expect(onAttachmentPick).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[1]?.[2]).toBe(onSend.mock.calls[0]?.[2]);
  });

  const reply: ThreadMessage = {
    id: "message-1",
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    blocks: [{ kind: "text", text: "original reply" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const replyChanges = [
    { name: "cancelled reply", props: { replyTarget: null, replyQuote: null } },
    { name: "different reply", props: { replyTarget: { ...reply, id: "message-2" } } },
    { name: "different quote", props: { replyQuote: "different quote" } },
  ];

  it.each(replyChanges)("renews the retry nonce for a $name", async ({ props }) => {
    const onSend = vi.fn().mockResolvedValue(false);
    const textarea = renderComposer(onSend, { replyTarget: reply, replyQuote: "original" });
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    rerenderComposer(props);
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend.mock.calls[1]?.[2]).not.toBe(onSend.mock.calls[0]?.[2]);
  });

  it.each(replyChanges)("does not restore after a $name while sending", async ({ props }) => {
    let finishSend = (_sent: boolean) => {};
    const textarea = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
      { replyTarget: reply, replyQuote: "original" },
    );
    type(textarea, "hello");
    pressEnter(textarea);
    rerenderComposer(props);
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("");
  });

  it("preserves the retry nonce when the reply object refreshes without changing its ID or quote", async () => {
    const onSend = vi.fn().mockResolvedValue(false);
    const textarea = renderComposer(onSend, { replyTarget: reply, replyQuote: "original" });
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    rerenderComposer({ replyTarget: { ...reply } });
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend.mock.calls[1]?.[2]).toBe(onSend.mock.calls[0]?.[2]);
  });

  it("uses a fresh nonce for another message after a successful retry", async () => {
    const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    pressEnter(textarea);
    await act(async () => {});
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend.mock.calls[1]?.[2]).toBe(onSend.mock.calls[0]?.[2]);
    expect(onSend.mock.calls[2]?.[2]).not.toBe(onSend.mock.calls[0]?.[2]);
  });

  it("restores an unsent draft when the composer remounts", () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const draftKey = "bot:draft-restore-test";
    const first = renderComposer(onSend, { draftKey });
    type(first, "unsent thought");
    expect(window.localStorage.getItem(`rakazo.composerDraft.${draftKey}`)).toBe("unsent thought");
    act(() => root?.unmount());
    container?.remove();
    const second = renderComposer(onSend, { draftKey });
    expect(second.value).toBe("unsent thought");
  });

  it("keeps Enter as newline and Ctrl+Enter as send when enter-to-send is off", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend, {
      draftKey: "bot:enter-toggle-test",
      enterToSend: false,
    });
    expect(container?.querySelector('[data-testid="composer-enter-to-send-toggle"]')).toBeNull();
    type(textarea, "line one");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).not.toHaveBeenCalled();
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
    });
    await act(async () => {});
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

it.each([true, false])(
  "keeps a pending draft recoverable across unmount (accepted: %s)",
  async (accepted) => {
    let finishSend = (_accepted: boolean) => {};
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    const draftKey = "bot:pending-draft";
    const textarea = renderComposer(onSend, { draftKey });
    type(textarea, "pending text");
    pressEnter(textarea);
    expect(textarea.value).toBe("");
    expect(localStorage.getItem(`rakazo.composerDraft.${draftKey}`)).toBe("pending text");
    act(() => root?.unmount());
    container?.remove();
    await act(async () => finishSend(accepted));
    const restored = renderComposer(vi.fn(), { draftKey });
    expect(restored.value).toBe(accepted ? "" : "pending text");
  },
);

it.each([true, false])(
  "preserves newer stored edits when a send settles (accepted: %s)",
  async (accepted) => {
    let finishSend = (_accepted: boolean) => {};
    const textarea = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    type(textarea, "submitted text");
    pressEnter(textarea);
    type(textarea, "newer text");
    await act(async () => finishSend(accepted));
    expect(textarea.value).toBe("newer text");
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe("newer text");
  },
);

it.each([true, false])(
  "settles a submission after returning to its thread (accepted: %s)",
  async (accepted) => {
    let finishSend = (_accepted: boolean) => {};
    const draftKey = "bot:return-before-settle";
    const first = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
      { draftKey },
    );
    type(first, "submitted text");
    pressEnter(first);
    act(() => root?.unmount());
    container?.remove();
    const returned = renderComposer(vi.fn(), { draftKey });
    expect(returned.value).toBe("submitted text");
    await act(async () => finishSend(accepted));
    expect(returned.value).toBe(accepted ? "" : "submitted text");
    expect(localStorage.getItem(`rakazo.composerDraft.${draftKey}`)).toBe(
      accepted ? null : "submitted text",
    );
  },
);

it("preserves edits made after returning, even when the text matches the submission", async () => {
  let finishSend = (_accepted: boolean) => {};
  const draftKey = "bot:identical-newer-edit";
  const first = renderComposer(
    () =>
      new Promise<boolean>((resolve) => {
        finishSend = resolve;
      }),
    { draftKey },
  );
  type(first, "submitted text");
  pressEnter(first);
  act(() => root?.unmount());
  container?.remove();
  const returned = renderComposer(vi.fn(), { draftKey });
  type(returned, "edited text");
  type(returned, "submitted text");
  await act(async () => finishSend(true));
  expect(returned.value).toBe("submitted text");
  expect(localStorage.getItem(`rakazo.composerDraft.${draftKey}`)).toBe("submitted text");
});

it("clears accepted saved text when only an attachment was picked during the send", async () => {
  let finishSend = (_accepted: boolean) => {};
  const textarea = renderComposer(
    () =>
      new Promise<boolean>((resolve) => {
        finishSend = resolve;
      }),
  );
  type(textarea, "submitted text");
  pressEnter(textarea);
  pickAttachment();
  await act(async () => finishSend(true));
  expect(textarea.value).toBe("");
  expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBeNull();
});

function microphone() {
  const button = container?.querySelector<HTMLButtonElement>('[data-testid="dictation-toggle"]');
  if (!button) throw new Error("Missing voice input");
  return button;
}
function clickMicrophone() {
  act(() => microphone().dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
it("keeps voice input visible with an existing draft and without calls enabled", () => {
  const field = renderComposer(vi.fn());
  type(field, "已有草稿");
  expect(microphone().getAttribute("aria-label")).toBe("Voice input");
});
it("inserts dictated words at the caret and never sends them automatically", () => {
  const send = vi.fn();
  let final!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (opts) => {
    final = opts.onFinal;
  });
  try {
    const field = renderComposer(send);
    type(field, "前文后文");
    act(() => {
      field.focus();
      field.setSelectionRange(2, 2);
    });
    clickMicrophone();
    act(() => final("语音"));
    expect(field.value).toBe("前文语音后文");
    expect(field.selectionStart).toBe(4);
    expect(send).not.toHaveBeenCalled();
    expect(localStorage.getItem("rakazo.composerDraft.bot:bot-1")).toBe("前文语音后文");
  } finally {
    listen.mockRestore();
  }
});
it("finishes on the second click instead of submitting the message", () => {
  let final!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (opts) => {
    final = opts.onFinal;
  });
  const submit = vi.spyOn(dictation, "submitHold").mockImplementation(() => final("识别结果"));
  const send = vi.fn();
  try {
    const field = renderComposer(send);
    clickMicrophone();
    expect(microphone().getAttribute("aria-label")).toBe("Finish dictation");
    clickMicrophone();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(field.value).toBe("识别结果");
    expect(send).not.toHaveBeenCalled();
  } finally {
    listen.mockRestore();
    submit.mockRestore();
  }
});
it("ignores recognition arriving after cancellation", () => {
  let final!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (opts) => {
    final = opts.onFinal;
  });
  try {
    const field = renderComposer(vi.fn());
    type(field, "保留草稿");
    clickMicrophone();
    act(() =>
      container?.querySelector<HTMLButtonElement>('button[aria-label="Cancel dictation"]')?.click(),
    );
    act(() => final("不要插入"));
    expect(field.value).toBe("保留草稿");
  } finally {
    listen.mockRestore();
  }
});
it.each([false, true])("ignores a late result after unmount (different chat=%s)", (different) => {
  let final!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (opts) => {
    final = opts.onFinal;
  });
  try {
    const old = renderComposer(vi.fn());
    type(old, "旧草稿");
    clickMicrophone();
    act(() => root?.unmount());
    container?.remove();
    const field = renderComposer(vi.fn(), { draftKey: different ? "bot:other" : "bot:bot-1" });
    type(field, "新草稿");
    act(() => final("旧录音"));
    expect(field.value).toBe("新草稿");
  } finally {
    listen.mockRestore();
  }
});
it("ignores a late result after switching chats without unmounting", () => {
  let final!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (opts) => {
    final = opts.onFinal;
  });
  try {
    const field = renderComposer(vi.fn());
    clickMicrophone();
    rerenderComposer({ draftKey: "bot:other" });
    type(field, "新会话");
    act(() => final("旧会话录音"));
    expect(field.value).toBe("新会话");
  } finally {
    listen.mockRestore();
  }
});
it("shows recognition startup errors and preserves the draft", async () => {
  const listen = vi.spyOn(dictation, "listen").mockRejectedValue(new Error("permission denied"));
  try {
    const field = renderComposer(vi.fn());
    type(field, "草稿");
    await act(async () => microphone().click());
    expect(field.value).toBe("草稿");
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      "Check microphone permissions",
    );
  } finally {
    listen.mockRestore();
  }
});
it("starts and stops voice input with the composer shortcut", () => {
  let final!: (text: string) => void;
  const listen = vi.spyOn(dictation, "listen").mockImplementation(async (opts) => {
    final = opts.onFinal;
  });
  const submit = vi.spyOn(dictation, "submitHold").mockImplementation(() => final("快捷输入"));
  try {
    const field = renderComposer(vi.fn());
    act(() => field.focus());
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "m", metaKey: true, shiftKey: true, bubbles: true }),
      ),
    );
    expect(listen).toHaveBeenCalledTimes(1);
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "m", metaKey: true, shiftKey: true, bubbles: true }),
      ),
    );
    expect(field.value).toBe("快捷输入");
  } finally {
    listen.mockRestore();
    submit.mockRestore();
  }
});

it("shows file confirmation only for a recognized server response", () => {
  renderComposer(async () => false, {
    sendError: "This model cannot read images. Choose a model that supports images.",
  });
  expect(
    Array.from(container!.querySelectorAll("button")).some(
      (button) => button.textContent === "Send as file",
    ),
  ).toBe(false);
  rerenderComposer({ imageConfirmation: true });
  expect(
    Array.from(container!.querySelectorAll("button")).some(
      (button) => button.textContent === "Send as file",
    ),
  ).toBe(true);
});

it("never carries file confirmation into a later run error after send error dismissal", () => {
  renderComposer(async () => false, {
    sendError: "Image input is not configured for this model.",
    imageConfirmation: true,
  });
  expect(
    Array.from(container!.querySelectorAll("button")).some(
      (button) => button.textContent === "Send as file",
    ),
  ).toBe(true);
  rerenderComposer({ sendError: null, runError: "Another failure", runErrorId: "later-run" });
  expect(
    Array.from(container!.querySelectorAll("button")).some(
      (button) => button.textContent === "Send as file",
    ),
  ).toBe(false);
});

it("invalidates confirmation on user text, attachment removal and replacement only", async () => {
  const onDraftEdited = vi.fn();
  const attachment = { id: "attachment", file: new File(["old"], "old.txt"), threadKey: "bot-1" };
  const textarea = renderComposer(async () => false, {
    onDraftEdited,
    pendingAttachments: [attachment],
  });
  type(textarea, "edited");
  expect(onDraftEdited).toHaveBeenCalledTimes(1);
  act(() => container!.querySelector<HTMLButtonElement>('[aria-label="Remove old.txt"]')!.click());
  expect(onDraftEdited).toHaveBeenCalledTimes(2);
  pickAttachment();
  expect(onDraftEdited).toHaveBeenCalledTimes(3);
  onDraftEdited.mockClear();
  await act(async () => pressEnter(textarea));
  expect(textarea.value).toBe("edited");
  expect(onDraftEdited).not.toHaveBeenCalled();
});

it("shows an image confirmation as a warning with file and model actions", () => {
  const onOpenModels = vi.fn();
  renderComposer(async () => false, {
    sendError: "This model cannot read images. Choose a model that supports images.",
    imageConfirmation: true,
    onOpenModels,
  });
  const error = container!.querySelector('[data-testid="composer-error"]')!;
  expect(error.className).toContain("text-warning");
  expect(error.className).not.toContain("text-destructive");
  const buttons = Array.from(error.querySelectorAll("button"));
  expect(buttons.map((button) => button.textContent)).toEqual(
    expect.arrayContaining(["Send as file", "Change model"]),
  );
  const note = Array.from(error.querySelectorAll("p")).find(
    (element) => element.textContent === "The bot can use the file but won't see the picture.",
  );
  expect(note).toBeDefined();
  const sendAsFile = buttons.find((button) => button.textContent === "Send as file")!;
  expect(sendAsFile.getAttribute("aria-describedby")).toBe(note!.id);
  act(() => buttons.find((button) => button.textContent === "Change model")!.click());
  expect(onOpenModels).toHaveBeenCalledOnce();
  expect(container!.querySelector('[aria-label="Dismiss error"]')).not.toBeNull();

  rerenderComposer({ sendError: "Could not send the message.", imageConfirmation: false });
  expect(error.className).toContain("text-destructive");
  expect(error.className).not.toContain("text-warning");
  expect(error.textContent).not.toContain("The bot can use the file but won't see the picture.");
  expect(
    Array.from(error.querySelectorAll("button")).some(
      (button) => button.textContent === "Change model",
    ),
  ).toBe(false);
});

it("accepts file drops in transparent padding only during file drags", () => {
  const onAttachmentPick = vi.fn(() => true);
  renderComposer(async () => true, { onAttachmentPick });
  const fieldset = container!.querySelector("fieldset")!;
  const dispatchDrag = (target: EventTarget, type: string, dataTransfer: object) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    act(() => target.dispatchEvent(event));
  };
  dispatchDrag(window, "dragenter", { types: ["text/plain"], items: [] });
  expect(fieldset.classList.contains("pointer-events-none")).toBe(true);
  const files = [new File(["example"], "example.txt", { type: "text/plain" })];
  const dataTransfer = { types: ["Files"], items: [], files };
  dispatchDrag(window, "dragenter", dataTransfer);
  expect(fieldset.classList.contains("pointer-events-auto")).toBe(true);
  dispatchDrag(fieldset, "dragover", dataTransfer);
  expect(fieldset.dataset.dragging).toBe("files");
  dispatchDrag(fieldset, "drop", dataTransfer);
  expect(onAttachmentPick).toHaveBeenCalledExactlyOnceWith(files);
  expect(fieldset.classList.contains("pointer-events-none")).toBe(true);
  expect(fieldset.dataset.dragging).toBeUndefined();
  dispatchDrag(window, "dragenter", dataTransfer);
  dispatchDrag(window, "dragleave", dataTransfer);
  expect(fieldset.classList.contains("pointer-events-none")).toBe(true);
  dispatchDrag(window, "dragenter", dataTransfer);
  dispatchDrag(window, "dragend", dataTransfer);
  expect(fieldset.classList.contains("pointer-events-none")).toBe(true);
});

it("stops the running reply on Escape, but lets Escape close the mention picker first", () => {
  const onStop = vi.fn(async () => {});
  const textarea = renderComposer(async () => true, { onStop });
  const pressEscape = () =>
    act(() =>
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );

  pressEscape();
  expect(onStop).not.toHaveBeenCalled();

  rerenderComposer({ running: true });
  pressEscape();
  expect(onStop).toHaveBeenCalledTimes(1);

  type(textarea, "@");
  pressEscape();
  expect(onStop).toHaveBeenCalledTimes(1);

  type(textarea, "/sum");
  expect(container?.querySelector('[aria-label="Skill summarize"]')).not.toBeNull();
  pressEscape();
  expect(onStop).toHaveBeenCalledTimes(1);
  expect(container?.querySelector('[aria-label="Skill summarize"]')).toBeNull();

  act(() =>
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true }),
    ),
  );
  expect(onStop).toHaveBeenCalledTimes(1);
});

it.each([10, -30, window.innerHeight - 10])(
  "records an intersecting run error at top %s once uncovered and stops hit testing",
  async (top) => {
    let fire: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
    const onRunErrorPresented = vi.fn();
    const original = globalThis.IntersectionObserver;
    class FakeIntersectionObserver {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        fire = callback;
      }
      observe(target: Element) {
        const callback = fire;
        fire = (entries) => callback?.(entries.map((entry) => ({ ...entry, target })));
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const rect = {
      width: 200,
      height: 40,
      top,
      left: 10,
      bottom: top + 40,
      right: 210,
      x: 10,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
    let covered = true;
    const pointSpy = vi.fn((x: number, y: number) =>
      x < 0 || x >= window.innerWidth || y < 0 || y >= window.innerHeight
        ? null
        : covered
          ? document.body
          : document.querySelector('[data-testid="composer-error"]'),
    );
    Object.defineProperty(document, "elementFromPoint", {
      value: pointSpy,
      configurable: true,
      writable: true,
    });
    try {
      renderComposer(async () => true, {
        runError: "Something failed.",
        runErrorId: "run-1",
        onRunErrorPresented,
      });

      // Off screen: nothing is marked.
      act(() => fire?.([{ isIntersecting: false }]));
      expect(onRunErrorPresented).not.toHaveBeenCalled();

      act(() => fire?.([{ isIntersecting: true }]));
      expect(onRunErrorPresented).not.toHaveBeenCalled();
      expect(pointSpy).toHaveBeenCalledTimes(1);
      expect(pointSpy).toHaveBeenLastCalledWith(
        110,
        (Math.max(0, top) + Math.min(window.innerHeight, top + 40)) / 2,
      );

      // The last entry wins when a fast scroll enters and leaves in one batch.
      act(() => fire?.([{ isIntersecting: true }, { isIntersecting: false }]));
      await act(async () => {
        document.body.setAttribute("data-uncovered", "false");
        document.dispatchEvent(new Event("transitionend"));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(pointSpy).toHaveBeenCalledTimes(1);
      expect(onRunErrorPresented).not.toHaveBeenCalled();

      act(() => fire?.([{ isIntersecting: true }]));
      expect(pointSpy).toHaveBeenCalledTimes(2);
      covered = false;
      await act(async () => {
        document.body.setAttribute("data-uncovered", "true");
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(onRunErrorPresented).toHaveBeenCalledExactlyOnceWith("run-1");
      expect(pointSpy).toHaveBeenCalledTimes(3);

      await act(async () => {
        document.body.removeAttribute("data-uncovered");
        document.dispatchEvent(new Event("transitionend"));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(pointSpy).toHaveBeenCalledTimes(3);

      // A second entry for the same card does not report it twice.
      act(() => fire?.([{ isIntersecting: true }]));
      expect(onRunErrorPresented).toHaveBeenCalledTimes(1);
    } finally {
      rectSpy.mockRestore();
      Reflect.deleteProperty(document, "elementFromPoint");
      vi.stubGlobal("IntersectionObserver", original);
    }
  },
);

it("offers a guarded stop action for an unresolved native task without resending it", async () => {
  let finish!: () => void;
  const onStop = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const onSend = vi.fn(async () => true);
  renderComposer(onSend, { onStop,
    runError: "An earlier task in this native session is unresolved; inspect it before submitting another task",
    runErrorId: "blocked-run" });
  const button = [...container!.querySelectorAll("button")].find(b => b.textContent === "停止旧任务");
  expect(button).toBeTruthy();
  act(() => button!.click());
  expect(onStop).toHaveBeenCalledTimes(1);
  expect(button!.disabled).toBe(true);
  expect(button!.textContent).toBe("正在核实停止…");
  expect(onSend).not.toHaveBeenCalled();
  await act(async () => { finish(); });
  expect(button!.disabled).toBe(false);
  rerenderComposer({ running: true });
  expect(container!.textContent).not.toContain("停止旧任务");
  rerenderComposer({ running: false, artifactTarget: { groupId: "group" } });
  expect(container!.textContent).not.toContain("停止旧任务");
});
