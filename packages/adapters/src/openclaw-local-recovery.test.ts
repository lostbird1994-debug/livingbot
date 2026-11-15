import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { NativeRunJournal } from "./openclaw-gateway.js";
import type { NativePeer, NativeRecord } from "./openclaw-native-driver.js";
import { createOpenClawReconciler } from "./openclaw-reconciler.js";

const local = vi.hoisted(() => ({ rows: new Map<string, NativeRecord>() }));
vi.mock("./openclaw-gateway.js", async (original) => ({
  ...(await original<object>()),
  NativeRunJournal: vi.fn(function LocalJournal() {
    return {
      async read(key: string) {
        return structuredClone(local.rows.get(key));
      },
      async write(key: string, value: NativeRecord) {
        local.rows.set(key, structuredClone(value));
      },
    };
  }),
}));

describe("desktop recovery with an OpenClaw default runtime", () => {
  it.each(["codex", "workbuddy"])("stops %s using its own journal and bridge", async (engine) => {
    local.rows.clear();
    const key = JSON.stringify(["run", 0]);
    local.rows.set(key, {
      version: 1,
      runId: "native-run",
      sessionKey: `agent:${engine}:rakazo:session`,
      inputHash: "input",
      startedAt: 1,
      status: "unconfirmed",
      text: "",
      gatewayOrigin: "http://127.0.0.1:43184",
      connectionId: "connection",
    });
    const request = vi.fn<NativePeer["request"]>(async <T>(method: string): Promise<T> => {
      if (method === "chat.abort") return { aborted: true, runIds: ["native-run"] } as T;
      if (method === "agent.wait") return { status: "aborted", stopReason: "aborted" } as T;
      throw new Error(`Unexpected method: ${method}`);
    });
    const connect = vi.fn(
      async (): Promise<NativePeer> => ({
        request: async <T>(method: string): Promise<T> => (await request(method)) as T,
        stop: vi.fn(),
      }),
    );
    const kernelRead = vi.fn().mockRejectedValue(new Error("Wrong journal"));
    const kernelConnect = vi.fn().mockRejectedValue(new Error("Wrong bridge"));
    const resolveModel = vi.fn().mockResolvedValue({
      baseUrl: "http://127.0.0.1:43184/v1",
      apiKey: "fake-key",
      allowPrivateEndpoint: true,
    });
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const run = {
      id: "run",
      botId: "bot",
      spaceId: "space",
      userId: "user",
      status: "cancelled",
      error: null,
      resourceWaitReason: "stopping",
      modelId: `native/${engine}/selected`,
    };
    const reconcile = createOpenClawReconciler(
      {
        prisma: { run: { findMany: async () => [run], updateMany } },
        nativeExecution: { store: { read: kernelRead }, connect: kernelConnect },
      } as unknown as ExecutorDeps,
      { connect, resolveModel },
    );
    await reconcile({ runIds: [run.id] });
    expect(NativeRunJournal).toHaveBeenCalledWith(
      expect.stringMatching(/external-runtime\/local-agent$/),
      expect.any(String),
    );
    expect(kernelRead).not.toHaveBeenCalled();
    expect(kernelConnect).not.toHaveBeenCalled();
    expect(resolveModel).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith(
      "http://127.0.0.1:43184/",
      "fake-key",
      expect.any(Function),
    );
    expect(resolveModel.mock.calls[0]?.at(-1)).toBe("connection");
    expect(request.mock.calls.map(([method]) => method)).toContain("chat.abort");
    expect(local.rows.get(key)?.status).toBe("cancelled");
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ resourceWaitReason: null }) }),
    );
  });
});
