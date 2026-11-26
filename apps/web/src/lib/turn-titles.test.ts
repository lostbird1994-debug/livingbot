import type { ThreadMessage } from "@livingbot/contracts";
import { describe, expect, it } from "vitest";
import { chatTurns } from "./turn-titles";

function message(overrides: Partial<ThreadMessage> & { id: string }): ThreadMessage {
  return {
    threadId: "thread-1",
    seq: 0,
    role: "bot",
    blocks: [{ kind: "text", text: "" }],
    createdAt: "2026-11-24T00:00:00.000Z",
    ...overrides,
  } as ThreadMessage;
}

const preview = (entry: ThreadMessage) =>
  entry.blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join(" ");

describe("chatTurns", () => {
  it("lists one turn per message the person sent, in order", () => {
    const turns = chatTurns(
      [
        message({
          id: "u1",
          role: "user",
          blocks: [{ kind: "text", text: "虚构花园的浇水计划" }],
          turnTitle: "花园计划",
        }),
        message({ id: "b1", role: "bot" }),
        message({
          id: "u2",
          role: "user",
          blocks: [{ kind: "text", text: "请整理示例书架" }],
          turnTitle: "书架整理",
        }),
      ],
      preview,
    );
    expect(turns).toEqual([
      { id: "u1", title: "花园计划" },
      { id: "u2", title: "书架整理" },
    ]);
  });

  it("falls back to the person's own words while a turn has no name yet", () => {
    const [turn] = chatTurns(
      [
        message({
          id: "u1",
          role: "user",
          blocks: [{ kind: "text", text: "示例花园明天需要浇水吗" }],
        }),
      ],
      preview,
    );
    expect(turn?.title).toBe("示例花园明天需要浇水吗");
  });

  it("keeps a fallback on one line and short enough for the margin", () => {
    const [turn] = chatTurns(
      [
        message({
          id: "u1",
          role: "user",
          blocks: [{ kind: "text", text: "第一行\n\n第二段更长的内容继续写下去看看会不会超出去" }],
        }),
      ],
      preview,
    );
    expect(turn?.title.startsWith("第一行 第二段更长的内容")).toBe(true);
    expect(turn?.title).not.toContain("\n");
    expect(Array.from(turn?.title ?? "")).toHaveLength(24);
  });

  it("skips a routine's own output: only the person opens a turn", () => {
    const turns = chatTurns(
      [
        message({ id: "u1", role: "user", blocks: [{ kind: "text", text: "看下今天的进展" }] }),
        message({ id: "b1", role: "bot", routine: true, routineName: "早报" }),
      ],
      preview,
    );
    expect(turns.map((turn) => turn.id)).toEqual(["u1"]);
  });
});
