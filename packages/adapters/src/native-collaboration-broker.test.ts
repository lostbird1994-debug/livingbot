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
  it("binds grants to a native Rakazo session and restricts the tool catalog", () => {
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
  it("removes a native-cancelled call before the Rakazo executor can run it", async () => {
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
