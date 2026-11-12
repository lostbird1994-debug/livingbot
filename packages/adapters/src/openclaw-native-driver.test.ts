import { describe, expect, it } from "vitest";
import { approvalPausedToolResult } from "./approval-effect.js";
import { NativeCollaborationBroker } from "./native-collaboration-broker.js";
import type {
  NativeFrame,
  NativeInput,
  NativeOptions,
  NativeRecord,
  NativeStore,
} from "./openclaw-native-driver.js";
import { nativeRunIndexKey, nativeSessionKey, runNativeAgent } from "./openclaw-native-driver.js";
import { stoppedWorkInstruction } from "./stopped-work.js";

class MemoryStore implements NativeStore {
  records = new Map<string, NativeRecord>();
  async read(key: string) {
    return structuredClone(this.records.get(key));
  }
  async write(key: string, value: NativeRecord) {
    this.records.set(key, structuredClone(value));
  }
}
function fixture(overrides: Partial<NativeInput> = {}) {
  const store = new MemoryStore();
  const calls: Array<{ method: string; params: any; options?: { timeoutMs?: number } }> = [];
  let events: (event: NativeFrame) => void = () => {};
  let runId = "";
  let state = "ok";
  let stopped = 0;
  const input: NativeInput = {
    key: "run-1/0",
    scope: "space/user/bot/thread",
    agentId: "main",
    message: "Test task",
    instructions: "Test role",
    ...overrides,
  };
  let handler = async (method: string, params: any): Promise<any> => {
    if (method === "agent") {
      runId = params.idempotencyKey;
      events({
        event: "agent",
        payload: { runId, stream: "assistant", data: { delta: "Answer" } },
      });
      return { runId, status: "accepted" };
    }
    if (method === "agent.wait") return { runId: params.runId, status: state };
    if (method === "chat.abort") return { aborted: true, runIds: [runId] };
    if (method === "chat.history")
      return {
        messages: [
          { role: "assistant", timestamp: Date.now(), content: [{ type: "text", text: "Answer" }] },
        ],
      };
    if (method === "exec.approval.resolve") return { ok: true };
    throw Error("Unknown method");
  };
  const options: NativeOptions = {
    store,
    pollMs: 1,
    cancelMs: 20,
    connectMs: 20,
    runMs: 5000,
    connect: async (cb) => {
      events = cb;
      return {
        request: async (method, params, requestOptions) => {
          calls.push({ method, params, options: requestOptions });
          return handler(method === "rakazo.run.status" ? "agent.wait" : method, params);
        },
        stop: () => {
          stopped++;
        },
      };
    },
  };
  return {
    input,
    options,
    store,
    calls,
    event: (f: NativeFrame) => events(f),
    setHandler: (h: typeof handler) => {
      handler = h;
    },
    state: (s: string) => {
      state = s;
    },
    stopped: () => stopped,
  };
}

