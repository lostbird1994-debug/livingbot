// @vitest-environment jsdom
// A task session's chat follows the same local journal as the main chat.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { adoptConnection, forgetConnection, localThreadSubscription } from "./local-workbench";

const message = {
  id: "message-1", conversationId: "session-a", botId: "bot-1", role: "assistant",
  blocks: [{ id: "text-1", kind: "text", text: "合成交付" }],
  createdAt: 2, updatedAt: 2, final: true,
};

beforeEach(() => {
  forgetConnection();
  adoptConnection({ origin: "http://127.0.0.1:1234", token: "synthetic" });
});
afterEach(() => {
  forgetConnection();
  vi.unstubAllGlobals();
});

it("streams a session's new message as the journal reports it", async () => {
  const encoder = new TextEncoder();
  let sent = false;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname === "/api/snapshot") {
      return Response.json({
        bots: [{ id: "bot-1", agentId: "synthetic", name: "合成 Bot", createdAt: 1 }],
        conversations: [
          { id: "main", kind: "private", botIds: ["bot-1"], title: "主会话", createdAt: 1 },
          { id: "session-a", kind: "private", botIds: ["bot-1"], title: "会话 A", createdAt: 2 },
        ],
        tasks: [], runs: [], interactions: [], artifacts: [], readState: [], lastMessageSeq: {},
      });
    }
    if (url.pathname === "/api/bots/bot-1/private-conversation") return Response.json({ id: "main" });
    if (url.pathname.endsWith("/messages")) {
      // The first read is empty; after the journal event the reply is there.
      return Response.json({ messages: sent ? [message] : [], cursor: 3 });
    }
    if (url.pathname === "/api/events") {
      const body = new ReadableStream({
        start(controller) {
          sent = true;
          controller.enqueue(encoder.encode(
            'id: 7\nevent: change\ndata: {"cursor":7,"type":"messages.changed","data":{}}\n\n',
          ));
        },
        cancel() {},
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({});
  }));

  const controller = new AbortController();
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  for await (const event of localThreadSubscription(
    { botId: "bot-1", taskSessionId: "session-a", cursor: 0 },
    controller.signal,
  )) {
    events.push(event as unknown as { type: string; payload: Record<string, unknown> });
    if (events.some((entry) => entry.type === "thread.message.created")) break;
  }
  controller.abort();
  const created = events.find((event) => event.type === "thread.message.created");
  expect(created?.payload).toMatchObject({ messageId: "message-1", role: "bot" });
  expect((created?.payload.blocks as { kind: string }[])[0]?.kind).toBe("text");
});
