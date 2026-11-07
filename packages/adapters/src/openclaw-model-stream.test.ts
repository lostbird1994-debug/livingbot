import { describe, expect, it, vi } from "vitest";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { NativeFrame, NativeRecord, NativeStore } from "./openclaw-native-driver.js";

const files = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs/promises", () => ({
  mkdir: async () => {},
  appendFile: async (name: string, text: string) => {
    files.set(name, (files.get(name) ?? "") + text);
  },
  readFile: async (name: string) => {
    if (!files.has(name)) throw Object.assign(Error("missing"), { code: "ENOENT" });
    return files.get(name);
  },
}));
import { NativeRunJournal, isOpenClawModel, openClawModelStream } from "./openclaw-model-stream.js";

class Store implements NativeStore {
  rows = new Map<string, NativeRecord>();
  async read(key: string) {
    return structuredClone(this.rows.get(key));
  }
  async write(key: string, row: NativeRecord) {
    this.rows.set(key, structuredClone(row));
  }
}
const request: AgentRunRequest = {
  botId: "bot",
  threadId: "thread",
  runId: "run",
  prompt: "Current task",
  instructions: "Role instructions",
  tools: [],
  history: [],
  model: {
    provider: "openai-compatible",
    id: "openclaw/default",
    apiKey: "test-token",
    baseUrl: "http://127.0.0.1:18789/v1",
    allowPrivateEndpoint: true,
  },
};
function fixture(options: { deltas?: string[]; finalParts?: string[] } = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const store = new Store();
  const events: AgentRuntimeEvent[] = [];
  let closes = 0;
  const connect = async (_url: string, _token: string, event: (frame: NativeFrame) => void) => ({
    request: async <T>(method: string, params: any): Promise<T> => {
      calls.push({ method, params });
      if (method === "agents.list") return { defaultId: "main", agents: [{ id: "main" }] } as T;
      if (method === "agent") {
        event({
          event: "agent",
          payload: {
            runId: params.idempotencyKey,
            stream: "tool",
            data: { name: "Read", phase: "start" },
          },
        });
        event({
          event: "agent",
          payload: {
            runId: params.idempotencyKey,
            stream: "assistant",
            data: { delta: (options.deltas ?? ["Native answer"]).join("") },
          },
        });
        event({
          event: "agent",
          payload: { runId: params.idempotencyKey, stream: "lifecycle", data: { phase: "end" } },
        });
        return { runId: params.idempotencyKey, status: "accepted" } as T;
      }
      if (method === "chat.history")
        return {
          messages: [
            {
              role: "assistant",
              timestamp: Date.now(),
              content: (options.finalParts ?? ["Native answer"]).map((text) => ({
                type: "text",
                text,
              })),
            },
          ],
        } as T;
      return { status: "ok" } as T;
    },
    stop: () => {
      closes++;
    },
  });
  return { calls, store, events, connect, closes: () => closes };
}
describe("OpenClaw model compatibility boundary", () => {
  it("selects only explicitly named external-agent models", () => {
    expect(isOpenClawModel(request.model)).toBe(true);
    expect(isOpenClawModel({ provider: "openai-compatible", id: "gpt-test" })).toBe(false);
    expect(isOpenClawModel({ provider: "other", id: "openclaw/default" })).toBe(false);
  });
  it("connects natively, streams progress and preserves past context once per scoped session", async () => {
    const f = fixture();
    const context = {
      systemPrompt: "Role",
      messages: [
        { role: "user" as const, content: "Previous question", timestamp: 1 },
        { role: "user" as const, content: "Current task", timestamp: 2 },
      ],
    };
    const first = openClawModelStream(
      request,
      context,
      {},
      { spaceId: "space", userId: "user" },
      0,
      (e) => f.events.push(e),
      f,
    );
    await expect(first.result()).resolves.toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "Native answer" }],
    });
    const agent = f.calls.find((c) => c.method === "agent")!;
    expect(agent.params.message).toBe("Current task");
    expect(agent.params.extraSystemPrompt).toContain("Previous question");
    expect(f.events).toContainEqual({ type: "progress", text: "Read: start", activity: true });
    expect(f.events.some((e) => e.type === "tool")).toBe(false);
    const second = openClawModelStream(
      { ...request, runId: "next-run" },
      context,
      {},
      { spaceId: "space", userId: "user" },
      0,
      (e) => f.events.push(e),
      f,
    );
    await second.result();
    expect(f.calls.filter((c) => c.method === "agent")[1]!.params.extraSystemPrompt).toBe("Role");
    expect(f.closes()).toBe(4);
  });
  it("reconstructs canonical text without artificial newlines between streamed blocks", async () => {
    const f = fixture({ deltas: ["N", "\nATIVE_READY"], finalParts: ["N", "ATIVE_READY"] });
    const stream = openClawModelStream(
      request,
      { messages: [] },
      {},
      {},
      0,
      (e) => f.events.push(e),
      f,
    );
    const deltas: string[] = [];
    for await (const event of stream) if (event.type === "text_delta") deltas.push(event.delta);
    expect(deltas.join("")).toBe("NATIVE_READY");
    expect((await stream.result()).content).toEqual([{ type: "text", text: "NATIVE_READY" }]);
  });
  it("reports unreported usage as unknown rather than free", async () => {
    const f = fixture();
    await openClawModelStream(
      request,
      { messages: [] },
      {},
      {},
      0,
      (e) => f.events.push(e),
      f,
    ).result();
    expect(f.events.find((e) => e.type === "usage")).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  });
  it("never opens a private endpoint without operator authorization", async () => {
    const f = fixture();
    const result = await openClawModelStream(
      { ...request, model: { ...request.model, allowPrivateEndpoint: false } },
      { messages: [] },
      {},
      {},
      0,
      () => {},
      f,
    ).result();
    expect(result.stopReason).toBe("error");
    expect(f.calls).toHaveLength(0);
  });
  it("retains spending authorization before dispatch", async () => {
    const f = fixture();
    const observer = {
      beforeCall: async () => {
        throw Error("Budget exhausted");
      },
      afterCall: async () => {},
    };
    const result = await openClawModelStream(
      { ...request, model: { ...request.model, callObserver: observer } },
      { messages: [] },
      {},
      {},
      0,
      () => {},
      f,
    ).result();
    expect(result.stopReason).toBe("error");
    expect(f.calls.some((c) => c.method === "agent")).toBe(false);
  });
});
describe("encrypted append-only native state", () => {
  it("encrypts output and role data and authenticates the record identity", async () => {
    const journal = new NativeRunJournal("mock-state", "test-encryption-key");
    const row: NativeRecord = {
      version: 1,
      sessionKey: "session",
      runId: "native-run",
      inputHash: "hash",
      startedAt: 1,
      status: "done",
      text: "Private task result",
    };
    await journal.write("row-1", row);
    expect([...files.values()].join("")).not.toContain("Private task result");
    expect(await journal.read("row-1")).toEqual(row);
    await journal.write("row-1", { ...row, text: "Updated private result" });
    expect(await journal.read("row-1")).toMatchObject({ text: "Updated private result" });
    expect([...files.values()].find((v) => v.split("\n").length === 3)).toBeDefined();
    await expect(new NativeRunJournal("mock-state", "wrong-key").read("row-1")).rejects.toThrow();
  });
});