describe("native external Agent lifecycle", () => {
  it.each(["rejected", "timeout"] as const)(
    "releases a new session after a %s handshake so the next routine can run",
    async (failure) => {
      const f = fixture();
      const connect = f.options.connect;
      f.options.connect = failure === "timeout"
        ? () => new Promise(() => {})
        : async () => { throw Error("Handshake failed"); };
      await expect(runNativeAgent(f.input, f.options)).rejects.toMatchObject({ state: "failed" });
      expect(f.calls).toHaveLength(0);
      expect(f.store.records.get(f.input.key)?.status).toBe("failed");
      f.options.connect = connect;
      await expect(runNativeAgent({ ...f.input, key: "next-routine/0" }, f.options))
        .resolves.toBe("Answer");
      expect(f.calls.filter(call => call.method === "agent")).toHaveLength(1);
    },
  );
  it("keeps a recovered dispatch uncertain when reconnect fails", async () => {
    const f = fixture();
    f.setHandler(async () => { throw Error("Lost acknowledgement"); });
    await expect(runNativeAgent(f.input, f.options)).rejects.toMatchObject({ state: "unconfirmed" });
    const saved = f.store.records.get(f.input.key)!;
    // Simulate restart after the durable pre-dispatch write.
    f.store.records.set(f.input.key, { ...saved, status: "dispatching" });
    f.options.connect = async () => { throw Error("Reconnect failed"); };
    await expect(runNativeAgent(f.input, f.options)).rejects.toMatchObject({ state: "unconfirmed" });
    expect(f.calls.filter(call => call.method === "agent")).toHaveLength(1);
  });
  it.each(["provider/flash", "provider/vendor/vision"])(
    "splits %s for attachment capability lookup while preserving the recorded model",
    async (modelId) => {
      const attachments = [{ type: "image", mimeType: "image/png", content: "synthetic" }];
      const f = fixture({ modelId, attachments });
      f.setHandler(async (method, params) => {
        if (method === "agent") return { runId: params.idempotencyKey };
        if (method === "agent.wait") return { status: "ok" };
        if (method === "chat.history") return { messages: [{
          role: "assistant", timestamp: Date.now(), provider: "provider",
          model: modelId.slice(modelId.indexOf("/") + 1),
          content: [{ type: "text", text: "Image answer" }],
        }] };
        throw Error(method);
      });
      await expect(runNativeAgent(f.input, f.options)).resolves.toBe("Image answer");
      expect(f.calls.find(c => c.method === "agent")?.params).toMatchObject({
        provider: "provider", model: modelId.slice(modelId.indexOf("/") + 1), attachments,
      });
      expect(f.store.records.get(f.input.key)?.modelId).toBe(modelId);
    },
  );
  it("keeps image parsing acknowledgement separate from the handshake timeout", async () => {
    const f = fixture();
    await runNativeAgent(f.input, f.options);
    const dispatch = f.calls.find(c => c.method === "agent")!;
    expect(dispatch.options?.timeoutMs).toBe(60_000);
    expect(dispatch.params).not.toHaveProperty("provider");
    expect(dispatch.params).not.toHaveProperty("model");
    expect(dispatch.params).toMatchObject({ channel: "webchat", deliver: false });
  });
  it("streams tool observations and thinking state only for this run, once per tool call", async () => {
    const f = fixture();
    const tools: unknown[] = [];
    const thinking: boolean[] = [];
    f.input.onTool = tool => tools.push(tool);
    f.input.onThinking = active => thinking.push(active);
    f.setHandler(async (method, params) => {
      if (method === "agent") {
        const runId = params.idempotencyKey;
        const thinkingFrame = { event: "agent", payload: { runId, stream: "thinking",
          data: { delta: "provider reasoning is not exposed" } } };
        f.event(thinkingFrame);
        f.event(thinkingFrame);
        const toolFrame = { event: "agent", payload: { runId, stream: "tool",
          data: { phase: "start", name: "read", toolCallId: "call-1", args: { path: "example.txt" } } } };
        f.event({ ...toolFrame, payload: { ...toolFrame.payload, runId: "another-run" } });
        f.event(toolFrame);
        f.event(toolFrame);
        expect(tools).toHaveLength(1);
        expect(thinking).toEqual([true, false]);
        return { runId };
      }
      if (method === "agent.wait") return { status: "ok" };
      if (method === "chat.history") return { messages: [{
        role: "assistant", timestamp: Date.now(), content: [{ type: "text", text: "Answer" }],
      }] };
      throw Error(method);
    });
    await runNativeAgent(f.input, f.options);
    expect(tools).toEqual([{ name: "read", args: { path: "example.txt" },
      executionId: expect.stringMatching(/^native-observed:/) }]);
  });
  it("replaces temporary narration when the correlated final answer is not its continuation", async () => {
    const f = fixture();
    const chunks: Array<{ text: string; replace: boolean }> = [];
    f.input.onText = (text, replace) => chunks.push({ text, replace: replace ?? false });
    f.setHandler(async (method, params) => {
      if (method === "agent") {
        f.event({ event: "agent", payload: { runId: params.idempotencyKey,
          stream: "assistant", data: { delta: "Working preview" } } });
        return { runId: params.idempotencyKey };
      }
      if (method === "agent.wait") return { status: "ok" };
      if (method === "chat.history") return { messages: [{
        role: "assistant", timestamp: Date.now(), content: [{ type: "text", text: "Final output" }],
      }] };
      throw Error(method);
    });
    await expect(runNativeAgent(f.input, f.options)).resolves.toBe("Final output");
    expect(chunks).toEqual([
      { text: "Working preview", replace: false }, { text: "Final output", replace: true },
    ]);
  });
  it("marks an explicit image rejection failed with its real reason", async () => {
    const f = fixture({ attachments: [{}] });
    f.setHandler(async () => {
      throw Object.assign(new Error("attachment image: active model does not accept image inputs"), {
        gatewayCode: "INVALID_REQUEST",
      });
    });
    await expect(runNativeAgent(f.input, f.options)).rejects.toMatchObject({
      state: "failed", message: expect.stringContaining("当前模型未声明支持图片输入"),
    });
    expect(f.store.records.get(f.input.key)?.status).toBe("failed");
    expect(f.calls.filter(c => c.method === "agent")).toHaveLength(1);
  });
  it("leaves a lost dispatch acknowledgement uncertain and never resubmits it", async () => {
    const f = fixture();
    f.setHandler(async () => { throw Error("gateway request timeout for agent"); });
    await expect(runNativeAgent(f.input, f.options)).rejects.toMatchObject({
      state: "unconfirmed", message: expect.stringContaining("勿重复提交"),
    });
    await expect(runNativeAgent(f.input, f.options)).rejects.toThrow();
    expect(f.calls.filter(c => c.method === "agent")).toHaveLength(1);
  });
  it("reads a kernel result by run ID without replacing it with a later session heartbeat", async () => {
    const f = fixture({ collaboration: {
      toolMode: "kernel", tools: [], nativeTools: [],
      execute: async () => ({}), completed: undefined, onPaused() {},
    } });
    let nativeId = "";
    f.setHandler(async (method, params) => {
      if (method === "rakazo.tools.register" || method === "rakazo.tools.close") return {};
      if (method === "rakazo.tools.poll") return { calls: [] };
      if (method === "agent") { nativeId = params.idempotencyKey; return { runId: nativeId }; }
      if (method === "agent.wait") return { status: "ok" };
      if (method === "rakazo.run.result") {
        expect(params.runId).toBe(nativeId);
        return { result: { text: "Current task answer", provider: "test", model: "flash",
          usage: { input: 100, output: 10, totalTokens: 110 } } };
      }
      if (method === "chat.history") throw Error("Session history can contain unrelated background completions");
      throw Error(method);
    });
    await expect(runNativeAgent(f.input, f.options)).resolves.toBe("Current task answer");
    expect(f.store.records.get(f.input.key)?.usage).toMatchObject({
      input: 100, output: 10, totalTokens: 110, source: "native-run-observed",
    });
  });
  it("forwards reasoning effort and reports every observed model call rather than only the final call", async () => {
    let usage: Record<string, unknown> | undefined;
    const f = fixture({ thinking: "low", onUsage: value => { usage = value; } });
    f.setHandler(async (method, params) => {
      if (method === "agent") return { runId: params.idempotencyKey };
      if (method === "agent.wait") return { status: "ok" };
      if (method === "chat.history") return { messages: [
        { role: "assistant", provider: "test", timestamp: Date.now(),
          content: [{ type: "text", text: "Tool call" }],
          usage: { input: 100, output: 5, cacheRead: 30, cacheWrite: 0, totalTokens: 135 } },
        { role: "toolResult", timestamp: Date.now(), content: [] },
        { role: "assistant", provider: "test", timestamp: Date.now(),
          content: [{ type: "text", text: "Final" }],
          usage: { input: 110, output: 10, cacheRead: 50, cacheWrite: 0, totalTokens: 170 } },
      ] };
      throw new Error(method);
    });
    await expect(runNativeAgent(f.input, f.options)).resolves.toBe("Final");
    expect(f.calls.find(call => call.method === "agent")?.params).toMatchObject({ thinking: "low" });
    expect(usage).toMatchObject({
      input: 210, output: 15, cacheRead: 80, cacheWrite: 0, totalTokens: 305, observedCalls: 2,
    });
  });
  it("recovers a completed answer when the status observation request times out", async () => {
    const f = fixture();
    let nativeId = "";
    f.setHandler(async (method, params) => {
      if (method === "agent") {
        nativeId = params.idempotencyKey;
        return { runId: nativeId };
      }
      if (method === "agent.wait") {
        f.event({
          event: "agent",
          payload: { runId: nativeId, stream: "lifecycle", data: { phase: "end" } },
        });
        throw new Error("gateway request timeout for agent.wait");
      }
      if (method === "chat.history")
        return { messages: [{ role: "assistant", timestamp: Date.now(), content: [{ type: "text", text: "Recovered" }] }] };
      throw new Error(method);
    });
    await expect(runNativeAgent(f.input, f.options)).resolves.toBe("Recovered");
    expect(f.calls.filter(c => c.method === "agent")).toHaveLength(1);
    expect(f.store.records.get(f.input.key)?.status).toBe("done");
  });
  it("terminates and confirms only background processes owned by the cancelled run", async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal });
    let nativeId = "";
    f.setHandler(async (method, params) => {
      if (method === "agent") {
        nativeId = params.idempotencyKey;
        for (const [runId, sessionId] of [[nativeId, "owned"], ["different-run", "unrelated"]])
          f.event({ event: "agent", payload: {
            runId, stream: "tool", data: { name: "exec", phase: "result",
              result: { details: { status: "running", sessionId } } },
          } });
        controller.abort();
        return { runId: nativeId };
      }
      if (method === "chat.abort") return { aborted: true, runIds: [nativeId] };
      if (method === "rakazo.process.control") return { status: "completed" };
      throw new Error(method);
    });
    await expect(runNativeAgent(f.input, f.options)).rejects.toThrow("cancelled");
    expect(f.calls.filter(c => c.method === "rakazo.process.control").map(c => c.params)).toEqual([
      { action: "kill", sessionId: "owned", runId: nativeId,
        sessionKey: nativeSessionKey(f.input.scope, f.input.agentId) },
      { action: "poll", sessionId: "owned", runId: nativeId,
        sessionKey: nativeSessionKey(f.input.scope, f.input.agentId) },
    ]);
    expect(f.store.records.get(f.input.key)?.backgroundProcesses).toEqual([]);
  });
  it("does not claim cancellation when a background process remains active", async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal });
    let nativeId = "";
    f.setHandler(async (method, params) => {
      if (method === "agent") {
        nativeId = params.idempotencyKey;
        f.event({ event: "agent", payload: { runId: nativeId, stream: "tool",
          data: { name: "exec", phase: "result",
            result: { details: { status: "running", sessionId: "still-running" } } } } });
        controller.abort();
        return { runId: nativeId };
      }
      if (method === "chat.abort") return { aborted: true, runIds: [nativeId] };
      if (method === "rakazo.process.control") return { status: "running" };
      throw new Error(method);
    });
    await expect(runNativeAgent(f.input, f.options)).rejects.toThrow("Background command cancellation could not be confirmed");
    expect(f.store.records.get(f.input.key)?.status).toBe("unconfirmed");
    expect(f.store.records.get(f.input.key)?.backgroundProcesses).toEqual(["still-running"]);
  });
  it("forwards the stop boundary on a new task in a retained native session", async () => {
    const instructions = stoppedWorkInstruction({
      stoppedAt: "2026-10-01T10:00:00Z",
      throughMessageSeq: 8,
      cancelledMessageIds: [],
    })!;
    const f = fixture({ instructions, message: "A new unrelated request" });
    await runNativeAgent(f.input, f.options);
    expect(f.calls.find((c) => c.method === "agent")?.params).toMatchObject({
      message: "A new unrelated request",
      extraSystemPrompt: expect.stringContaining(instructions),
    });
  });
  it("executes and audits real collaboration calls through the owning run", async () => {
    const f = fixture();
    const broker = new NativeCollaborationBroker();
    let pending: Promise<unknown> | undefined;
    const executions: unknown[] = [];
    const completions: unknown[] = [];
    f.input.collaboration = {
      tools: [
        { name: "message_bot", description: "Message teammate", inputSchema: { type: "object" } },
      ],
      execute: async (...args) => {
        executions.push(args);
        return { delivered: true };
      },
      completed: async (value) => {
        completions.push(value);
      },
      onPaused() {
        throw Error("Unexpected pause");
      },
    };
    f.setHandler(async (method, params) => {
      if (method.startsWith("rakazo.tools.")) {
        const action = method.slice("rakazo.tools.".length) as
          | "register"
          | "poll"
          | "resolve"
          | "close";
        return broker[action](params);
      }
      if (method === "agent") {
        pending = broker.call(params.sessionKey, params.idempotencyKey, {
          id: "native-call",
          name: "message_bot",
          args: { bot_id: "peer", message: "hello" },
        });
        return { runId: params.idempotencyKey };
      }
      if (method === "agent.wait") return { status: "ok" };
      if (method === "chat.history")
        return {
          messages: [
            {
              role: "assistant",
              timestamp: Date.now(),
              content: [{ type: "text", text: "Delivered" }],
            },
          ],
        };
      throw Error(method);
    });
    await expect(runNativeAgent(f.input, f.options)).resolves.toBe("Delivered");
    await expect(pending).resolves.toEqual({ delivered: true });
    expect(executions).toHaveLength(1);
    expect(executions[0]).toEqual([
      "message_bot",
      { bot_id: "peer", message: "hello" },
      expect.stringMatching(/^native-tool:/),
    ]);
    expect(completions).toEqual([
      expect.objectContaining({ name: "message_bot", result: { delivered: true } }),
    ]);
    expect(f.calls.findIndex((c) => c.method === "rakazo.tools.register")).toBeLessThan(
      f.calls.findIndex((c) => c.method === "agent"),
    );
  });
  it.each([false, true])(
    "resumes a gated call only while the native request remains pending (cancelled=%s)",
    async (cancelled) => {
      const f = fixture();
      const broker = new NativeCollaborationBroker();
      let pending: Promise<unknown> | undefined;
      let approved = false;
      let paused = 0;
      const ids: string[] = [];
      f.input.collaboration = {
        tools: [
          { name: "message_bot", description: "Message teammate", inputSchema: { type: "object" } },
        ],
        execute: async (_name, _args, id) => {
          ids.push(id);
          return approved ? { delivered: true } : approvalPausedToolResult();
        },
        completed: undefined,
        onPaused() {
          paused++;
        },
      };
      f.setHandler(async (method, params) => {
        if (method.startsWith("rakazo.tools.")) {
          const action = method.slice("rakazo.tools.".length) as
            | "register"
            | "poll"
            | "resolve"
            | "close";
          return broker[action](params);
        }
        if (method === "agent") {
          pending = broker.call(params.sessionKey, params.idempotencyKey, {
            id: "native-call",
            name: "message_bot",
            args: { message: "hello" },
          });
          return { runId: params.idempotencyKey };
        }
        if (method === "agent.wait") return { status: "ok" };
        if (method === "chat.history")
          return {
            messages: [
              {
                role: "assistant",
                timestamp: Date.now(),
                content: [{ type: "text", text: "Delivered" }],
              },
            ],
          };
        throw Error(method);
      });
      await runNativeAgent(f.input, f.options);
      expect(paused).toBe(1);
      expect(f.store.records.get(f.input.key)).toMatchObject({
        status: "approval",
        approval: { kind: "collaboration" },
      });
      expect(f.calls.some((c) => c.method === "rakazo.tools.resolve")).toBe(false);
      expect(f.calls.some((c) => c.method === "rakazo.tools.close")).toBe(false);
      if (cancelled) {
        const registration = f.calls.find((c) => c.method === "rakazo.tools.register")!.params;
        broker.cancel(registration.sessionKey, registration.runId, "native-call");
        await expect(runNativeAgent(f.input, f.options)).rejects.toMatchObject({ state: "failed" });
        await expect(pending).resolves.toHaveProperty("error");
        expect(ids).toHaveLength(1);
        expect(f.calls.filter((c) => c.method === "agent")).toHaveLength(1);
        return;
      }
      approved = true;
      await expect(runNativeAgent(f.input, f.options)).resolves.toBe("Delivered");
      await expect(pending).resolves.toEqual({ delivered: true });
      expect(ids).toHaveLength(2);
      expect(ids[0]).toBe(ids[1]);
      expect(f.calls.filter((c) => c.method === "agent")).toHaveLength(1);
      expect(f.calls.some((c) => c.method === "exec.approval.resolve")).toBe(false);
    },
  );
  it("records a pre-dispatch cancellation without opening a native connection", async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fixture({ signal: controller.signal });
    await expect(runNativeAgent(f.input, f.options)).rejects.toMatchObject({ state: "cancelled" });
    expect(f.calls).toEqual([]);
    expect(f.store.records.get(f.input.key)?.status).toBe("cancelled");
  });
  it("persists the active execution index before native dispatch", async () => {
    const f = fixture({ activeKey: "active-index" });
    const connect = f.options.connect;
    f.options.connect = async (onEvent) => {
      const peer = await connect(onEvent);
      const request = peer.request.bind(peer);
      peer.request = async (method, params, options) => {
        if (method === "agent")
          expect(f.store.records.get("active-index")).toMatchObject({
            executionKey: f.input.key,
            status: "dispatching",
          });
        return request(method, params, options);
      };
      return peer;
    };
    await runNativeAgent(f.input, f.options);
    expect(f.store.records.get("active-index")?.status).toBe("done");
  });
  it("isolates sessions by user, bot and group while preserving stable identities", () => {
    expect(nativeSessionKey("u/b/group-1", "main")).toBe(nativeSessionKey("u/b/group-1", "main"));
    for (const scope of ["u/b/group-2", "u/b2/group-1", "u2/b/group-1"])
      expect(nativeSessionKey(scope, "main")).not.toBe(nativeSessionKey("u/b/group-1", "main"));
    expect(nativeSessionKey("u/b/group-1", "other")).not.toBe(
      nativeSessionKey("u/b/group-1", "main"),
    );
  });
  it("persists identity before dispatch, uses a native system prompt and emits the answer", async () => {
    const f = fixture();
    const deltas: string[] = [];
    f.input.onText = (d) => deltas.push(d);
    await expect(runNativeAgent(f.input, f.options)).resolves.toBe("Answer");
    const call = f.calls.find((c) => c.method === "agent")!;
    expect(call.params).toMatchObject({ extraSystemPrompt: expect.stringContaining("Test role"), deliver: false });
    expect(f.store.records.get(f.input.key)?.status).toBe("done");
    expect(deltas).toEqual(["Answer"]);
    expect(f.stopped()).toBe(1);
  });
  it("does not replay side effects when the same completed request is retried", async () => {
    const f = fixture();
    await runNativeAgent(f.input, f.options);
    await runNativeAgent(f.input, f.options);
    expect(f.calls.filter((c) => c.method === "agent")).toHaveLength(1);
  });
  it("refuses a changed task under an existing idempotency identity", async () => {
    const f = fixture();
    await runNativeAgent(f.input, f.options);
    await expect(
      runNativeAgent({ ...f.input, message: "Another task" }, f.options),
    ).rejects.toThrow("identity changed");
  });
  it("never redispatches after a lost ACK, including after a process restart", async () => {
    const f = fixture();
    f.setHandler(async () => {
      throw Error("Disconnected after dispatch");
    });
    await expect(runNativeAgent(f.input, f.options)).rejects.toThrow("Disconnected");
    expect(f.store.records.get(f.input.key)?.status).toBe("unconfirmed");
    await expect(runNativeAgent(f.input, f.options)).rejects.toThrow();
    expect(f.calls.filter((c) => c.method === "agent")).toHaveLength(1);
  });
  it("reconciles a persisted running task without sending another agent request", async () => {
    const f = fixture();
    await runNativeAgent(f.input, f.options);
    const row = f.store.records.get(f.input.key)!;
    row.status = "running";
    f.calls.length = 0;
    await expect(runNativeAgent(f.input, f.options)).resolves.toBe("Answer");
    expect(f.calls.map((c) => c.method)).not.toContain("agent");
  });
  it("surfaces native failure as failure rather than a successful error sentence", async () => {
    const f = fixture();
    f.state("error");
    await expect(runNativeAgent(f.input, f.options)).rejects.toThrow("Native execution failed");
    expect(f.store.records.get(f.input.key)?.status).toBe("failed");
  });
  it("ignores unrelated run events and exposes native tool progress without executing it twice", async () => {
    const notices: string[] = [];
    const f = fixture({ onNotice: (n) => notices.push(n.text) });
    f.setHandler(async (method, params) => {
      if (method === "agent") {
        f.event({
          event: "agent",
          payload: { runId: "other", stream: "assistant", data: { delta: "SECRET" } },
        });
        f.event({
          event: "agent",
          payload: {
            runId: params.idempotencyKey,
            stream: "tool",
            data: { name: "Shell", phase: "start" },
          },
        });
        f.event({
          event: "agent",
          payload: { runId: params.idempotencyKey, stream: "assistant", data: { delta: "OK" } },
        });
        return { runId: params.idempotencyKey };
      }
      if (method === "chat.history")
        return {
          messages: [
            { role: "assistant", timestamp: Date.now(), content: [{ type: "text", text: "OK" }] },
          ],
        };
      return { status: "ok" };
    });
    await expect(runNativeAgent(f.input, f.options)).resolves.toBe("OK");
    expect(notices).toEqual(["正在分析请求…", "正在执行本机任务…"]);
  });
  it("requires cancellation to settle, beyond an abort ACK", async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal });
    f.setHandler(async (method, params) => {
      if (method === "agent") {
        controller.abort();
        return { runId: params.idempotencyKey };
      }
      if (method === "chat.abort") return { aborted: true };
      return { status: "timeout" };
    });
    await expect(runNativeAgent(f.input, f.options)).rejects.toThrow("unconfirmed");
    expect(f.store.records.get(f.input.key)?.status).toBe("unconfirmed");
  });
  it("confirms cancellation when the native runner has terminated", async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal });
    f.setHandler(async (method, params) => {
      if (method === "agent") {
        controller.abort();
        return { runId: params.idempotencyKey };
      }
      if (method === "chat.abort") return { aborted: true };
      return { status: "error", stopReason: "aborted" };
    });
    await expect(runNativeAgent(f.input, f.options)).rejects.toThrow("cancelled");
    expect(f.store.records.get(f.input.key)?.status).toBe("cancelled");
  });
  it("releases a session on an exact native abort even when the wait cache has no end record", async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal });
    let nativeId = "";
    f.setHandler(async (method, params) => {
      if (method === "agent") {
        nativeId = params.idempotencyKey;
        controller.abort();
        return { runId: nativeId };
      }
      if (method === "chat.abort") return { aborted: true, runIds: [nativeId] };
      return { status: "timeout" };
    });
    await expect(runNativeAgent(f.input, f.options)).rejects.toThrow("cancelled");
    expect(
      f.store.records.get(`session-owner:${nativeSessionKey(f.input.scope, f.input.agentId)}`)
        ?.status,
    ).toBe("cancelled");
  });
  it("does not turn a cancellation lifecycle event into a completed answer", async () => {
    const f = fixture();
    f.setHandler(async (method, params) => {
      if (method === "agent") {
        f.event({
          event: "agent",
          payload: {
            runId: params.idempotencyKey,
            stream: "lifecycle",
            data: { phase: "end", status: "cancelled", aborted: true },
          },
        });
        return { runId: params.idempotencyKey };
      }
      throw new Error("Must not read final history");
    });
    await expect(runNativeAgent(f.input, f.options)).rejects.toThrow("cancelled");
  });
  it("forwards new instructions while the native tool loop is running, once per message", async () => {
    const seen: string[][] = [];
    const f = fixture({
      claimSteering: async (ids) => {
        seen.push(ids);
        return ids.includes("extra") ? [] : [{ id: "extra", text: "Also check the second file" }];
      },
    });
    let polls = 0;
    f.setHandler(async (method, params) => {
      if (method === "agent") return { runId: params.idempotencyKey };
      if (method === "chat.send") {
        f.event({
          event: "chat",
          payload: {
            runId: params.idempotencyKey,
            state: "final",
            message: { content: [{ type: "text", text: "steered current session." }] },
          },
        });
        return { runId: params.idempotencyKey, status: "started" };
      }
      if (method === "agent.wait") return { status: ++polls < 3 ? "timeout" : "ok" };
      return {
        messages: [
          {
            role: "assistant",
            timestamp: Date.now(),
            content: [{ type: "text", text: "Both files checked" }],
          },
        ],
      };
    });
    await expect(runNativeAgent(f.input, f.options)).resolves.toBe("Both files checked");
    expect(f.calls.filter((c) => c.method === "agent")).toHaveLength(1);
    expect(f.calls.filter((c) => c.method === "chat.send")).toEqual([
      {
        method: "chat.send",
        options: { timeoutMs: 20 },
        params: expect.objectContaining({
          message: "/steer Also check the second file",
          sessionKey: nativeSessionKey(f.input.scope, f.input.agentId),
        }),
      },
    ]);
    expect(seen).toEqual([[], ["extra"]]);
    expect(f.store.records.get(f.input.key)?.steeringIds).toEqual(["extra"]);
  });
  it.each(["refused", "missing-receipt", "rpc-error"])(
    "keeps the task running and reports unconfirmed instructions (%s)",
    async (delivery) => {
      let delivered = false;
      let polls = 0;
      const f = fixture({
        claimSteering: async () => [{ id: "extra", text: "Additional instruction" }],
        onSteered: () => {
          delivered = true;
        },
      });
      f.setHandler(async (method, params) => {
        if (method === "agent") return { runId: params.idempotencyKey };
        if (method === "agent.wait") return { status: ++polls < 2 ? "timeout" : "ok" };
        if (method === "chat.history")
          return {
            messages: [
              {
                role: "assistant",
                timestamp: Date.now(),
                content: [{ type: "text", text: "Original task completed." }],
              },
              {
                role: "assistant",
                timestamp: Date.now(),
                content: [{ type: "text", text: "⚠️ No active run to steer in this session." }],
              },
            ],
          };
        if (method === "chat.send") {
          if (delivery === "rpc-error") throw new Error("Command rejected");
          if (delivery === "refused")
            f.event({
              event: "chat",
              payload: {
                runId: params.idempotencyKey,
                state: "final",
                message: {
                  content: [{ type: "text", text: "⚠️ No active run to steer in this session." }],
                },
              },
            });
          return { runId: params.idempotencyKey, status: "started" };
        }
        throw Error("Unexpected request");
      });
      await expect(runNativeAgent(f.input, f.options)).resolves.toContain("有追加指令尚未确认送达");
      expect(f.store.records.get(f.input.key)?.text).toContain("Original task completed.");
      expect(delivered).toBe(false);
      expect(f.store.records.get(f.input.key)?.unconfirmedSteeringIds).toEqual(["extra"]);
      expect(f.store.records.get(f.input.key)?.status).toBe("done");
    },
  );
  it("does not mistake a long silent tool for a failed model stream", async () => {
    const f = fixture();
    let polls = 0;
    f.setHandler(async (method, params) => {
      if (method === "agent") return { runId: params.idempotencyKey };
      if (method === "agent.wait") return { status: ++polls < 4 ? "timeout" : "ok" };
      return {
        messages: [
          {
            role: "assistant",
            timestamp: Date.now(),
            content: [{ type: "text", text: "Finished" }],
          },
        ],
      };
    });
    await expect(runNativeAgent(f.input, f.options)).resolves.toBe("Finished");
    expect(polls).toBe(4);
  });
  it("leaves native approval pending rather than implicitly allowing unknown answers", async () => {
    const controller = new AbortController();
    let f: ReturnType<typeof fixture>;
    f = fixture({
      signal: controller.signal,
      onNotice: (n) => {
        if (n.type === "approval") controller.abort();
      },
    });
    f.setHandler(async (method, params) => {
      if (method === "agent") {
        f.event({
          event: "exec.approval.requested",
          payload: {
            id: "approval-1",
            expiresAtMs: Date.now() + 10000,
            request: { sessionKey: params.sessionKey, command: "sensitive command" },
          },
        });
        return { runId: params.idempotencyKey };
      }
      return { status: "timeout" };
    });
    await expect(runNativeAgent(f.input, f.options)).resolves.toBe("");
    expect(f.store.records.get(f.input.key)?.status).toBe("approval");
    expect(f.calls.map((c) => c.method)).not.toContain("exec.approval.resolve");
    expect(f.calls.map((c) => c.method)).not.toContain("chat.abort");
  });
  it("fails an expired approval without starting a replacement task", async () => {
    const f = fixture();
    await runNativeAgent(f.input, f.options);
    const row = f.store.records.get(f.input.key)!;
    row.status = "approval";
    row.approval = {
      id: "approval-1",
      expiresAtMs: 0,
      command: "cmd",
      decisions: ["allow-once", "deny"],
    };
    f.calls.length = 0;
    await expect(
      runNativeAgent(
        { ...f.input, answeredApproval: { id: "approval-1", actionId: "allow-once" } },
        f.options,
      ),
    ).rejects.toThrow("expired");
    expect(f.calls.map((c) => c.method)).not.toContain("agent");
  });
  it("blocks new work in a session whose earlier dispatch is unconfirmed", async () => {
    const f = fixture();
    f.setHandler(async () => {
      throw Error("lost ACK");
    });
    await expect(runNativeAgent(f.input, f.options)).rejects.toThrow();
    await expect(runNativeAgent({ ...f.input, key: "new-run" }, f.options)).rejects.toThrow(
      "earlier task",
    );
    expect(f.calls.filter((c) => c.method === "agent")).toHaveLength(1);
  });
  it("resolves a persisted explicit approval without dispatching another task", async () => {
    const f = fixture();
    await runNativeAgent(f.input, f.options);
    const row = f.store.records.get(f.input.key)!;
    row.status = "approval";
    row.approval = {
      id: "approved",
      expiresAtMs: Date.now() + 10000,
      command: "cmd",
      decisions: ["allow-once", "deny"],
    };
    f.calls.length = 0;
    await expect(
      runNativeAgent(
        { ...f.input, answeredApproval: { id: "approved", actionId: "allow-once" } },
        f.options,
      ),
    ).resolves.toBe("Answer");
    expect(f.calls).toContainEqual({
      method: "exec.approval.resolve",
      params: { id: "approved", decision: "allow-once" },
    });
    expect(f.calls.map((c) => c.method)).not.toContain("agent");
  });
  it("does not turn a native aborted stop reason into success", async () => {
    const f = fixture();
    f.setHandler(async (method, params) =>
      method === "agent"
        ? { runId: params.idempotencyKey }
        : { status: "ok", stopReason: "aborted" },
    );
    await expect(runNativeAgent(f.input, f.options)).rejects.toThrow("cancelled");
  });
  it("uses an independent execution deadline and confirms the resulting cancellation", async () => {
    const f = fixture();
    let cancelled = false;
    f.setHandler(async (method, params) => {
      if (method === "agent") return { runId: params.idempotencyKey };
      if (method === "chat.abort") {
        cancelled = true;
        return { aborted: true };
      }
      return {
        status: cancelled ? "error" : "timeout",
        stopReason: cancelled ? "aborted" : undefined,
      };
    });
    await expect(runNativeAgent(f.input, { ...f.options, runMs: 3 })).rejects.toThrow("deadline");
    expect(cancelled).toBe(true);
  });
  it("does not dispatch when its durable intent cannot be saved", async () => {
    const f = fixture();
    f.options.store = {
      read: async () => undefined,
      write: async () => {
        throw Error("disk failure");
      },
    };
    await expect(runNativeAgent(f.input, f.options)).rejects.toThrow("disk failure");
    expect(f.calls.map((c) => c.method)).not.toContain("agent");
  });
});

