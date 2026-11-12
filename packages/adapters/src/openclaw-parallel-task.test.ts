import { expect, it } from "vitest";
import type { NativeInput, NativeOptions, NativeRecord, NativeStore } from "./openclaw-native-driver.js";
import { nativeSessionKey, runNativeAgent } from "./openclaw-native-driver.js";
import { NativeCollaborationBroker } from "./native-collaboration-broker.js";

it("overlaps two threads of one agent, cancels only A and recovers B without redispatch", async () => {
  const records = new Map<string, NativeRecord>();
  const store: NativeStore = {
    async read(key) { return structuredClone(records.get(key)); },
    async write(key, record) { records.set(key, structuredClone(record)); },
  };
  const states = new Map<string, string>();
  const sessions = new Map<string, string>();
  const calls: Array<{ method: string; params: any }> = [];
  let started!: () => void;
  const bothStarted = new Promise<void>(resolve => { started = resolve; });
  const options: NativeOptions = { store, pollMs: 1, cancelMs: 100, runMs: 5000,
    async connect() { return {
      async request(method, params: any): Promise<any> {
        calls.push({ method, params });
        if (method === "agent") {
          states.set(params.idempotencyKey, "running");
          sessions.set(params.sessionKey, params.idempotencyKey);
          if (states.size === 2) started();
          return { runId: params.idempotencyKey, status: "accepted" };
        }
        if (method === "chat.abort") {
          const id = params.runId ?? sessions.get(params.sessionKey);
          states.set(id, "aborted");
          return { aborted: true, runIds: [id] };
        }
        if (method === "agent.wait" || method === "rakazo.run.status") {
          await new Promise(resolve => setTimeout(resolve, 1));
          const state = states.get(params.runId);
          return { status: state === "running" ? "timeout" : state,
            ...(state === "aborted" ? { stopReason: "aborted" } : {}) };
        }
        if (method === "chat.history") return { messages: [{ role: "assistant", timestamp: Date.now(),
          content: [{ type: "text", text: "B result" }] }] };
        throw Error(method);
      }, stop() {},
    }; },
  };
  const a = new AbortController();
  const first: NativeInput = { key: "task-a/0", scope: "space/user/bot/thread-a", agentId: "same-bot",
    message: "Synthetic A", instructions: "No tools", signal: a.signal };
  const second: NativeInput = { ...first, key: "task-b/0", scope: "space/user/bot/thread-b", signal: undefined };
  const resultA = runNativeAgent(first, options).then(value => ({ value }), error => ({ error }));
  const resultB = runNativeAgent(second, options);
  await bothStarted;
  expect([...states.values()]).toEqual(["running", "running"]);
  expect([...sessions.keys()]).toHaveLength(2);
  a.abort();
  expect(await resultA).toHaveProperty("error");
  const idB = sessions.get(nativeSessionKey(second.scope, second.agentId))!;
  expect(states.get(idB)).toBe("running");
  states.set(idB, "ok");
  expect(await resultB).toBe("B result");
  expect(await runNativeAgent(second, options)).toBe("B result");
  expect(calls.filter(call => call.method === "agent")).toHaveLength(2);
  expect(calls.filter(call => call.method === "chat.abort")).toHaveLength(1);
  expect(records.get(first.key)?.status).toBe("cancelled");
  expect(records.get(second.key)?.status).toBe("done");
});

it("keeps session tool permissions, pending calls and final receipts independent", async () => {
  const broker = new NativeCollaborationBroker();
  const a = { sessionKey: nativeSessionKey("space/user/bot/thread-a", "same-bot"), runId: `rakazo-${"a".repeat(64)}` };
  const b = { sessionKey: nativeSessionKey("space/user/bot/thread-b", "same-bot"), runId: `rakazo-${"b".repeat(64)}` };
  broker.register({ ...a, toolMode: "kernel", tools: [], nativeTools: ["read"] });
  broker.register({ ...b, toolMode: "kernel", tools: [], nativeTools: ["web_search"] });
  broker.observeResult({ runId: a.runId, provider: "test", model: "flash", usage: { total: 1 }, lastAssistant: { role: "assistant", content: [{ type: "text", text: "A" }] } }, a);
  broker.observeResult({ runId: b.runId, provider: "test", model: "flash", usage: { total: 1 }, lastAssistant: { role: "assistant", content: [{ type: "text", text: "B" }] } }, b);
  broker.close(a);
  expect(broker.result(a).result?.text).toBe("A");
  expect(broker.result(b).result?.text).toBe("B");
  expect(() => broker.result({ ...b, sessionKey: a.sessionKey })).toThrow();
});
