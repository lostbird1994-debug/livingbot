// @vitest-environment jsdom
import type { ThreadMessage } from "@livingbot/contracts";
import type { ReactNode } from "react";
import { act, useCallback, useMemo, useRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Transcript } from "./transcript";

const messageRenders = vi.hoisted(() => new Map<string, number>());
const messageActive = vi.hoisted(() => new Map<string, boolean>());

vi.mock("./message-view", async () => {
  const { createElement, memo } = await import("react");
  return {
    MessageView: memo(function MessageView({
      message,
      active,
    }: {
      message: { id: string };
      active?: boolean;
    }) {
      messageRenders.set(message.id, (messageRenders.get(message.id) ?? 0) + 1);
      messageActive.set(message.id, active === true);
      return createElement("div", { "data-testid": `message-${message.id}` });
    }),
  };
});

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  messageRenders.clear();
  messageActive.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  HTMLElement.prototype.scrollTo = () => undefined;
  // jsdom has no animation timeline; jumping to a turn flashes the row it lands on.
  Element.prototype.animate ??= (() => ({
    finished: Promise.resolve(),
  })) as unknown as typeof Element.prototype.animate;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const NO_RUNS: ReadonlySet<string> = new Set();

function message(id: string, text: string): ThreadMessage {
  return {
    id,
    threadId: "thread",
    seq: 1,
    role: "bot",
    createdAt: "2026-10-30T12:00:00.000Z",
    blocks: [{ kind: "text", text }],
  };
}

function Host({
  messages,
  running = false,
  activeRunIds = NO_RUNS,
}: {
  messages: ThreadMessage[];
  running?: boolean;
  activeRunIds?: ReadonlySet<string>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const artifactTarget = useMemo(() => ({ botId: "bot" }), []);
  const none = useMemo(() => new Set<string>(), []);
  const reply = useCallback(() => undefined, []);
  const quote = useCallback(() => undefined, []);
  const peer = useCallback(() => undefined, []);
  const refresh = useCallback(async () => undefined, []);
  const answer = useCallback(async () => undefined, []);
  const react = useCallback(async () => undefined, []);
  return (
    <Transcript
      scrollRef={scrollRef}
      scrollRequest={null}
      onScrollRequestHandled={reply}
      followRequest={0}
      artifactTarget={artifactTarget}
      transcript={{
        messages,
        folded: new Map(),
        markerOf: new Map(),
        mergedInto: new Map(),
      }}
      showToolActivity={false}
      olderCursor={null}
      unreadAfterSeq={null}
      loadingOlder={false}
      answerableAskIds={none}
      dismissableAskIds={none}
      running={running}
      activeRunIds={activeRunIds}
      onLoadOlder={reply}
      onOpenBot={reply}
      onAnswer={answer}
      onReply={reply}
      onMarkUnread={reply}
      onQuote={quote}
      onReact={react}
      onJumpToMessage={reply}
      onOpenPeerMessages={peer}
      peerBot={peer}
      onRefresh={refresh}
      onBotChanged={refresh}
      onAddRoutine={quote}
      voiceReady={false}
      speakingMessageId={null}
      onSpeak={reply}
      onOpenComputer={reply}
    />
  );
}

it.each([false, true])(
  "leaves an unchanged message unrendered when a later one updates (mentions: %s)",
  (withMentions) => {
    const kept = message("kept", "Earlier");
    const announcement: ThreadMessage = {
      ...message("announcement", ""),
      blocks: [{ kind: "child_bot", botId: "child", name: "Planner", status: "created" }],
    };
    const earlier = withMentions ? [announcement, kept] : [kept];
    const live = message("progress:run", "Draft");
    act(() => root.render(<Host messages={[...earlier, live]} />));
    expect(messageRenders.get("kept")).toBe(1);
    expect(messageRenders.get("progress:run")).toBe(1);

    act(() =>
      root.render(<Host messages={[...earlier, message("progress:run", "Draft continues")]} />),
    );
    expect(messageRenders.get("kept")).toBe(1);
    expect(messageRenders.get("progress:run")).toBe(2);
    if (withMentions) {
      expect(messageRenders.has("announcement")).toBe(false);
      const renamed: ThreadMessage = {
        ...announcement,
        blocks: [{ kind: "child_bot", botId: "child", name: "Writer", status: "created" }],
      };
      act(() => root.render(<Host messages={[renamed, kept, live]} />));
      expect(messageRenders.get("kept")).toBe(2);
    }
  },
);

it("opens only the reply a still-working run produced", () => {
  const earlier: ThreadMessage = { ...message("earlier", "Done"), runId: "run-earlier" };
  const live: ThreadMessage = { ...message("progress:run-next", "Draft"), runId: "run-next" };

  act(() =>
    root.render(<Host messages={[earlier, live]} running activeRunIds={new Set(["run-next"])} />),
  );
  expect(messageActive.get("earlier")).toBe(false);
  expect(messageActive.get("progress:run-next")).toBe(true);

  act(() =>
    root.render(<Host messages={[earlier]} running activeRunIds={new Set(["run-earlier"])} />),
  );
  expect(messageActive.get("earlier")).toBe(true);
});

it("lists the turns a person opened and marks the one being read", () => {
  const turns: ThreadMessage[] = Array.from({ length: 18 }, (_, index) => ({
    ...message(`turn-${index}`, `第 ${index} 轮的问题`),
    role: "user",
    seq: index * 2,
    ...(index === 0 ? {} : { turnTitle: `第 ${index} 轮` }),
  }));
  const replies: ThreadMessage[] = turns.map((_unused, index) => ({
    ...message(`reply-${index}`, "好"),
    seq: index * 2 + 1,
  }));

  act(() => root.render(<Host messages={[...turns, ...replies]} />));

  const rail = container.querySelector("[data-testid=turn-rail]");
  const labels = [...container.querySelectorAll("[data-turn-id]")].map(
    (entry) => entry.textContent,
  );
  // A turn the naming call has not reached shows the person's own words instead of a blank row.
  expect(labels[0]).toBe("第 0 轮的问题");
  expect(labels[1]).toBe("第 1 轮");
  expect(labels).toHaveLength(18);
  expect(rail?.querySelector("[aria-current=location]")).not.toBeNull();

  const target = container.querySelector<HTMLElement>('[data-turn-id="turn-3"]');
  act(() => target?.click());
  expect(container.querySelector("[aria-current=location]")?.getAttribute("data-turn-id")).toBe(
    "turn-3",
  );
});