it("does not replay an answer that belongs to another approval", async () => {
  const f = fixture();
  await runNativeAgent(f.input, f.options);
  const row = f.store.records.get(f.input.key)!;
  row.status = "approval";
  row.approval = {
    id: "next-approval",
    expiresAtMs: Date.now() + 10000,
    command: "cmd",
    decisions: ["allow-once", "deny"],
  };
  const controller = new AbortController();
  f.calls.length = 0;
  await runNativeAgent(
    {
      ...f.input,
      signal: controller.signal,
      answeredApproval: { id: "old-approval", actionId: "allow-once" },
      onNotice: () => controller.abort(),
    },
    f.options,
  );
  expect(f.calls.map((c) => c.method)).not.toContain("exec.approval.resolve");
  expect(f.calls.map((c) => c.method)).not.toContain("agent");
});

it("preserves an explicitly unconfirmed native error instead of freeing the session", async () => {
  const f = fixture();
  f.setHandler(async (method, params) => {
    if (method === "agent") {
      f.event({
        event: "agent",
        payload: {
          runId: params.idempotencyKey,
          stream: "lifecycle",
          data: { phase: "error", error: "Connection lost", unconfirmed: true },
        },
      });
      return { runId: params.idempotencyKey };
    }
    return { status: "error", unconfirmed: true };
  });
  await expect(runNativeAgent(f.input, f.options)).rejects.toMatchObject({ state: "unconfirmed" });
  expect(f.store.records.get(f.input.key)?.status).toBe("unconfirmed");
  await expect(runNativeAgent({ ...f.input, key: "another-run" }, f.options)).rejects.toThrow(
    "earlier task",
  );
});

