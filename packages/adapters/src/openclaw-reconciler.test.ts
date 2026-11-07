import { describe, expect, it, vi } from "vitest";
import { createOpenClawReconciler, reconcileNativeExecution } from "./openclaw-reconciler.js";
import type { NativeRecord, NativeStore, NativePeer } from "./openclaw-native-driver.js";
import type { ExecutorDeps } from "./executor-deps.js";
class Store implements NativeStore {
  rows = new Map<string, NativeRecord>();
  async read(key: string) {
    return structuredClone(this.rows.get(key));
  }
  async write(key: string, row: NativeRecord) {
    this.rows.set(key, structuredClone(row));
  }
}
function fixture() {
  const record: NativeRecord = {
    version: 1,
    runId: "native",
    sessionKey: "agent:main:rakazo:test",
    inputHash: "input",
    startedAt: 1,
    status: "approval",
    text: "",
    gatewayOrigin: "ws://127.0.0.1:18789",
    approval: {
      id: "a",
      expiresAtMs: Date.now() + 60000,
      command: "cmd",
      decisions: ["deny", "allow-once"],
    },
  };
  const store = new Store();
  store.rows.set("key", record);
  store.rows.set(`session-owner:${record.sessionKey}`, record);
  const calls: string[] = [];
  let status = "aborted";
  const peer: NativePeer = {
    request: async <T>(method: string): Promise<T> => {
      calls.push(method);
      return (
        method === "agent.wait"
          ? { status }
          : method === "chat.history"
            ? {
                messages: [
                  {
                    role: "assistant",
                    timestamp: Date.now(),
                    content: [
                      { type: "text", text: "READY" },
                      { type: "text", text: "_OK" },
                    ],
                  },
                ],
              }
            : { aborted: true }
      ) as T;
    },
    stop: vi.fn(),
  };
  return {
    record,
    store,
    peer,
    calls,
    status: (value: string) => {
      status = value;
    },
  };
}
describe("durable native cancellation reconciliation", () => {
  it.each(["timeout", "unexpected"])(
    "does not mistake an abort ACK for termination (%s)",
    async (state) => {
      const f = fixture();
      f.status(state);
      expect(await reconcileNativeExecution({ ...f, key: "key", cancel: true })).toBe(
        "unconfirmed",
      );
      expect(f.store.rows.get("key")?.status).toBe("unconfirmed");
      expect(f.calls).toEqual(["chat.abort", "agent.wait"]);
    },
  );
  it("confirms a cancelled paused approval and releases its session guard", async () => {
    const f = fixture();
    expect(await reconcileNativeExecution({ ...f, key: "key", cancel: true })).toBe("cancelled");
    expect(f.store.rows.get(`session-owner:${f.record.sessionKey}`)?.status).toBe("cancelled");
  });
  it("recovers canonical results without dispatch or implicit approval", async () => {
    const f = fixture();
    f.status("ok");
    expect(await reconcileNativeExecution({ ...f, key: "key", cancel: false })).toBe("done");
    expect(f.store.rows.get("key")?.text).toBe("READY_OK");
    expect(f.calls).toEqual(["agent.wait", "chat.history"]);
  });
  it("does not overwrite a newer session owner's identity", async () => {
    const f = fixture();
    f.store.rows.set(`session-owner:${f.record.sessionKey}`, { ...f.record, runId: "newer" });
    await reconcileNativeExecution({ ...f, key: "key", cancel: true });
    expect(f.store.rows.get(`session-owner:${f.record.sessionKey}`)?.runId).toBe("newer");
  });
  function scheduled(status: string) {
    const f = fixture();
    const key = JSON.stringify(["rakazo-run", 0]);
    f.store.rows.set(key, f.record);
    const run = {
      id: "rakazo-run",
      userId: "owner",
      spaceId: "space",
      status,
      error: null,
      modelId: "openclaw/default",
    };
    const update = vi.fn().mockResolvedValue({ count: 1 });
    const findMany = vi.fn().mockResolvedValue([run]);
    const deps = { prisma: { run: { findMany, updateMany: update } } } as unknown as ExecutorDeps;
    const connect = vi.fn().mockResolvedValue(f.peer);
    const resolveModel = vi.fn().mockResolvedValue({
      provider: "openai-compatible",
      id: "openclaw/default",
      baseUrl: "http://127.0.0.1:18789/v1",
      apiKey: "test-secret",
      allowPrivateEndpoint: true,
    });
    return { ...f, deps, connect, resolveModel, update, findMany };
  }
  it("finds cancelled approval work after restart and confirms it through the native peer", async () => {
    const f = scheduled("cancelled");
    await createOpenClawReconciler(f.deps, {
      store: f.store,
      connect: f.connect,
      resolveModel: f.resolveModel,
    })();
    expect(f.calls).toEqual(["chat.abort", "agent.wait"]);
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "owner", spaceId: "space", status: "cancelled" }),
        data: expect.objectContaining({ error: expect.stringContaining("已结束") }),
      }),
    );
    expect(f.peer.stop).toHaveBeenCalled();
  });
  it("leaves an unexpired approval waiting for its owner without reconnecting", async () => {
    const f = scheduled("waiting_input");
    await createOpenClawReconciler(f.deps, {
      store: f.store,
      connect: f.connect,
      resolveModel: f.resolveModel,
    })();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.resolveModel).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  });
  it("does not send a cancellation to a changed gateway", async () => {
    const f = scheduled("cancelled");
    f.record.gatewayOrigin = "ws://127.0.0.1:9999";
    await createOpenClawReconciler(f.deps, {
      store: f.store,
      connect: f.connect,
      resolveModel: f.resolveModel,
    })();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { error: expect.stringContaining("未确认") } }),
    );
  });
});

it("does not treat an unconfirmed status response as a terminal error", async () => {
  const row: NativeRecord = {
    version: 1,
    runId: "native",
    sessionKey: "s",
    inputHash: "h",
    startedAt: 1,
    status: "unconfirmed",
    text: "",
  };
  const store = new Store();
  store.rows.set("key", row);
  store.rows.set("session-owner:s", row);
  const peer: NativePeer = {
    request: async <T>() => ({ status: "error", unconfirmed: true }) as T,
    stop: () => {},
  };
  expect(
    await reconcileNativeExecution({ key: "key", record: row, cancel: false, store, peer }),
  ).toBe("unconfirmed");
  expect(store.rows.get("session-owner:s")?.status).toBe("unconfirmed");
});
