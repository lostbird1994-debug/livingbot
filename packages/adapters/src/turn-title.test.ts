import type { AgentRuntime } from "@livingbot/adapter-kit";
import type { PrismaClient } from "@livingbot/db";
import { describe, expect, it, vi } from "vitest";
import { cleanTurnTitle, generateTurnTitle, MAX_TURN_TITLE_CHARS } from "./turn-title.js";

describe("cleanTurnTitle", () => {
  it("keeps a plain name", () => {
    expect(cleanTurnTitle("示例花园计划")).toBe("示例花园计划");
  });

  it("drops wrapping quotes, list markers and trailing punctuation", () => {
    expect(cleanTurnTitle("1. 「示例花园计划」。")).toBe("示例花园计划");
    expect(cleanTurnTitle("- **示例书架整理**")).toBe("示例书架整理");
  });

  it("takes the first line only", () => {
    expect(cleanTurnTitle("\n\n示例日程检查\n这是解释")).toBe("示例日程检查");
  });

  it("clamps an overlong name instead of keeping a paragraph", () => {
    const title = cleanTurnTitle("一".repeat(MAX_TURN_TITLE_CHARS + 10));
    expect(Array.from(title ?? "")).toHaveLength(MAX_TURN_TITLE_CHARS);
  });

  it("rejects the runtime's own failure text", () => {
    expect(cleanTurnTitle("I hit a problem: no credit")).toBeNull();
    expect(cleanTurnTitle("   ")).toBeNull();
  });
});

function prismaStub(overrides: {
  thread?: unknown;
  anchor?: unknown;
  run?: unknown;
  replies?: unknown[];
}) {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  return {
    prisma: {
      thread: { findUnique: async () => overrides.thread ?? null },
      message: {
        findFirst: async () => overrides.anchor ?? null,
        findMany: async () => overrides.replies ?? [],
        updateMany,
      },
      run: { findFirst: async () => overrides.run ?? null },
      deploymentSettings: { findUnique: async () => null },
    } as unknown as PrismaClient,
    updateMany,
  };
}

function runtimeStub(text: string, calls: unknown[] = []) {
  return {
    describe: () => ({ capabilities: {} }),
    run: async function* (request: unknown) {
      calls.push(request);
      yield { type: "done", text };
    },
  } as unknown as AgentRuntime;
}

const thread = {
  id: "thread-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  taskBotId: null,
};
const anchor = {
  id: "message-1",
  seq: 4,
  blocks: [{ kind: "text", text: "请整理虚构花园的浇水计划" }],
  turnTitle: null,
};

describe("generateTurnTitle", () => {
  it("names the turn and writes it on the message that opened it", async () => {
    const { prisma, updateMany } = prismaStub({
      thread,
      anchor,
      run: { id: "run-1" },
      replies: [{ blocks: [{ kind: "text", text: "示例花园周一浇水，周三检查土壤。" }] }],
    });
    const requests: unknown[] = [];
    const title = await generateTurnTitle(
      {
        prisma,
        runtime: runtimeStub("「示例花园计划」", requests),
        resolveModel: async () => ({ provider: "openai", id: "gpt", apiKey: "k" }),
      },
      { threadId: "thread-1", messageId: "message-1" },
    );
    expect(title).toBe("示例花园计划");
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "message-1", turnTitle: null },
      data: { turnTitle: "示例花园计划" },
    });
    // Naming is a side call: no history, no tools, and its own usage bucket.
    expect(requests[0]).toMatchObject({
      history: [],
      tools: [],
      usageOperationKind: "title",
      runId: "title:message-1",
    });
  });

  it("leaves an already named turn alone", async () => {
    const { prisma, updateMany } = prismaStub({
      thread,
      anchor: { ...anchor, turnTitle: "旧名字" },
      run: { id: "run-1" },
    });
    const title = await generateTurnTitle(
      { prisma, runtime: runtimeStub("新名字") },
      { threadId: "thread-1", messageId: "message-1" },
    );
    expect(title).toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("skips a thread with nothing configured instead of naming with the scripted runtime", async () => {
    const { prisma, updateMany } = prismaStub({
      thread,
      anchor,
      run: { id: "run-1" },
      replies: [{ blocks: [{ kind: "text", text: "好" }] }],
    });
    const title = await generateTurnTitle(
      { prisma, runtime: runtimeStub("不该出现") },
      { threadId: "thread-1", messageId: "message-1" },
    );
    expect(title).toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