it("keeps a newer approval that arrives before the earlier answer ACK", async () => {
  const f = fixture();
  await runNativeAgent(f.input, f.options);
  const row = f.store.records.get(f.input.key)!;
  row.status = "approval";
  row.approval = {
    id: "first",
    command: "first command",
    expiresAtMs: Date.now() + 60000,
    decisions: ["allow-once", "deny"],
  };
  const controller = new AbortController();
  f.setHandler(async (method, params) => {
    if (method === "exec.approval.resolve") {
      f.event({
        event: "exec.approval.requested",
        payload: {
          id: "second",
          expiresAtMs: Date.now() + 60000,
          request: { sessionKey: row.sessionKey, command: "second command" },
        },
      });
      return { ok: true };
    }
    return { status: "timeout" };
  });
  const notices: string[] = [];
  await runNativeAgent(
    {
      ...f.input,
      signal: controller.signal,
      answeredApproval: { id: "first", actionId: "allow-once" },
      onNotice: (notice) => {
        if (notice.id) {
          notices.push(notice.id);
          controller.abort();
        }
      },
    },
    f.options,
  );
  expect(f.store.records.get(f.input.key)?.approval?.id).toBe("second");
  expect(f.store.records.get(f.input.key)?.status).toBe("approval");
  expect(notices).toContain("second");
});

