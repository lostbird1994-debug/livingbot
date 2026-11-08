import { describe, expect, it } from "vitest";
import type {
  NativeFrame,
  NativeInput,
  NativeOptions,
  NativeRecord,
  NativeStore,
} from "./openclaw-native-driver.js";
import { nativeSessionKey, runNativeAgent } from "./openclaw-native-driver.js";

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
  const calls: Array<{ method: string; params: any }> = [];
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
        request: async (method, params) => {
          calls.push({ method, params });
          return handler(method, params);
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
    expect(call.params).toMatchObject({ extraSystemPrompt: "Test role", deliver: false });
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
    expect(notices).toEqual(["Shell: start"]);
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
