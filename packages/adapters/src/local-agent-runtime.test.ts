import { describe, expect, it, vi } from "vitest";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { NativeFrame, NativeRecord, NativeStore } from "./openclaw-native-driver.js";
import {
  connectLocalAgentBridge,
  isLocalAgentModel,
  runLocalAgent,
} from "./local-agent-runtime.js";
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
  runId: "run-1",
  prompt: "Current request",
  instructions: "Role",
  tools: [],
  history: [],
  model: {
    provider: "openai-compatible",
    id: "native/codex",
    apiKey: "fake-bridge-key",
    baseUrl: "http://127.0.0.1:43184/v1",
    allowPrivateEndpoint: true,
  },
};
function fixture({ question = false, fail = false } = {}) {
  const store = new Store();
  const calls: Array<{ method: string; params: any }> = [];
  let nativeId = "";
  const connect = async (_url: string, _key: string, event: (frame: NativeFrame) => void) => ({
    request: async <T>(method: string, params: any): Promise<T> => {
      calls.push({ method, params });
      if (method === "models.resolve") return { modelId: params.model ?? "native-default" } as T;
      if (method === "agent") {
        nativeId = params.idempotencyKey;
        if (fail) throw Error("Connection lost before ACK");
        if (question)
          event({
            event: "exec.approval.requested",
            payload: {
              id: "question-1",
              expiresAtMs: Date.now() + 60000,
              request: {
                sessionKey: params.sessionKey,
                kind: "question",
                commandPreview: "Which directory?",
                allowedDecisions: [],
              },
            },
          });
        else
          event({
            event: "agent",
            payload: { runId: nativeId, stream: "assistant", data: { delta: "Preview" } },
          });
        return { runId: nativeId } as T;
      }
      if (method === "agent.wait") return { status: "ok" } as T;
      if (method === "chat.history")
        return {
          messages: [
            {
              role: "assistant",
              model: calls.findLast((c) => c.method === "agent")?.params.model ?? "native-default",
              timestamp: Date.now(),
              content: [{ type: "text", text: "Native result" }],
              usage: { inputTokens: 5, outputTokens: 3 },
            },
          ],
        } as T;
      if (method === "exec.approval.resolve") return { ok: true } as T;
      throw Error("Unexpected RPC");
    },
    stop: vi.fn(),
  });
  return { store, calls, connect };
}
async function collect(input: AgentRunRequest, f: ReturnType<typeof fixture>) {
  const events: AgentRuntimeEvent[] = [];
  for await (const e of runLocalAgent(input, { spaceId: "space", userId: "user" }, f))
    events.push(e);
  return events;
}
describe("local native Agent boundary", () => {
  it("recognizes explicitly configured native models only", () => {
    expect(isLocalAgentModel(request.model)).toBe(true);
    expect(isLocalAgentModel({ ...request.model, id: "native/workbuddy" })).toBe(true);
    expect(isLocalAgentModel({ ...request.model, id: "gpt-custom" })).toBe(false);
    expect(isLocalAgentModel({ ...request.model, provider: "another" })).toBe(false);
  });
  it("runs native tools remotely and uses canonical output instead of preview text or turn ID", async () => {
    const f = fixture();
    const events = await collect(request, f);
    expect(events.filter((e) => e.type === "text")).toEqual([
      { type: "text", text: "Native result" },
    ]);
    expect(events.some((e) => e.type === "tool")).toBe(false);
    expect(f.calls.find((c) => c.method === "agent")?.params.extraSystemPrompt).toBe("Role");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "usage", inputTokens: 5, outputTokens: 3, costUsd: null }),
    );
  });
  it("replays a completed run without starting another native task", async () => {
    const f = fixture();
    await collect(request, f);
    await collect(request, f);
    expect(f.calls.filter((c) => c.method === "agent")).toHaveLength(1);
  });
  it("seeds previous conversation once, preserving isolated native session continuity", async () => {
    const f = fixture();
    const history = [{ id: "past", role: "user" as const, content: "Earlier question" }];
    await collect({ ...request, history }, f);
    await collect({ ...request, runId: "run-2", prompt: "Next", history }, f);
    const turns = f.calls.filter((c) => c.method === "agent");
    expect(turns[0]!.params.message).toContain("Earlier question");
    expect(turns[1]!.params.message).toBe("Next");
    expect(turns[0]!.params.sessionKey).toBe(turns[1]!.params.sessionKey);
  });
  it("pauses questions for an owner answer and resumes the same native task", async () => {
    const f = fixture({ question: true });
    let ask: AgentRuntimeEvent | undefined;
    for await (const e of runLocalAgent(request, { spaceId: "space", userId: "user" }, f)) {
      if (e.type === "ask") {
        ask = e;
        break;
      }
    }
    expect(ask).toMatchObject({
      type: "ask",
      ownerOnly: true,
      approvalRequestId: "question-1",
      externalRequestKind: "question",
      text: "Which directory?",
    });
    expect(f.calls.some((c) => c.method === "chat.abort")).toBe(false);
    const events = await collect(
      {
        ...request,
        prompt: "Answer from owner",
        answeredApproval: { id: "question-1", actionId: "reports" },
      },
      f,
    );
    expect(f.calls).toContainEqual({
      method: "exec.approval.resolve",
      params: { id: "question-1", decision: "answer", value: "reports" },
    });
    expect(f.calls.filter((c) => c.method === "agent")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  });
  it("does not retry an ambiguous dispatch and reports durable uncertainty", async () => {
    const f = fixture({ fail: true });
    const onExecutionState = vi.fn().mockResolvedValue(undefined);
    await expect(collect({ ...request, onExecutionState }, f)).rejects.toThrow("Connection lost");
    await expect(collect(request, f)).rejects.toThrow();
    expect(f.calls.filter((c) => c.method === "agent")).toHaveLength(1);
    expect(onExecutionState).toHaveBeenCalledWith({ status: "unconfirmed" });
  });
  it("settles model reservations even when native execution fails", async () => {
    const f = fixture({ fail: true });
    const beforeCall = vi.fn().mockResolvedValue("reservation");
    const afterCall = vi.fn();
    await expect(
      collect(
        { ...request, model: { ...request.model, callObserver: { beforeCall, afterCall } } },
        f,
      ),
    ).rejects.toThrow();
    expect(afterCall).toHaveBeenCalledWith("reservation", null);
  });
  it("rejects public endpoints before forwarding any bridge key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        connectLocalAgentBridge("https://public.example/", "fake-key", () => {}),
      ).rejects.toThrow("loopback");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it("passes the selected native model and preserves a session across model switches", async () => {
  const f = fixture();
  await collect({ ...request, model: { ...request.model, id: "native/codex/sol" } }, f);
  await collect(
    { ...request, runId: "second-run", model: { ...request.model, id: "native/codex/luna" } },
    f,
  );
  const turns = f.calls.filter((c) => c.method === "agent");
  expect(turns.map((c) => c.params.model)).toEqual(["sol", "luna"]);
  expect(turns[0]!.params.sessionKey).toBe(turns[1]!.params.sessionKey);
});
it("does not redirect the model of an existing task", async () => {
  const f = fixture();
  await collect({ ...request, model: { ...request.model, id: "native/workbuddy/first" } }, f);
  await expect(
    collect({ ...request, model: { ...request.model, id: "native/workbuddy/second" } }, f),
  ).rejects.toThrow("cannot change");
  expect(f.calls.filter((c) => c.method === "agent")).toHaveLength(1);
});
it("rejects an unsupported model before reserving a native task", async () => {
  const f = fixture();
  const original = f.connect;
  const connect = async (...args: Parameters<typeof original>) => {
    const peer = await original(...args);
    return {
      ...peer,
      request: async <T>(method: string, params: any) => {
        if (method === "models.resolve") throw Error("Selected model unavailable");
        return peer.request<T>(method, params);
      },
    };
  };
  await expect(
    collect(
      { ...request, model: { ...request.model, id: "native/codex/missing" } },
      { ...f, connect },
    ),
  ).rejects.toThrow("unavailable");
  expect(f.calls.some((c) => c.method === "agent")).toBe(false);
  expect(f.store.rows.size).toBe(0);
});
it("does not execute when model preflight confirms a different model", async () => {
  const f = fixture();
  const original = f.connect;
  const connect = async (...args: Parameters<typeof original>) => {
    const peer = await original(...args);
    return {
      ...peer,
      request: async <T>(method: string, params: any) =>
        method === "models.resolve" ? ({ modelId: "wrong" } as T) : peer.request<T>(method, params),
    };
  };
  await expect(
    collect(
      { ...request, model: { ...request.model, id: "native/codex/selected" } },
      { ...f, connect },
    ),
  ).rejects.toThrow("confirm");
  expect(f.calls.some((c) => c.method === "agent")).toBe(false);
});