it("keeps the grant and follows the original run through an attempt error until its final receipt", async () => {
  const notices: string[] = [];
  const broker = new NativeCollaborationBroker();
  let nativeId = "";
  let queries = 0;
  const f = fixture({ onNotice: n => notices.push(n.text), collaboration: {
    toolMode: "kernel", tools: [], nativeTools: ["read"],
    execute: async () => ({}), completed: undefined, onPaused() {},
  } });
  const sessionKey = nativeSessionKey(f.input.scope, f.input.agentId);
  f.setHandler(async (method, params) => {
    if (method === "rakazo.tools.register") return broker.register(params);
    if (method === "rakazo.tools.close") return broker.close(params);
    if (method === "rakazo.tools.poll") return broker.poll(params);
    if (method === "agent") {
      nativeId = params.idempotencyKey;
      f.event({ event: "agent", payload: { runId: nativeId, stream: "lifecycle",
        data: { phase: "error", error: "LLM request timed out." } } });
      f.event({ event: "chat", payload: { runId: nativeId, state: "error", errorMessage: "terminated" } });
      return { runId: nativeId };
    }
    if (method === "agent.wait") {
      expect(broker.nativeToolDecision(sessionKey, "read")).toBeUndefined();
      expect(f.calls.filter(c => c.method === "rakazo.tools.close")).toHaveLength(0);
      if (++queries === 1) throw Error("connection closed");
      return { status: queries === 2 ? "running" : "ok" };
    }
    if (method === "rakazo.run.result") return { result: {
      text: "Recovered result", provider: "test", model: "test",
    } };
    throw Error(method);
  });
  await expect(runNativeAgent(f.input, f.options)).resolves.toBe("Recovered result");
  expect(f.calls.filter(c => c.method === "agent")).toHaveLength(1);
  expect(f.calls.filter(c => c.method === "rakazo.tools.close")).toHaveLength(1);
  expect(broker.nativeToolDecision(sessionKey, "read")).toHaveProperty("block", true);
  expect(notices.filter(n => n.includes("正在确认"))).toHaveLength(1);
});

