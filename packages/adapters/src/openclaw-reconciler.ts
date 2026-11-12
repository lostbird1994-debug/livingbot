import { verifyNativeDeliveryText } from "./native-delivery-files.js";
import { join } from "node:path";
import { runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { connectLocalAgentBridge } from "./local-agent-runtime.js";
import {
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
} from "./openai-compatible-url.js";
import { connectOpenClawSdk, NativeRunJournal } from "./openclaw-gateway.js";
import type { NativeRunResult } from "./native-collaboration-broker.js";
import type { NativePeer, NativeRecord, NativeStore } from "./openclaw-native-driver.js";
import {
  confirmsNativeAbort,
  confirmNativeBackgroundWorkStopped,
  isNativeCancelled,
  isNativeTerminal,
  nativeRunIndexKey,
  stopNativeBackgroundWork,
  waitForNativeTermination,
} from "./openclaw-native-driver.js";
import { resolveConnectedRunModel } from "./run-model.js";

const settledError = (record: NativeRecord, productStatus: string) =>
  record.status === "failed" ? record.error ?? "底层任务已中断；此前操作可能已执行，请核实结果。"
    : productStatus === "cancelled" ? "底层任务已结束；取消前的操作可能已经执行。"
      : "底层任务已结束；请查看原生会话结果。";

/** Explicit user stop. Do not touch a replacement invocation started after the click. */
export async function stopOrphanedNativeSession(input: {
  sessionKey: string; before: number; store: NativeStore; peer: NativePeer;
}): Promise<NativeRecord["status"] | undefined> {
  const ownerKey = `session-owner:${input.sessionKey}`;
  const owner = await input.store.read(ownerKey);
  if (!owner || owner.sessionKey !== input.sessionKey || owner.startedAt > input.before ||
    ["done", "failed", "cancelled"].includes(owner.status)) return;
  const key = owner.executionKey ?? ownerKey;
  const record = key === ownerKey ? owner : await input.store.read(key);
  if (!record || record.runId !== owner.runId || record.sessionKey !== owner.sessionKey)
    throw new Error("Native recovery owner identity changed");
  return reconcileNativeExecution({ ...input, key, record, cancel: true });
}

/** Status-only recovery: never dispatch a new agent run or automatically approve a request. */
export async function reconcileNativeExecution(input: {
  key: string;
  record: NativeRecord;
  cancel: boolean;
  cancelWaitMs?: number;
  store: NativeStore;
  peer: NativePeer;
}): Promise<NativeRecord["status"]> {
  const { key, record, store, peer } = input;
  const params = { sessionKey: record.sessionKey, runId: record.runId };
  const abort = input.cancel
    ? await peer.request("chat.abort", params, { timeoutMs: 10_000 })
    : undefined;
  if (input.cancel) {
    await stopNativeBackgroundWork(peer, record);
    record.backgroundProcesses = [];
  }
  let result = await peer.request<{ status: string; stopReason?: string; unconfirmed?: boolean; reason?: string; error?: string }>(
    record.toolMode === "kernel" ? "rakazo.run.status" : "agent.wait",
    record.toolMode === "kernel" ? { ...params, startedAt: record.startedAt, engineInstanceId: record.engineInstanceId }
      : { runId: record.runId, timeoutMs: 1000 },
    { timeoutMs: 6000 },
  );
  if (input.cancel && record.toolMode === "kernel" && !isNativeTerminal(result))
    result = await waitForNativeTermination(peer, record, input.cancelWaitMs ?? 3000, result);
  // A restarted model controller cannot continue, but an already-backgrounded
  // command needs separate ownership/termination evidence before releasing it.
  if (result.reason === "engine_restarted") await confirmNativeBackgroundWorkStopped(peer, record);
  const terminal =
    (record.toolMode !== "kernel" && confirmsNativeAbort(abort, record.runId)) ||
    isNativeTerminal(result);
  // An inconclusive poll must never overwrite a terminal receipt written by a
  // live producer or another recovery call while this request was in flight.
  if (!terminal) return "unconfirmed";
  let status: NativeRecord["status"] = !terminal
    ? "unconfirmed"
    : (record.toolMode !== "kernel" && confirmsNativeAbort(abort, record.runId)) || isNativeCancelled(result)
      ? "cancelled"
      : result.status === "error"
        ? "failed"
        : "done";
  // A status-only recovery cannot invent a missing final answer. If the native
  // turn completed, fetch its canonical result before allowing any replay.
  let text = record.text;
  let error = result.error;
  if (status === "done" && record.toolMode === "kernel") {
    const receipt = await peer.request<{ result: NativeRunResult | null }>(
      "rakazo.run.result", params, { timeoutMs: 6000 },
    );
    text = receipt.result?.text ?? "";
    if (!text) {
      status = "failed";
      error = "原任务已经结束，但最终回复无法恢复；此前操作可能已执行，请核实后再决定是否重做。";
    }
    text = await verifyNativeDeliveryText(text);
    if (receipt.result?.blockedTools?.length)
      text += "\n\nRakazo 提示：本轮有工具操作被权限阻止，相关步骤尚未完成。请查看执行记录并处理授权后再继续。";
  } else if (status === "done") {
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
    if (!text) {
      status = "failed";
      error = "原任务已经结束，但最终回复无法恢复；此前操作可能已执行，请核实后再决定是否重做。";
    }
  }
  const recovered = {
    ...record,
    status,
    text,
    error: terminal ? status === "failed" ? error ?? "Native execution failed" : undefined : "Native execution remains unconfirmed",
  };
  if (terminal) delete recovered.approval;
  await store.write(key, recovered);
  // Keep the active invocation index consistent with the recovered execution.
  let identity: unknown;
  try { identity = JSON.parse(key); } catch { /* Legacy owner records lack an execution key. */ }
  if (Array.isArray(identity) && identity.length === 2 && typeof identity[0] === "string" && Number.isInteger(identity[1])) {
    const activeKey = nativeRunIndexKey(identity[0]);
    const active = await store.read(activeKey);
    if (active?.runId === record.runId && active.executionKey === key)
      await store.write(activeKey, { ...recovered, text: "", executionKey: key });
  }
  const ownerKey = `session-owner:${record.sessionKey}`;
  const owner = await store.read(ownerKey);
  if (owner?.runId === record.runId && ownerKey !== key)
    await store.write(ownerKey, { ...recovered, text: "", executionKey: key });
  if (terminal && record.toolMode === "kernel")
    await peer.request("rakazo.tools.close", params, { timeoutMs: 6000 });
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
        ...(deps.nativeExecution ? {} : { modelProvider: "openai-compatible",
        OR: [
          { modelId: { startsWith: "openclaw/" } },
          { modelId: { in: ["native/codex", "native/workbuddy"] } },
          { modelId: { startsWith: "native/codex/" } },
          { modelId: { startsWith: "native/workbuddy/" } },
        ] }),
        status: { in: ["waiting_input", "cancelled", "failed"] },
        ...(selection ? { id: { in: selection.runIds } } : cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: 25,
      select: { id: true, botId: true, userId: true, spaceId: true, status: true, error: true, modelId: true },
    });
    if (!selection) cursor = runs.length === 25 ? runs.at(-1)!.id : undefined;

    const scanDeadline = Date.now() + 25_000;
    for (const run of runs) {
      if (deps.shutdownSignal?.aborted || Date.now() >= scanDeadline) break;
      const local = !deps.nativeExecution && run.modelId?.startsWith("native/");
      const store =
        dependencies.store ??
        deps.nativeExecution?.store ??
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
        if (!record) continue;
        if (["done", "failed", "cancelled"].includes(record.status)) {
          // Admission-time recovery may already have settled the journal. Reflect
          // that evidence in the original failed run instead of leaving a stale
          // "unconfirmed" error forever, without marking business work successful.
          const error = settledError(record, run.status);
          if (deps.nativeExecution && run.error !== error)
            await runAsTenant(run, () => deps.prisma.run.updateMany({
              where: { id: run.id, spaceId: run.spaceId, userId: run.userId, status: run.status, error: run.error },
              data: { error },
            }));
          continue;
        }
        const expired =
          record.status === "approval" &&
          (!Number.isFinite(record.approval?.expiresAtMs) ||
            record.approval!.expiresAtMs <= Date.now());
        if (run.status === "waiting_input" && record.status !== "unconfirmed" && !expired) continue;
        await runAsTenant(run, async () => {
          if (deps.nativeExecution) {
            const peer = await deps.nativeExecution.connect(run);
            let status: NativeRecord["status"];
            try {
              status = await reconcileNativeExecution({ key, record, cancel: run.status === "cancelled", store, peer });
            } finally { peer.stop(); }
            await deps.prisma.run.updateMany({
              where: { id: run.id, spaceId: run.spaceId, userId: run.userId, status: run.status, error: run.error },
              data: { error: status === "unconfirmed"
                ? "底层任务状态未确认，请先核实，勿重复提交。"
                : settledError((await store.read(key))!, run.status) },
            });
            return;
          }
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
                  : settledError((await store.read(key))!, run.status),
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
