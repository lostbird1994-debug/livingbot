import type { ThreadMessage } from "@livingbot/contracts";
import { describe, expect, it } from "vitest";
import { mergeLiveProgress } from "./live-progress-merge";

function message(id: string, blocks: ThreadMessage["blocks"], runId = "run-1"): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    runId,
    blocks,
    botId: "bot-1",
    createdAt: "2026-11-21T00:00:00.000Z",
  } as ThreadMessage;
}

const reasoning = (id: string) => ({ id, kind: "reasoning", text: "想一下" }) as const;
const text = (id: string, value: string) => ({ id, kind: "text", text: value }) as const;
const ids = (blocks: ThreadMessage["blocks"]) =>
  blocks.map((block) => (block as { id?: string }).id ?? block.kind);

describe("mergeLiveProgress", () => {
  it("folds the stored activity into the live bubble for the same run", () => {
    const stored = message("engine:run-1", [reasoning("t1"), reasoning("t2")]);
    const live = message("progress:run-1", [text("s1", "正在整理")]);
    const merged = mergeLiveProgress([stored, live]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("progress:run-1");
    expect(ids(merged[0]?.blocks ?? [])).toEqual(["t1", "t2", "s1"]);
  });

  it("keeps a finished message when no live bubble is running", () => {
    const stored = message("engine:run-1", [reasoning("t1")]);
    expect(mergeLiveProgress([stored])).toEqual([stored]);
  });

  it("does not touch another run's live bubble", () => {
    const stored = message("engine:run-1", [reasoning("t1")], "run-1");
    const live = message("progress:run-2", [], "run-2");
    expect(mergeLiveProgress([stored, live])).toEqual([stored, live]);
  });

  it("leaves a live bubble alone when nothing was stored yet", () => {
    const live = message("progress:run-1", [], "run-1");
    expect(mergeLiveProgress([live])).toEqual([live]);
  });

  it("drops a block the stored message already has", () => {
    const stored = message("engine:run-1", [reasoning("t1")]);
    const live = message("progress:run-1", [reasoning("t1"), text("s1", "好了")]);
    const merged = mergeLiveProgress([stored, live]);
    expect(ids(merged[0]?.blocks ?? [])).toEqual(["t1", "s1"]);
  });

  it("keeps the store's order when the stored message arrives after the bubble", () => {
    const live = message("progress:run-1", [text("s1", "正在整理")]);
    const stored = message("engine:run-1", [reasoning("t1")]);
    const merged = mergeLiveProgress([live, stored]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("progress:run-1");
    expect(ids(merged[0]?.blocks ?? [])).toEqual(["t1", "s1"]);
  });
});