it.each(["error", "unconfirmed"])("handles a definitive %s receipt without resubmitting", async status => {
  const f = fixture({ collaboration: { toolMode: "kernel", tools: [], nativeTools: [],
    execute: async () => ({}), completed: undefined, onPaused() {} } });
  f.setHandler(async (method, params) => {
    if (method.startsWith("rakazo.tools.")) return { calls: [] };
    if (method === "agent") return { runId: params.idempotencyKey };
    if (method === "agent.wait") return { status, error: "Retries exhausted" };
    throw Error(method);
  });
  await expect(runNativeAgent(f.input, f.options)).rejects.toMatchObject({ state: status === "error" ? "failed" : "unconfirmed" });
  expect(f.calls.filter(c => c.method === "agent")).toHaveLength(1);
  expect(f.calls.filter(c => c.method === "rakazo.tools.close")).toHaveLength(status === "error" ? 1 : 0);
});

it("reports structured blocked tools alongside the recovered reply", async () => {
  const f = fixture({ collaboration: { toolMode: "kernel", tools: [], nativeTools: [],
    execute: async () => ({}), completed: undefined, onPaused() {} } });
  f.setHandler(async (method, params) => {
    if (method.startsWith("rakazo.tools.")) return { calls: [] };
    if (method === "agent") return { runId: params.idempotencyKey };
    if (method === "agent.wait") return { status: "ok" };
    if (method === "rakazo.run.result") return { result: { text: "Analysis ready", provider: "test", model: "test", blockedTools: ["exec"] } };
    throw Error(method);
  });
  await expect(runNativeAgent(f.input, f.options)).resolves.toContain("相关步骤尚未完成");
});

