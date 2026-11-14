import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import type { NativePeer, NativeRecord, NativeStore } from "./openclaw-native-driver.js";
import { nativeRunIndexKey } from "./openclaw-native-driver.js";
import { createOpenClawReconciler, reconcileNativeExecution } from "./openclaw-reconciler.js";

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
  it("kills and verifies owned background commands before releasing a cancelled session", async () => {
    const f = fixture();
    f.record.backgroundProcesses = ["owned-process"];
    const actions: string[] = [];
    const peer: NativePeer = {
      async request<T>(method: string, params: any) {
        if (method === "chat.abort") return { aborted: true, runIds: [f.record.runId] } as T;
        if (method === "rakazo.process.control") {
          actions.push(params.action);
          expect(params).toMatchObject({
            sessionId: "owned-process",
            sessionKey: f.record.sessionKey,
            runId: f.record.runId,
          });
          return { status: params.action === "poll" ? "failed" : "running" } as T;
        }
        if (method === "agent.wait") return { status: "aborted" } as T;
        throw new Error(method);
      },
      stop() {},
    };
    expect(await reconcileNativeExecution({ ...f, peer, key: "key", cancel: true })).toBe(
      "cancelled",
    );
    expect(actions).toEqual(["kill", "poll"]);
    expect(f.store.rows.get("key")?.backgroundProcesses).toEqual([]);
  });
  it("does not release the session when background process control cannot confirm ownership", async () => {
    const f = fixture();
    f.record.backgroundProcesses = ["unconfirmed-process"];
    const peer: NativePeer = {
      async request<T>(method: string) {
        if (method === "chat.abort") return { aborted: true, runIds: [f.record.runId] } as T;
        throw new Error("Native process ownership is not confirmed");
      },
      stop() {},
    };
    await expect(
      reconcileNativeExecution({ ...f, peer, key: "key", cancel: true }),
    ).rejects.toThrow("ownership");
    expect(f.store.rows.get(`session-owner:${f.record.sessionKey}`)?.status).toBe("approval");
  });
  it.each(["timeout", "unexpected"])(
    "does not mistake an abort ACK for termination (%s)",
    async (state) => {
      const f = fixture();
      f.status(state);
      expect(await reconcileNativeExecution({ ...f, key: "key", cancel: true })).toBe(
        "unconfirmed",
      );
      expect(f.store.rows.get("key")?.status).toBe("approval");
      expect(f.calls).toEqual(["chat.abort", "agent.wait"]);
    },
  );
  it("confirms a cancelled paused approval and releases its session guard", async () => {
    const f = fixture();
    expect(await reconcileNativeExecution({ ...f, key: "key", cancel: true })).toBe("cancelled");
    expect(f.store.rows.get(`session-owner:${f.record.sessionKey}`)?.status).toBe("cancelled");
  });
  it("preserves the original execution error after confirming cancellation", async () => {
    const f = fixture();
    f.record.error =
      "External task exceeded its execution deadline\nNative process ownership is not confirmed";
    expect(await reconcileNativeExecution({ ...f, key: "key", cancel: false })).toBe("cancelled");
    expect(f.store.rows.get("key")?.error).toBe(f.record.error);
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
  it("cancels the active continuation instead of a completed first invocation", async () => {
    const f = scheduled("cancelled");
    const first = JSON.stringify(["rakazo-run", 0]);
    const next = JSON.stringify(["rakazo-run", 1]);
    f.store.rows.set(first, { ...f.record, status: "done" });
    f.store.rows.set(next, f.record);
    f.store.rows.set(nativeRunIndexKey("rakazo-run"), { ...f.record, executionKey: next });
    await createOpenClawReconciler(f.deps, {
      store: f.store,
      connect: f.connect,
      resolveModel: f.resolveModel,
    })();
    expect(f.calls).toEqual(["chat.abort", "agent.wait"]);
    expect(f.store.rows.get(next)?.status).toBe("cancelled");
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
      expect.objectContaining({
        // The unresolved stop stays visible: it is the user's retry entry. A finished run
        // no longer blocks computer admission, so keeping it cannot freeze the queue.
        data: { error: expect.stringContaining("未确认"), resourceWaitReason: "unconfirmed" },
      }),
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

it("recovers kernel results by run identity without consulting the lifecycle cache or session history", async () => {
  const f = fixture();
  f.record.toolMode = "kernel";
  const calls: string[] = [];
  const peer: NativePeer = {
    stop() {},
    request: async <T>(method: string): Promise<T> => {
      calls.push(method);
      if (method === "rakazo.run.status") return { status: "ok" } as T;
      if (method === "rakazo.run.result")
        return { result: { text: "Recovered reply", provider: "test", model: "test" } } as T;
      if (method === "rakazo.tools.close") return {} as T;
      throw Error(method);
    },
  };
  await expect(
    reconcileNativeExecution({ key: "key", record: f.record, store: f.store, peer, cancel: false }),
  ).resolves.toBe("done");
  expect((await f.store.read("key"))?.text).toBe("Recovered reply");
  expect(calls).toEqual(["rakazo.run.status", "rakazo.run.result", "rakazo.tools.close"]);
});

it("releases a permission-interrupted kernel session only after a terminal receipt, without replay", async () => {
  const f = fixture();
  f.record.status = "unconfirmed";
  f.record.toolMode = "kernel";
  f.record.error = "missing scope: operator.admin";
  f.store.rows.set("key", f.record);
  f.store.rows.set(`session-owner:${f.record.sessionKey}`, f.record);
  const calls: string[] = [];
  const peer: NativePeer = {
    async request<T>(method: string) {
      calls.push(method);
      if (method === "chat.abort") return { aborted: true, runIds: [f.record.runId] } as T;
      if (method === "rakazo.run.status") return { status: "aborted" } as T;
      if (method === "rakazo.tools.close") return {} as T;
      throw Error(`Unexpected dispatch: ${method}`);
    },
    stop() {},
  };
  expect(await reconcileNativeExecution({ ...f, peer, key: "key", cancel: true })).toBe(
    "cancelled",
  );
  expect(f.store.rows.get(`session-owner:${f.record.sessionKey}`)?.status).toBe("cancelled");
  expect(calls).toEqual(["chat.abort", "rakazo.run.status", "rakazo.tools.close"]);
});

it("settles a restarted invocation and its indexes without replay or claiming success", async () => {
  const f = fixture();
  f.record.toolMode = "kernel";
  f.record.status = "unconfirmed";
  f.record.engineInstanceId = "previous-engine";
  const key = JSON.stringify(["old-run", 0]);
  f.store.rows.set(key, f.record);
  f.store.rows.set(nativeRunIndexKey("old-run"), { ...f.record, executionKey: key });
  const requests: Array<{ method: string; params: any }> = [];
  const peer: NativePeer = {
    stop() {},
    async request<T>(method: string, params: any) {
      requests.push({ method, params });
      if (method === "rakazo.run.status")
        return {
          status: "error",
          reason: "engine_restarted",
          error: "Interrupted after engine restart",
        } as T;
      if (method === "rakazo.tools.close") return {} as T;
      throw Error(`Unexpected side effect: ${method}`);
    },
  };
  expect(
    await reconcileNativeExecution({ key, record: f.record, cancel: false, store: f.store, peer }),
  ).toBe("failed");
  expect(requests[0]?.params).toMatchObject({ startedAt: 1, engineInstanceId: "previous-engine" });
  expect(f.store.rows.get(key)).toMatchObject({
    status: "failed",
    error: "Interrupted after engine restart",
  });
  expect(f.store.rows.get(nativeRunIndexKey("old-run"))?.status).toBe("failed");
  expect(f.store.rows.get(`session-owner:${f.record.sessionKey}`)?.status).toBe("failed");
  expect(requests.map((r) => r.method)).toEqual(["rakazo.run.status", "rakazo.tools.close"]);
});

it("does not lock a confirmed-ended invocation forever when its final reply is missing", async () => {
  const f = fixture();
  f.record.toolMode = "kernel";
  const peer: NativePeer = {
    stop() {},
    async request<T>(method: string) {
      if (method === "rakazo.run.status") return { status: "ok" } as T;
      if (method === "rakazo.run.result") return { result: null } as T;
      if (method === "rakazo.tools.close") return {} as T;
      throw Error(method);
    },
  };
  expect(await reconcileNativeExecution({ ...f, peer, key: "key", cancel: false })).toBe("failed");
  expect(f.store.rows.get("key")?.error).toContain("最终回复无法恢复");
  expect(f.store.rows.get(`session-owner:${f.record.sessionKey}`)?.status).toBe("failed");
});

it("never downgrades a terminal record when a stale status poll returns inconclusive", async () => {
  const f = fixture();
  const peer: NativePeer = {
    stop() {},
    async request<T>() {
      f.store.rows.set("key", { ...f.record, status: "done", text: "Already recovered" });
      f.store.rows.set(`session-owner:${f.record.sessionKey}`, { ...f.record, status: "done" });
      return { status: "running" } as T;
    },
  };
  expect(await reconcileNativeExecution({ ...f, peer, key: "key", cancel: false })).toBe(
    "unconfirmed",
  );
  expect(f.store.rows.get("key")?.status).toBe("done");
  expect(f.store.rows.get(`session-owner:${f.record.sessionKey}`)?.status).toBe("done");
});

it("does not release a kernel owner on an abort acknowledgement alone", async () => {
  const f = fixture();
  f.record.toolMode = "kernel";
  f.record.text = "Partial work";
  const peer: NativePeer = {
    async request<T>(method: string) {
      if (method === "chat.abort") return { aborted: true, runIds: [f.record.runId] } as T;
      if (method === "rakazo.run.status") return { status: "running" } as T;
      throw Error(`Unexpected mutation: ${method}`);
    },
    stop() {},
  };
  expect(
    await reconcileNativeExecution({ ...f, key: "key", peer, cancel: true, cancelWaitMs: 1 }),
  ).toBe("unconfirmed");
  expect(f.store.rows.get("key")).toEqual(f.record);
  expect(f.store.rows.get(`session-owner:${f.record.sessionKey}`)?.status).toBe("approval");
});

describe("reconciler cancel authority", () => {
  const scan = (run: Record<string, unknown>, recordOverride?: Partial<NativeRecord>) => {
    const request = vi.fn(async (method: string) =>
      method === "chat.abort"
        ? { aborted: true, runIds: ["review-native-run"] }
        : { status: "timeout", unconfirmed: true },
    );
    const record: NativeRecord = {
      version: 1,
      runId: "review-native-run",
      sessionKey: "review-session",
      inputHash: "review",
      startedAt: 1,
      status: "unconfirmed",
      text: "",
      ...recordOverride,
    };
    const updateMany = vi.fn(async (_args: { data: Record<string, unknown> }) => ({ count: 1 }));
    const reconciler = createOpenClawReconciler({
      prisma: { run: { findMany: async () => [run], updateMany } },
      nativeExecution: {
        store: {
          read: async (k: string) => (k === JSON.stringify([run.id, 0]) ? record : undefined),
          write: async () => {},
        },
        connect: async () => ({ request, stop() {} }),
      },
    } as unknown as ExecutorDeps);
    return { request, reconciler, updateMany };
  };
  it("aborts a failed run whose stop was explicitly requested", async () => {
    const { request, reconciler } = scan({
      id: "review-failed",
      botId: "review-bot",
      userId: "review-user",
      spaceId: "review-space",
      status: "failed",
      resourceWaitReason: "stopping",
      error: null,
      modelId: "synthetic",
    });
    await reconciler({ runIds: ["review-failed"] });
    expect(request.mock.calls.map((call) => call[0])).toContain("chat.abort");
  });
  it("keeps an unresolved stop visible on a finished run instead of erasing it", async () => {
    const { reconciler, updateMany } = scan({
      id: "review-failed",
      botId: "review-bot",
      userId: "review-user",
      spaceId: "review-space",
      status: "failed",
      resourceWaitReason: "unconfirmed",
      error: null,
      modelId: "synthetic",
    });
    await reconciler({ runIds: ["review-failed"] });
    // Admitting other runs is a separate decision (already settled in computer-lifecycle);
    // the marker itself is evidence the user still needs, so it is not cleared here.
    const written = updateMany.mock.calls.map((call) => call[0].data);
    expect(written.length).toBeGreaterThan(0);
    expect(written.some((data) => data.resourceWaitReason === "unconfirmed")).toBe(true);
  });
  it("never aborts a failed run on a routine status scan", async () => {
    const { request, reconciler } = scan({
      id: "review-failed",
      botId: "review-bot",
      userId: "review-user",
      spaceId: "review-space",
      status: "failed",
      resourceWaitReason: null,
      error: null,
      modelId: "synthetic",
    });
    await reconciler();
    expect(request.mock.calls.map((call) => call[0])).not.toContain("chat.abort");
  });
});
