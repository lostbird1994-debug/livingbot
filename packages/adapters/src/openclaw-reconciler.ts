import { join } from "node:path";
import { runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { connectLocalAgentBridge } from "./local-agent-runtime.js";
import {
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
} from "./openai-compatible-url.js";
import { connectOpenClawSdk, NativeRunJournal } from "./openclaw-model-stream.js";
import type { NativePeer, NativeRecord, NativeStore } from "./openclaw-native-driver.js";
import {
  confirmsNativeAbort,
  isNativeCancelled,
  nativeRunIndexKey,
} from "./openclaw-native-driver.js";
import { resolveConnectedRunModel } from "./run-model.js";

/** Status-only recovery: never dispatch a new agent run or automatically approve a request. */
export async function reconcileNativeExecution(input: {
  key: string;
  record: NativeRecord;
  cancel: boolean;
  store: NativeStore;
  peer: NativePeer;
}): Promise<NativeRecord["status"]> {
  const { key, record, store, peer } = input;
  const params = { sessionKey: record.sessionKey, runId: record.runId };
  const abort = input.cancel
    ? await peer.request("chat.abort", params, { timeoutMs: 10_000 })
    : undefined;
  const result = await peer.request<{ status: string; stopReason?: string; unconfirmed?: boolean }>(
    "agent.wait",
    { runId: record.runId, timeoutMs: 1000 },
    { timeoutMs: 6000 },
  );
  const terminal =
    confirmsNativeAbort(abort, record.runId) ||
    (result.unconfirmed !== true && ["ok", "error", "aborted"].includes(result.status)) ||
    isNativeCancelled(result);
  const status: NativeRecord["status"] = !terminal
    ? "unconfirmed"
    : confirmsNativeAbort(abort, record.runId) || isNativeCancelled(result)
      ? "cancelled"
      : result.status === "error"
        ? "failed"
        : "done";
  // A status-only recovery cannot invent a missing final answer. If the native
  // turn completed, fetch its canonical result before allowing any replay.
  let text = record.text;
  if (status === "done") {
    const history = await peer.request<{
      messages?: Array<{
        role: string;
        timestamp: number;
        content?: Array<{ type: string; text?: string }>;
      }>;
    }>("chat.history", { sessionKey: record.sessionKey, limit: 20 }, { timeoutMs: 6000 });
    const last = history.messages?.findLast(
      (m) => m.role === "assistant" && Number(m.timestamp) >= record.startedAt,
    );
    text =
      last?.content
        ?.filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("") ?? "";
    if (!text) return "unconfirmed";
  }
  const recovered = {
    ...record,
    status,
    text,
    error: terminal ? undefined : "Native execution remains unconfirmed",
  };
  await store.write(key, recovered);
  const ownerKey = `session-owner:${record.sessionKey}`;
  const owner = await store.read(ownerKey);
  if (owner?.runId === record.runId) await store.write(ownerKey, { ...recovered, text: "" });
  return status;
}

/** Runs under the existing elected job reconciler, including after process restart. */
export function createOpenClawReconciler(
  deps: ExecutorDeps,
  dependencies: {
    store?: NativeStore;
    connect?: typeof connectOpenClawSdk;
    resolveModel?: typeof resolveConnectedRunModel;
  } = {},
) {
  let cursor: string | undefined;
  return async (selection?: { runIds: string[] }) => {
    if (deps.shutdownSignal?.aborted) return;
    const runs = await deps.prisma.run.findMany({
      where: {
        modelProvider: "openai-compatible",
        OR: [
          { modelId: { startsWith: "openclaw/" } },
          { modelId: { in: ["native/codex", "native/workbuddy"] } },
          { modelId: { startsWith: "native/codex/" } },
          { modelId: { startsWith: "native/workbuddy/" } },
        ],
        status: { in: ["waiting_input", "cancelled", "failed"] },
        ...(selection ? { id: { in: selection.runIds } } : cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: 25,
      select: { id: true, userId: true, spaceId: true, status: true, error: true, modelId: true },
    });
    if (!selection) cursor = runs.length === 25 ? runs.at(-1)!.id : undefined;

    const scanDeadline = Date.now() + 25_000;
    for (const run of runs) {
      if (deps.shutdownSignal?.aborted || Date.now() >= scanDeadline) break;
      const local = run.modelId?.startsWith("native/");
      const store =
        dependencies.store ??
        new NativeRunJournal(
          join(
            process.env.DATA_DIR ?? "./data",
            "external-runtime",
            local ? "local-agent" : "openclaw",
          ),
          process.env.ENCRYPTION_KEY ?? "",
        );
      try {
        // A follow-up arriving just as a native turn ends can start another
        // invocation under this run. Cancel that current invocation, not ordinal zero.
        const active = await store.read(nativeRunIndexKey(run.id));
        const key = active?.executionKey ?? JSON.stringify([run.id, 0]);
        const identity = JSON.parse(key);
        if (
          !Array.isArray(identity) ||
          identity.length !== 2 ||
          identity[0] !== run.id ||
          !Number.isInteger(identity[1]) ||
          identity[1] < 0
        )
          throw new Error("Native execution index identity changed");
        const record = await store.read(key);
        if (active?.executionKey && record?.runId !== active.runId)
          throw new Error("Native execution index is inconsistent");
        if (!record || ["done", "failed", "cancelled"].includes(record.status)) continue;
        const expired =
          record.status === "approval" &&
          (!Number.isFinite(record.approval?.expiresAtMs) ||
            record.approval!.expiresAtMs <= Date.now());
        if (run.status === "waiting_input" && record.status !== "unconfirmed" && !expired) continue;
        await runAsTenant(run, async () => {
          const model = await (dependencies.resolveModel ?? resolveConnectedRunModel)(
            deps,
            run,
            "openai-compatible",
            run.modelId!,
            undefined,
            true,
            undefined,
            record.connectionId,
          );
          const base = assertAllowedOpenAiCompatibleUrl(model.baseUrl ?? "", {
            allowPrivate: model.allowPrivateEndpoint,
          });
          assertHttpsForKeyedOpenAiCompatibleUrl(base, model.apiKey);
          const url = new URL(base);
          if (!local) url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
          url.pathname = "/";
          if (
            !model.apiKey ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            record.gatewayOrigin !== url.origin
          )
            throw new Error("Native connection identity changed; recovery blocked");
          const peer = await (
            dependencies.connect ?? (local ? connectLocalAgentBridge : connectOpenClawSdk)
          )(url.href, model.apiKey, () => {});
          let status: NativeRecord["status"];
          try {
            status = await reconcileNativeExecution({
              key,
              record,
              cancel: run.status === "cancelled",
              store,
              peer,
            });
          } finally {
            peer.stop();
          }
          await deps.prisma.run.updateMany({
            where: {
              id: run.id,
              spaceId: run.spaceId,
              userId: run.userId,
              status: run.status,
              error: run.error,
            },
            data: {
              error:
                status === "unconfirmed"
                  ? "底层任务状态未确认，请先核实，勿重复提交。"
                  : run.status === "cancelled"
                    ? "底层任务已结束；取消前的操作可能已经执行。"
                    : "底层任务已结束；请查看原生会话结果。",
            },
          });
        });
      } catch {
        // Never log credentials/provider errors containing endpoint secrets.
        getLogger().warn("native execution reconciliation deferred", { runId: run.id });
        await runAsTenant(run, () =>
          deps.prisma.run.updateMany({
            where: {
              id: run.id,
              spaceId: run.spaceId,
              userId: run.userId,
              status: run.status,
              error: run.error,
            },
            data: { error: "底层任务状态未确认，请先核实，勿重复提交。" },
          }),
        ).catch(() => undefined);
      }
    }
  };
}