it("cancels a recovering kernel run and revokes the original grant", async () => {
  const controller = new AbortController();
  let nativeId = "";
  const f = fixture({ signal: controller.signal, collaboration: {
    toolMode: "kernel", tools: [], nativeTools: [], completed: undefined,
    execute: async () => ({}), onPaused() {},
  }, onNotice(n) { if (n.text.includes("正在确认")) controller.abort(); } });
  f.setHandler(async (method, params) => {
    if (method.startsWith("rakazo.tools.")) return { calls: [] };
    if (method === "agent") {
      nativeId = params.idempotencyKey;
      f.event({ event: "agent", payload: { runId: nativeId, stream: "lifecycle", data: { phase: "error", error: "terminated" } } });
      return { runId: nativeId };
    }
    if (method === "agent.wait") return { status: "aborted" };
    if (method === "chat.abort") return { aborted: true, runIds: [nativeId] };
    throw Error(method);
  });
  await expect(runNativeAgent(f.input, f.options)).rejects.toMatchObject({ state: "cancelled" });
  expect(f.calls.filter(c => c.method === "agent")).toHaveLength(1);
  expect(f.calls.filter(c => c.method === "rakazo.tools.close")).toHaveLength(1);
});

it("reattaches an uncertain kernel run and retrieves its late result before tool polling or deadline cancellation", async () => {
  const f = fixture({ collaboration: { toolMode: "kernel", tools: [], nativeTools: [],
    execute: async () => ({}), completed() {}, onPaused() {} } });
  f.setHandler(async (method, params) => {
    if (method === "rakazo.tools.register" || method === "rakazo.tools.close") return {};
    if (method === "agent") return { runId: params.idempotencyKey };
    if (method === "agent.wait") return { status: "ok" };
    if (method === "rakazo.run.result") return { result: { text: "Late answer", provider: "test", model: "flash" } };
    throw Error(`Tool grant expired: ${method}`);
  });
  await runNativeAgent(f.input, f.options);
  const record = f.store.records.get(f.input.key)!;
  record.status = "unconfirmed";
  record.startedAt = Date.now() - 50 * 60_000;
  const resumed = await runNativeAgent({ ...f.input, message: "Clock changed to 20:50" }, f.options);
  expect(resumed).toBe("Late answer");
  expect(f.calls.filter(call => call.method === "agent")).toHaveLength(1);
  expect(f.calls.some(call => ["chat.abort", "rakazo.tools.poll"].includes(call.method))).toBe(false);
  expect(f.store.records.get(f.input.key)?.status).toBe("done");
});

