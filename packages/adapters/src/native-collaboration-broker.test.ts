import { describe, expect, it } from "vitest";
import { NativeCollaborationBroker } from "./native-collaboration-broker.js";
import openclawPlugin from "./native-collaboration-openclaw.js";

const sessionKey = `agent:main:rakazo:${"a".repeat(64)}`;
const runId = `rakazo-${"b".repeat(64)}`;
const tools = [
  {
    name: "message_bot",
    description: "Message a teammate",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
];
const call = { id: "call-1", name: "message_bot", args: { message: "hello" } };
const identity = { sessionKey, runId };

describe("native collaboration broker", () => {
  it("sums measured model calls without tool wait time, duplicate callbacks or another run's timing", () => {
    const broker = new NativeCollaborationBroker();
    broker.register({ ...identity, toolMode: "kernel", tools: [] });
    broker.observeResult({ runId, provider: "test", model: "flash", usage: { total: 150 },
      lastAssistant: { role: "assistant", content: [{ type: "text", text: "Done" }] } }, identity);
    const first = { runId, callId: "first", durationMs: 3000, timeToFirstByteMs: 1000, outcome: "completed" };
    broker.observeModelCall(first, identity);
    broker.observeModelCall(first, identity);
    broker.observeModelCall({ ...first, callId: "second", durationMs: 5000, timeToFirstByteMs: 2000 }, identity);
    broker.observeModelCall({ ...first, callId: "other", runId: "other" }, identity);
    expect(broker.result(identity).result?.usage).toEqual({
      total: 150, modelDurationMs: 8000, generationDurationMs: 5000,
    });
    broker.observeModelCall({ runId, callId: "unknown-first-byte", durationMs: 100, outcome: "completed" }, identity);
    expect(broker.result(identity).result?.usage).toEqual({ total: 150, modelDurationMs: 8100 });
    broker.close(identity);
    broker.observeModelCall(first, identity);
    expect(broker.result(identity).result).not.toBeNull();
  });
  it("correlates final output and usage to the trusted active run, excluding later background replies", () => {
    const broker = new NativeCollaborationBroker();
    broker.register({ ...identity, toolMode: "kernel", tools: [] });
    const event = {
      runId, provider: "test", model: "flash", usage: { input: 100, output: 10 },
      lastAssistant: { role: "assistant", content: [{ type: "text", text: "Task answer" }] },
    };
    broker.observeResult(event, identity);
    const other = `rakazo-${"c".repeat(64)}`;
    broker.observeResult({ ...event, runId: other,
      lastAssistant: { role: "assistant", content: [{ type: "text", text: "Background receipt" }] } },
    { sessionKey, runId: other });
    expect(broker.result(identity)).toEqual({
      result: { text: "Task answer", provider: "test", model: "flash", usage: { input: 100, output: 10 } },
    });
    expect(() => broker.result({ sessionKey, runId: other })).toThrow();
    broker.close(identity);
    expect(broker.result(identity).result).not.toBeNull();
  });
  it("restricts native tools and refuses unknown, closed, expired or lost kernel grants", () => {
    let now = 0;
    const broker = new NativeCollaborationBroker(() => now);
    expect(broker.nativeToolDecision(sessionKey, "exec")).toMatchObject({ block: true });
    broker.register({ ...identity, toolMode: "kernel", tools, nativeTools: ["read"] });
    expect(broker.nativeToolDecision(sessionKey, "read")).toBeUndefined();
    expect(broker.nativeToolDecision(sessionKey, "message_bot")).toBeUndefined();
    for (const name of ["exec", "write", "sessions_send", "cron"])
      expect(broker.nativeToolDecision(sessionKey, name)).toMatchObject({ block: true });
    expect(() => broker.register({
      ...identity, toolMode: "kernel", tools, nativeTools: ["read", "exec"],
    })).toThrow("cannot change");
    now = 31 * 60_000;
    expect(broker.nativeToolDecision(sessionKey, "read")).toMatchObject({ block: true });
    expect(broker.nativeToolDecision("agent:main:default", "exec")).toBeUndefined();
    expect(new NativeCollaborationBroker().nativeToolDecision(sessionKey, "read"))
      .toMatchObject({ block: true });
  });
  it("allows scoped product actions only in kernel mode and keeps shell execution native", async () => {
    const broker = new NativeCollaborationBroker();
    const taskTool = { ...tools[0], name: "schedule_create" };
    expect(() => broker.register({ ...identity, tools: [taskTool] })).toThrow();
    expect(() => broker.register({ ...identity, toolMode: "kernel", tools: [{ ...taskTool, name: "shell" }] })).toThrow();
    broker.register({ ...identity, toolMode: "kernel", tools: [taskTool] });
    const pending = broker.call(sessionKey, runId, { ...call, name: "schedule_create" });
    await expect(broker.call(sessionKey, runId, call)).rejects.toThrow();
    expect(broker.poll(identity).calls[0]!.name).toBe("schedule_create");
    broker.resolve({ ...identity, id: call.id, result: { scheduled: true } });
    await expect(pending).resolves.toEqual({ scheduled: true });
    broker.close(identity);
  });
  it("binds grants to a native LivingBot session and restricts the tool catalog", () => {
    const broker = new NativeCollaborationBroker();
    expect(() =>
      broker.register({ ...identity, tools: [{ ...tools[0], name: "shell" }] }),
    ).toThrow();
    expect(() =>
      broker.register({ ...identity, sessionKey: "agent:main:default", tools }),
    ).toThrow();
    broker.register({ ...identity, tools });
    expect(broker.tools(sessionKey)).toEqual({ runId, tools });
    expect(broker.tools("other").tools).toEqual([]);
    expect(() =>
      broker.register({ ...identity, runId: `rakazo-${"c".repeat(64)}`, tools }),
    ).toThrow();
    expect(() => broker.register({ ...identity, tools: [] })).toThrow();
  });
  it("delivers a call only to its owning run, and returns the real result", async () => {
    const broker = new NativeCollaborationBroker();
    const grant = broker.register({ ...identity, tools });
    expect(() => broker.client({ ...identity, clientToken: "bad" })).toThrow();
    expect(broker.client({ ...identity, ...grant }).runId).toBe(runId);
    const pending = broker.call(sessionKey, runId, call);
    expect(() => broker.poll({ ...identity, runId: "other" })).toThrow();
    expect(broker.poll(identity).calls).toEqual([call]);
    broker.resolve({ ...identity, id: call.id, result: { delivered: true } });
    await expect(pending).resolves.toEqual({ delivered: true });
    expect(broker.poll(identity).calls).toEqual([]);
    await expect(broker.call(sessionKey, runId, call)).resolves.toEqual({ delivered: true });
  });
  it("deduplicates concurrent retries and refuses changed arguments or results", async () => {
    const broker = new NativeCollaborationBroker();
    broker.register({ ...identity, tools });
    const first = broker.call(sessionKey, runId, call);
    const second = broker.call(sessionKey, runId, structuredClone(call));
    await expect(
      broker.call(sessionKey, runId, { ...call, args: { message: "different" } }),
    ).rejects.toThrow();
    expect(broker.poll(identity).calls).toHaveLength(1);
    broker.resolve({ ...identity, id: call.id, result: { ok: true } });
    expect(() => broker.resolve({ ...identity, id: call.id, result: { ok: false } })).toThrow();
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
  });
  it("keeps an unanswered call across worker reconnects and revokes it on close", async () => {
    const broker = new NativeCollaborationBroker();
    const grant = broker.register({ ...identity, tools });
    const pending = broker.call(sessionKey, runId, call);
    expect(broker.register({ ...identity, tools })).toEqual(grant);
    expect(broker.poll(identity).calls).toEqual([call]);
    broker.close({ ...identity, runId: "other" });
    expect(broker.poll(identity).calls).toHaveLength(1);
    broker.close(identity);
    await expect(pending).resolves.toHaveProperty("error");
    await expect(broker.call(sessionKey, runId, call)).rejects.toThrow();
  });
  it("expires grants and rejects stale native tool closures", async () => {
    let now = 0;
    const broker = new NativeCollaborationBroker(() => now);
    broker.register({ ...identity, tools });
    const pending = broker.call(sessionKey, runId, call);
    now = 31 * 60_000;
    expect(() => broker.poll(identity)).toThrow();
    await expect(pending).resolves.toHaveProperty("error");
    expect(broker.tools(sessionKey).tools).toEqual([]);
  });
  it("rejects unoffered tools, oversized arguments and malformed call ids", async () => {
    const broker = new NativeCollaborationBroker();
    broker.register({ ...identity, tools });
    for (const invalid of [
      { ...call, name: "shell" },
      { ...call, id: "" },
      { ...call, args: { message: "x".repeat(128_001) } },
    ])
      await expect(broker.call(sessionKey, runId, invalid)).rejects.toThrow();
  });
  it("removes a native-cancelled call before the LivingBot executor can run it", async () => {
    const broker = new NativeCollaborationBroker();
    broker.register({ ...identity, tools });
    const pending = broker.call(sessionKey, runId, call);
    broker.cancel(sessionKey, runId, call.id);
    expect(broker.poll(identity).calls).toEqual([]);
    await expect(pending).resolves.toHaveProperty(
      "error",
      "Native collaboration tool call cancelled",
    );
    await expect(broker.call(sessionKey, runId, call)).resolves.toHaveProperty("error");
  });
});

describe("OpenClaw plugin boundary", () => {
  it("enforces native capabilities through the installed extension's supported tool hook", () => {
    const methods = new Map<string, (args: any) => void>();
    const hooks = new Map<string, any>();
    openclawPlugin.register({
      on(name, handler) { hooks.set(name, handler); },
      registerGatewayMethod(name, handler) { methods.set(name, handler); },
      registerTool() {},
    });
    const invoke = (method: string, params: Record<string, unknown>) =>
      methods.get(`rakazo.tools.${method}`)!({ params, respond(ok: boolean) { expect(ok).toBe(true); } });
    const before = hooks.get("before_tool_call");
    expect(before({ toolName: "read" }, { sessionKey })).toHaveProperty("block", true);
    invoke("register", { ...identity, toolMode: "kernel", tools: [], nativeTools: ["read"] });
    expect(before({ toolName: "read" }, { sessionKey })).toBeUndefined();
    expect(before({ toolName: "exec" }, { sessionKey })).toHaveProperty("block", true);
    expect(before({ toolName: "exec" }, { sessionKey: "agent:main:main" })).toBeUndefined();
    invoke("close", identity);
    expect(before({ toolName: "read" }, { sessionKey })).toHaveProperty("block", true);
  });
  it("exposes tools only in the registered trusted session and completes through the gateway", async () => {
    const methods = new Map<string, (args: any) => void>();
    let factory: (context: { sessionKey?: string }) => any;
    openclawPlugin.register({
      registerGatewayMethod(name, handler, options) {
        expect(options.scope).toBe("operator.write");
        methods.set(name, handler);
      },
      registerTool(value) {
        factory = value;
      },
    });
    const rpc = (method: string, params: Record<string, unknown>) => {
      let result: any;
      methods.get(`rakazo.tools.${method}`)!({
        params,
        respond(ok: boolean, payload: any) {
          expect(ok).toBe(true);
          result = payload;
        },
      });
      return result;
    };
    expect(factory!({})).toBeNull();
    expect(factory!({ sessionKey: "agent:main:default" })).toEqual([]);
    rpc("register", { ...identity, tools });
    // Native gateway and tool-discovery registries register the plugin independently.
    openclawPlugin.register({
      registerGatewayMethod() {},
      registerTool(value) {
        factory = value;
      },
    });
    const nativeTool = factory!({ sessionKey })[0];
    const pending = nativeTool.execute(call.id, call.args);
    expect(rpc("poll", identity).calls).toEqual([call]);
    rpc("resolve", { ...identity, id: call.id, result: { delivered: true } });
    await expect(pending).resolves.toMatchObject({ details: { delivered: true } });
    rpc("close", identity);
    await expect(nativeTool.execute("stale", call.args)).rejects.toThrow();
    rpc("register", { ...identity, tools });
    const controller = new AbortController();
    const cancellableTool = factory!({ sessionKey })[0];
    const cancelled = cancellableTool.execute("cancelled", call.args, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    expect(rpc("poll", identity).calls).toEqual([]);
    rpc("close", identity);
  });
});

it("uses the command receipt instead of an intermediate model lifecycle error", () => {
  const methods = new Map<string, (args: any) => void>();
  openclawPlugin.register({ registerGatewayMethod(name, handler) { methods.set(name, handler); }, registerTool() {} });
  const invoke = (name: string, params: any, context?: any) => {
    let payload: any;
    methods.get(name)!({ params, context, respond(ok: boolean, value: any) { expect(ok).toBe(true); payload = value; } });
    return payload;
  };
  invoke("rakazo.tools.register", { ...identity, toolMode: "kernel", tools: [], nativeTools: [] });
  const context = { dedupe: new Map(), chatAbortControllers: new Map([[runId, {}]]) };
  context.dedupe.set(`agent:${runId}`, { payload: { runId, status: "accepted" } });
  expect(invoke("rakazo.run.status", identity, context)).toEqual({ status: "running" });
  context.dedupe.set(`agent:${runId}`, { payload: { runId, status: "ok", summary: "completed" } });
  expect(invoke("rakazo.run.status", identity, context)).toMatchObject({ status: "ok" });
  context.dedupe.set(`agent:${runId}`, { payload: { runId, status: "error", summary: "Retries exhausted" } });
  expect(invoke("rakazo.run.status", identity, context)).toMatchObject({ status: "error", error: "Retries exhausted" });
  context.dedupe.clear(); context.chatAbortControllers.clear();
  expect(invoke("rakazo.run.status", identity, context)).toEqual({ status: "unconfirmed" });
  expect(invoke("rakazo.run.status", { ...identity, runId: "unrelated" }, context)).toEqual({ status: "unconfirmed" });
  invoke("rakazo.tools.close", identity);
});

 it("keeps read-only results after expiry, late completion, close and a new run, without renewing tools", () => {
  let now = 0;
  const broker = new NativeCollaborationBroker(() => now);
  broker.register({ ...identity, toolMode: "kernel", tools: [], nativeTools: ["read"] });
  now = 31 * 60_000;
  expect(broker.nativeToolDecision(sessionKey, "read")).toHaveProperty("block", true);
  broker.observeResult({ runId, provider: "test", model: "flash",
    lastAssistant: { role: "assistant", content: [{ type: "text", text: "Late answer" }] } }, identity);
  expect(broker.result(identity).result?.text).toBe("Late answer");
  expect(() => broker.poll(identity)).toThrow();
  broker.register({ ...identity, toolMode: "kernel", tools: [] });
  expect(broker.result(identity).result?.text).toBe("Late answer");
  broker.close(identity);
  broker.register({ ...identity, runId: `rakazo-${"c".repeat(64)}`, tools: [] });
  expect(broker.result(identity).result?.text).toBe("Late answer");
  expect(() => broker.result({ ...identity, sessionKey: sessionKey.replace("main", "other") })).toThrow();
  broker.close({ sessionKey, runId: `rakazo-${"c".repeat(64)}` });
});

it("recognizes a previous engine instance without inferring success or replaying a task", () => {
  const methods = new Map<string, (args: any) => void>();
  openclawPlugin.register({ registerGatewayMethod(name, handler) { methods.set(name, handler); }, registerTool() {} });
  const invoke = (method: string, params: any, context?: any) => {
    let result: any;
    methods.get(method)!({ params, context, respond(ok: boolean, value: any) { expect(ok).toBe(true); result = value; } });
    return result;
  };
  const other = { sessionKey: `agent:other:rakazo:${"d".repeat(64)}`, runId: `rakazo-${"e".repeat(64)}` };
  const context = { dedupe: new Map(), chatAbortControllers: new Map() };
  expect(invoke("rakazo.run.status", { ...other, startedAt: 1 }, context))
    .toMatchObject({ status: "error", reason: "engine_restarted" });
  const registration = invoke("rakazo.tools.register", { ...other, toolMode: "kernel", tools: [], nativeTools: [] });
  expect(registration.engineInstanceId).toEqual(expect.any(String));
  expect(invoke("rakazo.run.status", { ...other, startedAt: 1, engineInstanceId: registration.engineInstanceId }, context))
    .toEqual({ status: "unconfirmed" });
  expect(invoke("rakazo.run.status", { ...other, engineInstanceId: "previous-process" }, context))
    .toMatchObject({ status: "error", reason: "engine_restarted" });
  context.chatAbortControllers.set(other.runId, { sessionKey: other.sessionKey });
  expect(invoke("rakazo.run.status", { ...other, engineInstanceId: "previous-process" }, context))
    .toEqual({ status: "running" });
  context.chatAbortControllers.clear();
  context.chatAbortControllers.set("another-run", { sessionKey: other.sessionKey });
  expect(invoke("rakazo.run.status", { ...other, startedAt: 1 }, context)).toEqual({ status: "unconfirmed" });
  expect(invoke("rakazo.run.status", { ...other, startedAt: 1 })).toEqual({ status: "unconfirmed" });
  expect(invoke("rakazo.run.status", { ...other, runId: "invalid", startedAt: 1 }, context)).toEqual({ status: "unconfirmed" });
  invoke("rakazo.tools.close", other);
});
