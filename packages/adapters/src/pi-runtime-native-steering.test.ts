import type { AgentRunRequest, AgentRuntimeEvent } from "@livingbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type * as NativeModelStream from "./openclaw-model-stream.js";

const state = vi.hoisted(() => ({
  calls: 0,
  delivered: [] as string[],
  claimedBeforeNative: false,
}));
vi.mock("./openclaw-model-stream.js", async (original) => {
  const actual = await original<typeof NativeModelStream>();
  const { AssistantMessageEventStream } = await import("@earendil-works/pi-ai/utils/event-stream");
  return {
    ...actual,
    openClawModelStream: (request: AgentRunRequest) => {
      state.calls++;
      const stream = new AssistantMessageEventStream();
      void (async () => {
        const messages = (await request.claimSteering?.(["previously-delivered"])) ?? [];
        state.delivered.push(...messages.map((item) => item.id));
        const response = {
          role: "assistant" as const,
          api: "openai-completions" as const,
          provider: request.model.provider,
          model: request.model.id,
          content: [{ type: "text" as const, text: "All instructions completed." }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: response });
        stream.push({ type: "done", reason: "stop", message: response });
        stream.end(response);
      })();
      return stream;
    },
  };
});

import { PiAgentRuntime } from "./pi-runtime.js";

describe("native steering ownership", () => {
  it("leaves pending instructions to the native bridge and does not dispatch a duplicate turn", async () => {
    const events: AgentRuntimeEvent[] = [];
    const request: AgentRunRequest = {
      botId: "bot",
      threadId: "thread",
      runId: "native-steering-test",
      prompt: "Continue the existing task",
      instructions: "Test",
      tools: [],
      history: [],
      model: {
        provider: "openai-compatible",
        id: "openclaw/default",
        baseUrl: "http://127.0.0.1:18789/v1",
        allowPrivateEndpoint: true,
        apiKey: "fake",
      },
      claimSteering: async (seen) => {
        if (!state.calls) state.claimedBeforeNative = true;
        return ["previously-delivered", "additional"]
          .filter((id) => !seen.includes(id))
          .map((id) => ({
            id,
            messageId: `message-${id}`,
            origin: "user" as const,
            text: id,
          }));
      },
    };
    for await (const event of new PiAgentRuntime().run(request)) events.push(event);
    expect(state.claimedBeforeNative).toBe(false);
    expect(state.calls).toBe(1);
    expect(state.delivered).toEqual(["additional"]);
    expect(
      events.some((event) => event.type === "done" && event.text === "All instructions completed."),
    ).toBe(true);
  });
});
