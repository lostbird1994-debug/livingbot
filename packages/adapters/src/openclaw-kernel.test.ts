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
    botId: "one", threadId: "thread", runId: "run-one", prompt: "A task",
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
describe("OpenClaw kernel", () => {
  it("yields live narration and native tool steps before terminal status, without duplicating the final reply", async () => {
    let finish!: () => void;
    const f = fixture(new Promise<void>(resolve => { finish = resolve; }));
    const stream = f.runtime.run(f.request, context);
    try {
      let event = await stream.next();
      expect(event).toMatchObject({ done: false, value: { type: "progress", text: "正在分析请求…" } });
      do { event = await stream.next(); }
      while (!event.done && !(event.value.type === "progress" && event.value.text === "Answer"));
      expect(event).toMatchObject({ done: false, value: { type: "progress", text: "Answer" } });
      const runId = f.calls.find(call => call.method === "agent")!.params.idempotencyKey;
      f.frame({ event: "agent", payload: { runId, stream: "tool",
        data: { phase: "start", name: "read", toolCallId: "read-1", args: { path: "example.txt" } } } });
      expect(await stream.next()).toMatchObject({
        done: false, value: { type: "tool", name: "read", args: { path: "example.txt" } },
      });
      finish();
      const rest: AgentRuntimeEvent[] = [];
      for await (const event of stream) rest.push(event);
      expect(rest.filter(event => event.type === "text")).toEqual([{ type: "text", text: "Answer" }]);
      expect(f.calls.filter(call => call.method === "agent")).toHaveLength(1);
    } finally {
      finish();
      await stream.return(undefined);
    }
  });
  it("delegates directly with distinct agents and native sessions, preserving final output and usage", async () => {
    const f = fixture();
    const usage: unknown[] = [];
    f.request.onUsage = event => { usage.push(event); };
    const events = await f.collect();
    expect(f.starts()).toBe(1);
    expect(events.filter(event => event.type === "text")).toEqual([{ type: "text", text: "Answer" }]);
    expect(usage).toMatchObject([{ inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 }]);
    expect(events).toContainEqual(expect.objectContaining({ type: "usage", accounted: true }));
    await f.collect({ ...f.request, runId: "run-two", botId: "two" });
    const dispatches = f.calls.filter(call => call.method === "agent").map(call => call.params);
    expect(dispatches.map(call => call.agentId)).toEqual(["bot-one", "bot-two"]);
    expect(dispatches[0].sessionKey).not.toBe(dispatches[1].sessionKey);
    expect(dispatches[0]).toMatchObject({ provider: "test", model: "flash" });
  });
  it("seeds history once and never re-dispatches a recovered run", async () => {
    const f = fixture();
    await f.collect();
    await f.collect();
    expect(f.starts()).toBe(1);
    await f.collect({ ...f.request, runId: "new-run" });
    const dispatches = f.calls.filter(call => call.method === "agent");
    expect(dispatches[0]!.params.extraSystemPrompt).toContain("Earlier conversation");
    expect(dispatches[1]!.params.extraSystemPrompt).not.toContain("Earlier conversation");
  });
  it("keeps the engine's measured total even when optional cache fields are absent", async () => {
    const f = fixture();
    await f.collect();
    const record = f.records.get(JSON.stringify([f.request.runId, 0]))!;
    record.usage = { input: 100, output: 10, cacheRead: 50, total: 160, source: "native-run-observed",
      modelDurationMs: 2000, generationDurationMs: 1000 };
    const events = await f.collect();
    expect(events).toContainEqual(expect.objectContaining({
      type: "usage", totalTokens: 160, inputTokens: 100, cacheWriteTokens: null,
      usageSource: "openclaw-native-run-observed",
      modelDurationMs: 2000, generationDurationMs: 1000,
    }));
    expect(f.starts()).toBe(1);
  });
  it("refuses execution without tenant scope", async () => {
    const f = fixture();
    await expect(f.collect(f.request, {})).rejects.toThrow("tenant context");
    expect(f.starts()).toBe(0);
  });
  it("separates a messaging channel from the private app conversation on the same thread", async () => {
    const f = fixture();
    await f.collect();
    await f.collect({ ...f.request, runId: "channel-run", conversationScope: "channel-one",
      privateContextAllowed: false });
    const dispatches = f.calls.filter(call => call.method === "agent");
    expect(dispatches[0]!.params.sessionKey).not.toBe(dispatches[1]!.params.sessionKey);
  });
});

it("recovers from the frozen first request after clock, history, instructions and model settings change", async () => {
  const f = fixture();
  f.request.prompt = "Check operation at 20:00";
  f.request.sourceMessageId = "source-one";
  await f.collect();
  const key = JSON.stringify([f.request.runId, 0]);
  const record = f.records.get(key)!;
  record.status = "running";
  await f.collect({ ...f.request, prompt: "Check operation at 20:50", instructions: "Updated clock",
    history: [], model: { provider: "different", id: "different" } });
  expect(f.starts()).toBe(1);
  expect(f.records.get(key)?.status).toBe("done");
  expect(f.records.get(JSON.stringify(["kernel-request", f.request.runId]))?.request?.message)
    .toBe("Check operation at 20:00");
  await expect(f.collect({ ...f.request, sourceMessageId: "different-source" })).rejects.toThrow("ownership changed");
  expect(f.starts()).toBe(1);
});

it("gives each routine a stable session separate from private chat and other routines", async () => {
  const f = fixture();
  await f.collect();
  await f.collect({ ...f.request, runId: "routine-one-first", routineId: "routine-one" });
  await f.collect({ ...f.request, runId: "routine-one-next", routineId: "routine-one" });
  await f.collect({ ...f.request, runId: "routine-two-first", routineId: "routine-two" });
  const calls = f.calls.filter(call => call.method === "agent");
  expect(calls[0]!.params.sessionKey).not.toBe(calls[1]!.params.sessionKey);
  expect(calls[1]!.params.sessionKey).toBe(calls[2]!.params.sessionKey);
  expect(calls[1]!.params.sessionKey).not.toBe(calls[3]!.params.sessionKey);
  expect(calls.every(call => call.params.agentId === calls[0]!.params.agentId)).toBe(true);
});
