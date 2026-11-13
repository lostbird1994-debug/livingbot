import { describe, expect, it } from "vitest";
import type { AdapterContext, AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { OpenClawAgentRuntime } from "./openclaw-kernel.js";
import type { NativeRecord, NativeStore } from "./openclaw-native-driver.js";

const context: Partial<AdapterContext> = { spaceId: "space", userId: "user" };
function fixture(terminal?: Promise<void>) {
  const records = new Map<string, NativeRecord>();
  const store: NativeStore = {
    async read(key) { return structuredClone(records.get(key)); },
    async write(key, value) { records.set(key, structuredClone(value)); },
  };
  const calls: Array<{ method: string; params: any }> = [];
  let starts = 0;
  let send: (frame: { event: string; payload: Record<string, unknown> }) => void = () => {};
  const runtime = new OpenClawAgentRuntime({
    store, pollMs: 1,
    async resolveAgent(request, actor) {
      expect(actor.spaceId).toBe("space");
      return { agentId: `bot-${request.botId}`, modelId: "test/flash", url: "ws://127.0.0.1:18789", token: "test-token" };
    },
    async connect(_url, _token, event) {
      send = event;
      return {
        async request(method, params: any): Promise<any> {
          calls.push({ method, params });
          if (method === "agent") {
            starts++;
            event({ event: "agent", payload: { runId: params.idempotencyKey, stream: "assistant", data: { delta: "Answer" } } });
            return { runId: params.idempotencyKey };
          }
          if (method === "agent.wait") { await terminal; return { status: "ok" }; }
          if (method === "chat.history") return { messages: [{
            role: "assistant", timestamp: Date.now(), provider: "test", model: "flash",
            content: [{ type: "text", text: "Answer" }], usage: { input: 100, output: 10, cacheRead: 50 },
          }] };
          throw Error(method);
        },
        stop() {},
      };
    },
  });
  const request: AgentRunRequest = {
    botId: "one", threadId: "thread", runId: "run-one", sourceMessageId: "current-user", prompt: "A task",
    instructions: "Only ephemeral context", history: [{ id: "old", role: "user", content: "Earlier conversation" }],
    model: { provider: "test", id: "flash" }, tools: [],
  };
  const collect = async (input = request, actor = context) => {
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(input, actor)) events.push(event);
    return events;
  };
  return { runtime, request, collect, calls, records, starts: () => starts, frame: (frame: Parameters<typeof send>[0]) => send(frame) };
}


import { formatCompactedSummary } from "./history-compaction.js";
it("keeps the compacted summary in a routine with a null source message and more than eight recent exchanges", async () => {
  const f = fixture();
  await f.collect({ ...f.request, runId: "routine-summary-review", sourceMessageId: null,
    prompt: "Run the scheduled report", history: [
      { role: "user", content: formatCompactedSummary("Budget 3700; selected option B", 250) },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `recent-${i}`, role: "user" as const, content: `Recent conversation ${i}` })),
    ] });
  const prompt = f.calls.find(call => call.method === "agent")!.params.extraSystemPrompt;
  expect(prompt).toContain("Recent conversation");
  expect(prompt).toContain("Budget 3700; selected option B");
});