describe("admitting a new task after an uncertain kernel invocation", () => {
  function blocked() {
    const f = fixture({ collaboration: { toolMode: "kernel", tools: [], nativeTools: [],
      execute: async () => ({}), completed() {}, onPaused() {} } });
    const key = JSON.stringify(["old-host-run", 0]);
    const ownerKey = `session-owner:${nativeSessionKey(f.input.scope, f.input.agentId)}`;
    const old: NativeRecord = { version: 1, runId: "old-native-run", sessionKey: nativeSessionKey(f.input.scope, f.input.agentId),
      inputHash: "old-input", startedAt: Date.now() - 1_000, status: "unconfirmed", text: "Partial old reply", toolMode: "kernel" };
    f.store.records.set(key, old);
    f.store.records.set(ownerKey, { ...old, text: "", executionKey: key });
    f.store.records.set(nativeRunIndexKey("old-host-run"), { ...old, text: "", executionKey: key });
    return { ...f, key, ownerKey, old };
  }
  it.each(["ok", "error"])("reconciles a proven terminal owner (%s) without replaying its task", async status => {
    const f = blocked();
    f.setHandler(async (method, params) => {
      if (method.startsWith("rakazo.tools.")) return { engineInstanceId: "current-engine" };
      if (method === "agent") return { runId: params.idempotencyKey };
      if (method === "agent.wait") return params.runId === f.old.runId
        ? { status, reason: status === "error" ? "engine_restarted" : undefined, error: "old controller interrupted" }
        : { status: "ok" };
      if (method === "rakazo.run.result") return { result: { text: params.runId === f.old.runId ? "Recovered old answer" : "New answer", provider: "test", model: "flash" } };
      throw Error(method);
    });
    expect(await runNativeAgent(f.input, f.options)).toBe("New answer");
    expect(f.calls.filter(c => c.method === "agent")).toHaveLength(1);
    expect(f.calls.some(c => c.method === "chat.abort")).toBe(false);
    expect(f.store.records.get(f.key)?.status).toBe(status === "ok" ? "done" : "failed");
    expect(f.store.records.get(nativeRunIndexKey("old-host-run"))?.status).toBe(status === "ok" ? "done" : "failed");
    expect(f.store.records.get(f.ownerKey)?.executionKey).toBe(f.input.key);
    expect(f.store.records.get(f.input.key)?.engineInstanceId).toBe("current-engine");
    expect(f.calls.filter(c => c.method === "rakazo.run.status").at(-1)?.params.engineInstanceId).toBe("current-engine");
  });
  it.each(["running", "unconfirmed", "unconfirmed-error", "connection-lost"])("keeps an owner blocked without terminal evidence (%s)", async status => {
    const f = blocked();
    f.setHandler(async method => {
      if (status === "connection-lost") throw Error("socket disconnected");
      if (method === "agent.wait") return status === "unconfirmed-error" ? { status: "error", unconfirmed: true } : { status };
      throw Error(`Unexpected side effect: ${method}`);
    });
    await expect(runNativeAgent(f.input, f.options)).rejects.toThrow("earlier task");
    expect(f.calls.filter(c => c.method === "agent")).toHaveLength(0);
    expect(f.store.records.get(f.ownerKey)?.runId).toBe(f.old.runId);
    expect(f.store.records.get(f.key)?.text).toBe("Partial old reply");
  });
  it("does not release a restarted invocation with an unverified background command", async () => {
    const f = blocked(); f.old.backgroundProcesses = ["background-command"];
    f.store.records.set(f.key, f.old);
    f.setHandler(async method => {
      if (method === "agent.wait") return { status: "error", reason: "engine_restarted" };
      if (method === "rakazo.process.control") throw Error("Native process ownership is not confirmed");
      throw Error(`Unexpected side effect: ${method}`);
    });
    await expect(runNativeAgent(f.input, f.options)).rejects.toThrow("earlier task");
    expect(f.store.records.get(f.ownerKey)?.status).toBe("unconfirmed");
    expect(f.calls.filter(c => c.method === "agent")).toHaveLength(0);
  });
  function timedOut() {
    const f = blocked();
    f.old.startedAt = Date.now() - 31 * 60_000;
    f.store.records.set(f.key, f.old);
    f.store.records.set(f.ownerKey, { ...f.old, text: "", executionKey: f.key });
    return f;
  }
  it("keeps a timed-out task occupied after an abort acknowledgement without termination", async () => {
    const f = timedOut();
    f.setHandler(async method => {
      if (method === "chat.abort") return { aborted: true, runIds: [f.old.runId] };
      if (method === "agent.wait") return { status: "running" };
      throw Error(`Unexpected dispatch: ${method}`);
    });
    await expect(runNativeAgent(f.input, f.options)).rejects.toThrow("earlier task");
    expect(f.calls.some(c => c.method === "chat.abort")).toBe(true);
    expect(f.calls.filter(c => c.method === "agent")).toHaveLength(0);
    expect(f.store.records.get(f.key)?.text).toBe("Partial old reply");
    expect(f.store.records.get(f.ownerKey)?.runId).toBe(f.old.runId);
  });
  it("admits the next task after cancellation reaches a terminal receipt", async () => {
    const f = timedOut();
    let stopped = false;
    f.setHandler(async (method, params) => {
      if (method.startsWith("rakazo.tools.")) return { engineInstanceId: "current-engine" };
      if (method === "chat.abort") { stopped = true; return { aborted: true, runIds: [f.old.runId] }; }
      if (method === "agent.wait") return { status: params.runId === f.old.runId ? stopped ? "aborted" : "running" : "ok" };
      if (method === "agent") return { runId: params.idempotencyKey };
      if (method === "rakazo.run.result") return { result: { text: "New answer", provider: "test", model: "test" } };
      throw Error(method);
    });
    expect(await runNativeAgent(f.input, f.options)).toBe("New answer");
    expect(f.store.records.get(f.key)?.status).toBe("cancelled");
    expect(f.store.records.get(f.key)?.text).toBe("Partial old reply");
    expect(f.calls.filter(c => c.method === "agent")).toHaveLength(1);
  });
  it("preserves a timed-out task and its process handles when the engine cannot be reached", async () => {
    const f = timedOut();
    f.old.backgroundProcesses = ["still-owned"];
    f.store.records.set(f.key, f.old);
    f.setHandler(async method => { throw Error(`socket disconnected: ${method}`); });
    await expect(runNativeAgent(f.input, f.options)).rejects.toThrow("earlier task");
    expect(f.calls.filter(c => c.method === "agent")).toHaveLength(0);
    expect(f.store.records.get(f.key)).toEqual(f.old);
    expect(f.store.records.get(f.ownerKey)?.runId).toBe(f.old.runId);
  });
});
