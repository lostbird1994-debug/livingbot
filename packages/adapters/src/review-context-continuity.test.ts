import { describe, expect, it } from "vitest";
import type { AdapterContext, AgentRunRequest, AgentRuntimeEvent } from "@livingbot/adapter-kit";
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
describe("review: context continuity across fresh native sessions", () => {
  it("carries earlier instructions and the prior answer into the next run", async () => {
    const f = fixture();
    await f.collect({ ...f.request, history: [] });
    await f.collect({ ...f.request, runId: "second", prompt: "Continue", history: [
      { id: "u1", role: "user", content: "Budget is 3700; write in Chinese" },
      { id: "a1", role: "assistant", content: "Selected option B, next compare costs" },
    ] });
    const calls = f.calls.filter(c => c.method === "agent");
    const [, second] = calls;
    expect(second!.params.sessionKey).not.toBe(calls[0]!.params.sessionKey);
    expect(second!.params.extraSystemPrompt).toContain("Budget is 3700");
    expect(second!.params.extraSystemPrompt).toContain("Selected option B");
  });
  it("preserves a supplied historical summary and a file reference", async () => {
    const f = fixture();
    await f.collect({ ...f.request, history: [
      { role: "user", content: formatCompactedSummary("Keep budget 3700 and option B", 250) },
      { role: "user", content: "File: report.pdf; artifactId: review-artifact; /bot/files/report.pdf" },
    ] });
    const prompt = f.calls.find(c => c.method === "agent")!.params.extraSystemPrompt;
    expect(prompt).toContain("Keep budget 3700 and option B");
    expect(prompt).toContain("review-artifact");
    expect(prompt).toContain("/bot/files/report.pdf");
  });
  it("sends the current image to the native model", async () => {
    const f = fixture();
    await f.collect({ ...f.request, currentTurnImages: [{ name: "now.png", mimeType: "image/png", data: new Uint8Array([1,2,3]) }] });
    expect(f.calls.find(c => c.method === "agent")!.params.attachments).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: "AQID" })]));
  });
  it("also sends the prior image when the next turn asks about it", async () => {
    const f = fixture();
    await f.collect({ ...f.request, prompt: "What number is in the previous screenshot?", history: [
      { id: "earlier-image", role: "user", content: "Screenshot: sample.png", images: [
        { name: "sample.png", mimeType: "image/png", data: new Uint8Array([1,2,3]) },
      ] },
    ] });
    expect(f.calls.find(c => c.method === "agent")!.params.attachments ?? []).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: "AQID" })]));
  });
});
