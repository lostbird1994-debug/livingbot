import { nativeToolProgress } from "./native-tool-progress.js";
import { createHash } from "node:crypto";
import { isToolPauseResult } from "./approval-effect.js";
import type { NativeCollaboration } from "./native-collaboration.js";
import type { CollaborationCall, NativeRunResult } from "./native-collaboration-broker.js";

export interface NativeFrame {
  event: string;
  payload?: Record<string, any>;
}
export interface NativePeer {
  request<T = any>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>;
  stop(): void;
}
export interface NativeRecord {
  version: 1;
  sessionKey: string;
  runId: string;
  inputHash: string;
  request?: { identity: string; message: string; instructions: string; attachments?: unknown[] };
  modelId?: string;
  toolMode?: "collaboration" | "kernel";
  thinking?: string;
  startedAt: number;
  status: "dispatching" | "running" | "approval" | "done" | "failed" | "cancelled" | "unconfirmed";
  text: string;
  usage?: Record<string, unknown>;
  gatewayOrigin?: string;
  connectionId?: string;
  engineInstanceId?: string;
  error?: string;
  steeringIds?: string[];
  unconfirmedSteeringIds?: string[];
  steeringReplies?: string[];
  executionKey?: string;
  backgroundProcesses?: string[];
  approval?: {
    id: string;
    expiresAtMs: number;
    command: string;
    decisions: string[];
    kind?: "question" | "collaboration";
    callId?: string;
  };
}
export interface NativeStore {
  read(key: string): Promise<NativeRecord | undefined>;
  write(key: string, value: NativeRecord): Promise<void>;
}
export interface NativeNotice {
  type: "progress" | "approval" | "question";
  text: string;
  id?: string;
  decisions?: string[];
}
export interface NativeInput {
  key: string;
  activeKey?: string;
  scope: string;
  agentId: string;
  modelId?: string;
  thinking?: string;
  gatewayOrigin?: string;
  connectionId?: string;
  message: string;
  instructions: string;
  signal?: AbortSignal;
  answeredApproval?: { id: string; actionId: string };
  collaboration?: NativeCollaboration;
  attachments?: unknown[];
  onText?: (delta: string, replace?: boolean) => void;
  onThinking?: (active: boolean) => void;
  /** Observation only: the native engine already owns execution of this tool. */
  onTool?: (tool: { name: string; args: Record<string, unknown>; executionId: string }) => void;
  onNotice?: (notice: NativeNotice) => void;
  onStarted?: () => Promise<void>;
  onUsage?: (usage: Record<string, unknown> | undefined) => void;
  claimSteering?: (seenIds: string[]) => Promise<
    Array<{
      id: string;
      text: string;
      fromRunUser?: boolean;
      attachments?: unknown[];
    }>
  >;
  onSteered?: (fromRunUser: boolean) => void;
}
export interface NativeOptions {
  store: NativeStore;
  connect(onEvent: (frame: NativeFrame) => void): Promise<NativePeer>;
  connectMs?: number;
  dispatchMs?: number;
  runMs?: number;
  cancelMs?: number;
  pollMs?: number;
  /** Deadline for requesting cancellation of an earlier invocation, never proof of exit. */
  staleMs?: number;
  /** Inconclusive status polls tolerated before the session is held as unconfirmed. */
  unconfirmedPolls?: number;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const nativeSessionKey = (scope: string, agentId: string) =>
  `agent:${agentId}:rakazo:${hash(scope)}`;
export const nativeRunIndexKey = (runId: string) => JSON.stringify(["active-execution", runId]);
/** An exact native abort response confirms that this run's controller was aborted. */
export const confirmsNativeAbort = (result: any, runId: string): boolean =>
  result?.unconfirmed !== true &&
  result?.aborted === true &&
  Array.isArray(result.runIds) &&
  result.runIds.includes(runId);
export const isNativeCancelled = (result: any): boolean =>
  result?.unconfirmed !== true &&
  (result?.status === "aborted" || ["aborted", "rpc", "stop"].includes(result?.stopReason));
export interface NativeRunStatus {
  status: string;
  stopReason?: string;
  unconfirmed?: boolean;
  reason?: string;
  error?: string;
}
export const isNativeTerminal = (result: NativeRunStatus) => result.unconfirmed !== true &&
  (["ok", "error", "aborted"].includes(result.status) || isNativeCancelled(result));

/** A stop request is not a completion receipt. Wait only for the exact run. */
export async function waitForNativeTermination(
  peer: NativePeer, record: NativeRecord, waitMs: number, initial?: NativeRunStatus,
): Promise<NativeRunStatus> {
  const deadline = Date.now() + Math.max(0, waitMs);
  const read = () => peer.request<NativeRunStatus>("rakazo.run.status", {
    sessionKey: record.sessionKey, runId: record.runId,
    startedAt: record.startedAt, engineInstanceId: record.engineInstanceId,
  }, { timeoutMs: Math.max(1, Math.min(6000, deadline - Date.now())) });
  let result = initial ?? await read();
  while (!isNativeTerminal(result) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    if (Date.now() < deadline) result = await read();
  }
  return result;
}
export class NativeExecutionError extends Error {
  constructor(
    message: string,
    readonly state: NativeRecord["status"],
  ) {
    super(message);
    this.name = "NativeExecutionError";
  }
}
const textOf = (message: any): string => {
  if (typeof message === "string") return message;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text ?? "")
    .join("");
};
const bounded = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/** Reused by the live producer and recovery after an API/worker restart. */
export async function stopNativeBackgroundWork(peer: NativePeer, record: NativeRecord, timeoutMs = 10_000) {
  for (const processId of record.backgroundProcesses ?? []) {
    const invoke = (action: "kill" | "poll") => bounded(peer.request<any>(
      "rakazo.process.control",
      { action, sessionId: processId, sessionKey: record.sessionKey, runId: record.runId },
      { timeoutMs },
    ), timeoutMs, "Background process control timed out");
    await invoke("kill");
    const deadline = Date.now() + timeoutMs;
    let terminal = false;
    do {
      const details = await invoke("poll");
      terminal = ["completed", "failed"].includes(details?.status);
      if (!terminal) await new Promise(resolve => setTimeout(resolve, Math.min(100, timeoutMs)));
    } while (!terminal && Date.now() < deadline);
    if (!terminal) throw new NativeExecutionError(
      "Background command cancellation could not be confirmed; do not retry this task", "unconfirmed",
    );
  }
}

/** Read-only confirmation; losing a process registry is not proof of exit. */
export async function confirmNativeBackgroundWorkStopped(peer: NativePeer, record: NativeRecord) {
  for (const sessionId of record.backgroundProcesses ?? []) {
    const result = await peer.request<{ status: string }>("rakazo.process.control", {
      sessionKey: record.sessionKey, runId: record.runId, sessionId, action: "poll",
    }, { timeoutMs: 6000 });
    if (!["completed", "failed"].includes(result.status))
      throw new NativeExecutionError("原任务的后台命令尚未确认停止，请先核实该命令。", "unconfirmed");
  }
}

/** One durable native invocation, never an automatically retried model request. */
export async function runNativeAgent(input: NativeInput, options: NativeOptions): Promise<string> {
  const runMs = options.runMs ?? 30 * 60_000;
  const pollMs = options.pollMs ?? 15_000;
  const cancelMs = options.cancelMs ?? 10_000;
  const sessionKey = nativeSessionKey(input.scope, input.agentId);
  const runId = `rakazo-${hash(input.key)}`;
  const inputHash = hash(
    JSON.stringify([
      input.message,
      input.attachments ?? [],
      ...(input.modelId !== undefined ? [input.modelId] : []),
      ...(input.thinking !== undefined ? [input.thinking] : []),
    ]),
  );
  const saved = await options.store.read(input.key);
  if (
    saved &&
    (saved.sessionKey !== sessionKey ||
      saved.runId !== runId ||
      saved.modelId !== input.modelId ||
      (saved.inputHash !== inputHash && saved.status !== "approval" &&
        !(saved.toolMode === "kernel" && input.collaboration?.toolMode === "kernel")))
  )
    throw new NativeExecutionError(
      "External run identity changed; refusing to replay a task",
      "unconfirmed",
    );
  if (saved?.status === "done") {
    input.onText?.(saved.text);
    input.onUsage?.(saved.usage);
    return saved.text;
  }
  if (saved && (["failed", "cancelled"].includes(saved.status) ||
    (saved.status === "unconfirmed" && input.collaboration?.toolMode !== "kernel")))
    throw new NativeExecutionError(
      saved.error ?? "External task requires an explicit new run",
      saved.status,
    );
  const sessionOwnerKey = `session-owner:${sessionKey}`;
  let owner = await options.store.read(sessionOwnerKey);
  const ownerWaitUntil = Date.now() + cancelMs;
  while (
    owner &&
    owner.runId !== runId &&
    ["dispatching", "running", "approval", "unconfirmed"].includes(owner.status) &&
    !input.signal?.aborted &&
    Date.now() < ownerWaitUntil
  ) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, cancelMs)));
    owner = await options.store.read(sessionOwnerKey);
  }
  if (!input.signal?.aborted && owner && owner.runId !== runId && owner.toolMode === "kernel" &&
    ["dispatching", "running", "approval", "unconfirmed"].includes(owner.status)) {
    // Recovery only observes the old invocation. Never register its tools or
    // replay its agent request while trying to admit a different task.
    input.onNotice?.({ type: "progress", text: "正在核对上一轮任务的结束状态…" });
    let recoveryPeer: NativePeer | undefined;
    let finished = false;
    try {
      const recoveryConnection: NativePeer = await bounded(options.connect(() => {}).then(peer => {
        if (finished) peer.stop();
        return peer;
      }), options.connectMs ?? 15_000, "Native recovery connection timed out");
      recoveryPeer = recoveryConnection;
      // Deferred to the recovery path to avoid a static driver/reconciler cycle.
      const { reconcileNativeExecution } = await import("./openclaw-reconciler.js");
      const recoveryKey = owner.executionKey ?? sessionOwnerKey;
      const recoveryRecord = recoveryKey === sessionOwnerKey ? owner : await options.store.read(recoveryKey);
      if (!recoveryRecord || recoveryRecord.runId !== owner.runId || recoveryRecord.sessionKey !== sessionKey)
        throw new Error("Native recovery owner identity changed");
      await reconcileNativeExecution({
        key: recoveryKey, record: recoveryRecord,
        cancel: false, store: options.store, peer: recoveryConnection,
      });
    } catch { /* Unavailable evidence must leave the existing owner in place. */ }
    finally { finished = true; recoveryPeer?.stop(); }
    owner = await options.store.read(sessionOwnerKey);
  }
  if (
    owner &&
    owner.runId !== runId &&
    ["dispatching", "running", "approval", "unconfirmed"].includes(owner.status)
  ) {
    // A deadline requests cancellation; only engine-confirmed termination can
    // release the session. Do not replace the full execution with its summary.
    const staleRunId = owner.runId;
    const staleKey = owner.executionKey ?? sessionOwnerKey;
    const staleMs = options.staleMs ?? 30 * 60_000;
    if (owner.status === "approval" || Date.now() - (owner.startedAt ?? 0) < staleMs)
      throw new NativeExecutionError(
        "An earlier task in this native session is unresolved; inspect it before submitting another task",
        "unconfirmed",
      );
    input.onNotice?.({ type: "progress", text: "上一轮任务已超时，正在请求停止并等待确认…" });
    let staleFinished = false;
    let stalePeer: NativePeer | undefined;
    try {
      const connected: NativePeer = await bounded(options.connect(() => {}).then(peer => {
        if (staleFinished) peer.stop();
        return peer;
      }), options.connectMs ?? 15_000, "Native timeout recovery connection timed out");
      stalePeer = connected;
      const staleRecord = staleKey === sessionOwnerKey ? owner : await options.store.read(staleKey);
      if (!staleRecord || staleRecord.runId !== staleRunId || staleRecord.sessionKey !== sessionKey)
        throw new Error("Native recovery owner identity changed");
      const { reconcileNativeExecution } = await import("./openclaw-reconciler.js");
      await reconcileNativeExecution({
        key: staleKey, record: staleRecord,
        cancel: true, cancelWaitMs: cancelMs, store: options.store, peer: connected,
      });
    } catch { /* Keep the previous record and its process handles until confirmed. */ }
    finally { staleFinished = true; stalePeer?.stop(); }
    owner = await options.store.read(sessionOwnerKey);
    if (owner && owner.runId !== runId &&
      ["dispatching", "running", "approval", "unconfirmed"].includes(owner.status))
      throw new NativeExecutionError(
        "An earlier task in this native session is unresolved; inspect it before submitting another task",
        "unconfirmed",
      );
  }
  let lastStoredStatus: NativeRecord["status"] | undefined;
  // Existing records may already have reached the engine. For a new run,
  // connection/setup failures prove that no agent invocation was attempted.
  let dispatchAttempted = Boolean(saved);
  let lastTextPersistAt = 0;
  const record: NativeRecord = saved ?? {
    version: 1,
    toolMode: input.collaboration?.toolMode,
    sessionKey,
    runId,
    inputHash,
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
    gatewayOrigin: input.gatewayOrigin,
    connectionId: input.connectionId,
    startedAt: Date.now(),
    status: "dispatching",
    text: "",
  };
  let pending = Promise.resolve();
  const persist = () => {
    const snapshot = structuredClone(record);
    const writeOwner = snapshot.status !== lastStoredStatus;
    lastStoredStatus = snapshot.status;
    pending = pending.then(async () => {
      await options.store.write(input.key, snapshot);
      if (writeOwner && input.activeKey) {
        const active = await options.store.read(input.activeKey);
        if (
          !active ||
          (active.executionKey === input.key &&
            (!["done", "failed", "cancelled"].includes(active.status) ||
              ["done", "failed", "cancelled"].includes(snapshot.status))) ||
          (snapshot.status === "dispatching" &&
            ["done", "failed", "cancelled"].includes(active.status))
        )
          await options.store.write(input.activeKey, {
            ...snapshot,
            text: "",
            executionKey: input.key,
          });
      }
      if (writeOwner) {
        const current = await options.store.read(sessionOwnerKey);
        if (
          !current ||
          (current.runId === runId &&
            (!["done", "failed", "cancelled"].includes(current.status) ||
              ["done", "failed", "cancelled"].includes(snapshot.status))) ||
          (snapshot.status === "dispatching" &&
            ["done", "failed", "cancelled"].includes(current.status))
        )
          await options.store.write(sessionOwnerKey, { ...snapshot, text: "", executionKey: input.key });
      }
    });
    return pending;
  };
  let outcome: "done" | "failed" | "cancelled" | undefined;
  let nativeError = "";
  let nativeErrorUnconfirmed = false;
  let wake: (() => void) | undefined;
  let paused = false;
  let peer: NativePeer | undefined;
  let closing = false;
  const kernel = input.collaboration?.toolMode === "kernel";
  let recoveryNoticeShown = false;
  const recovering = () => {
    if (recoveryNoticeShown) return;
    recoveryNoticeShown = true;
    input.onNotice?.({ type: "progress", text: "连接中断，正在确认后台重试结果。" });
  };
  const steeringResults = new Map<string, { state: string; text: string } | undefined>();
  const observedTools = new Set<string>();
  let thinkingActive = false;
  const setThinking = (active: boolean) => {
    if (active === thinkingActive) return;
    thinkingActive = active;
    input.onThinking?.(active);
  };
  const notify = () => wake?.();
  const onEvent = (frame: NativeFrame) => {
    if (closing) return;
    const p = frame.payload ?? {};
    if (frame.event === "chat" && steeringResults.has(p.runId)) {
      if (["final", "error", "aborted"].includes(p.state)) {
        steeringResults.set(p.runId, { state: p.state, text: textOf(p.message) });
        notify();
      }
      return;
    }
    if (frame.event === "exec.approval.requested" && p.request?.sessionKey === sessionKey) {
      record.approval = {
        id: String(p.id),
        ...(p.request.kind === "question" ? { kind: "question" as const } : {}),
        expiresAtMs: Number(p.expiresAtMs),
        command: String(p.request.commandPreview ?? p.request.command ?? ""),
        decisions: (Array.isArray(p.request.allowedDecisions)
          ? p.request.allowedDecisions
          : ["allow-once", "deny"]
        ).filter((s: string) => ["allow-once", "deny"].includes(s)),
      };
      record.status = "approval";
      const requested = structuredClone(record.approval);
      void persist()
        .then(() => {
          paused = true;
          input.onNotice?.({
            type: requested.kind === "question" ? "question" : "approval",
            text: requested.command,
            id: requested.id,
            decisions: requested.decisions,
          });
          notify();
        })
        .catch((error) => {
          nativeError = String(error);
          outcome = "failed";
          notify();
        });
      return;
    }
    if (p.runId !== runId) return;
    if (frame.event === "chat") {
      if (p.state === "aborted") outcome = "cancelled";
      if (p.state === "error" && !kernel) {
        outcome = "failed";
        nativeError = String(p.errorMessage ?? "External agent failed");
      }
      // Agent RPC's lifecycle is authoritative; a chat delta may contain cumulative text.
    }
    if (frame.event === "agent") {
      if (p.stream === "thinking") setThinking(true);
      else if (["assistant", "tool", "lifecycle"].includes(p.stream)) setThinking(false);
      if (p.stream === "assistant") {
        const delta = typeof p.data?.delta === "string" ? p.data.delta : "";
        if (delta) {
          record.text += delta;
          input.onText?.(delta);
          if (Date.now() - lastTextPersistAt >= 1000) {
            lastTextPersistAt = Date.now();
            void persist().catch((error) => {
              outcome = "failed";
              nativeError = String(error);
              notify();
            });
          }
        }
      }
      if (p.stream === "compaction") {
        input.onNotice?.({ type: "progress", text: p.data?.phase === "start"
          ? "正在整理较长的会话记录…" : "会话记录已整理，继续处理…" });
      }
      if (p.stream === "tool") {
        const name = String(p.data?.name ?? "tool");
        const phase = String(p.data?.phase ?? "update");
        const callId = p.data?.toolCallId;
        if (phase === "start" && typeof callId === "string" && !observedTools.has(callId)) {
          observedTools.add(callId);
          input.onTool?.({
            name, executionId: `native-observed:${hash(`${runId}:${callId}`)}`,
            args: p.data?.args && typeof p.data.args === "object" && !Array.isArray(p.data.args)
              ? p.data.args : {},
          });
        }
        const details = (p.data?.result ?? p.data?.partialResult)?.details;
        const processId = details?.sessionId;
        if (typeof processId === "string" && processId.length <= 256) {
          const owned = new Set(record.backgroundProcesses ?? []);
          const before = owned.size;
          if (name === "exec" && details.status === "running") owned.add(processId);
          if (["completed", "failed"].includes(details.status)) owned.delete(processId);
          if (owned.size !== before) {
            record.backgroundProcesses = [...owned];
            void persist().catch((error) => {
              nativeError = String(error);
              nativeErrorUnconfirmed = true;
              outcome = "failed";
              notify();
            });
          }
        }
        const progress = nativeToolProgress(name, phase, details?.status === "running");
        if (progress) input.onNotice?.({ type: "progress", text: progress });
        if (["result", "end"].includes(phase) && details?.status !== "running") setThinking(true);
      }
      if (p.stream === "lifecycle" && kernel) {
        // Embedded attempts emit terminal-looking events before provider retry.
        // Only the gateway command receipt can end a kernel run.
        if (p.data?.phase === "error") recovering();
      }
      if (p.stream === "lifecycle" && !kernel) {
        if (p.data?.phase === "end")
          outcome = p.data.aborted === true || p.data.status === "cancelled" ? "cancelled" : "done";
        if (p.data?.phase === "error") {
          outcome = "failed";
          nativeError = String(p.data?.error ?? "External agent failed");
          nativeErrorUnconfirmed = p.data?.unconfirmed === true;
        }
      }
    }
    notify();
  };
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        if (wake === finish) wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, Math.max(1, ms));
      wake = finish;
    });
  const cancel = async (reason: string) => {
    if (!peer) throw new NativeExecutionError("Cancellation could not be confirmed", "unconfirmed");
    const result = await bounded(
      peer.request<any>("chat.abort", { sessionKey, runId }, { timeoutMs: cancelMs }),
      cancelMs,
      "Cancellation acknowledgement timed out",
    );
    // A session abort stops the model controller, not necessarily exec processes
    // that already returned a background handle. Cancel only handles observed
    // on this run, through the same session's process-tool isolation boundary.
    await pending;
    await stopNativeBackgroundWork(peer, record, cancelMs);
    record.backgroundProcesses = [];
    // Kernel cancellation must finish, not merely acknowledge the request.
    if (kernel) {
      const terminal = await waitForNativeTermination(peer, record, cancelMs);
      if (!isNativeTerminal(terminal))
        throw new NativeExecutionError("停止请求已发出，但尚未确认结束；请使用“停止旧任务”恢复。", "unconfirmed");
      outcome = "cancelled";
    } else if (confirmsNativeAbort(result, runId)) outcome = "cancelled";
    if (!kernel && !result.aborted && !outcome) {
      const current = await peer.request<any>(
        kernel ? "rakazo.run.status" : "agent.wait",
        kernel ? { runId, sessionKey, startedAt: record.startedAt, engineInstanceId: record.engineInstanceId } : { runId, timeoutMs: Math.min(cancelMs, 1000) },
        { timeoutMs: cancelMs },
      );
      if (
        !isNativeCancelled(current) &&
        current.status !== "ok" &&
        current.status !== "error" &&
        current.status !== "aborted"
      )
        throw new NativeExecutionError(
          "Cancellation could not be confirmed; do not retry this task",
          "unconfirmed",
        );
    } else if (!kernel && !outcome) {
      const terminal = await bounded(
        peer.request<any>(
          kernel ? "rakazo.run.status" : "agent.wait",
          kernel ? { runId, sessionKey, startedAt: record.startedAt, engineInstanceId: record.engineInstanceId } : { runId, timeoutMs: cancelMs },
          { timeoutMs: cancelMs + 1000 },
        ),
        cancelMs + 1000,
        "Native cancellation did not settle",
      );
      if (!isNativeCancelled(terminal) && !["ok", "error", "aborted"].includes(terminal.status))
        throw new NativeExecutionError(
          "Native task may still be running; cancellation unconfirmed",
          "unconfirmed",
        );
    }
    record.status = "cancelled";
    record.error = reason;
    await persist();
    throw new NativeExecutionError(reason, "cancelled");
  };
  const onAbort = () => notify();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (!saved && input.signal?.aborted)
      throw new NativeExecutionError("External task cancelled before dispatch", "cancelled");
    const connection: NativePeer = await bounded(
      options.connect(onEvent).then((value) => {
        if (closing) value.stop();
        return value;
      }),
      options.connectMs ?? 15_000,
      "External runtime connection timed out",
    );
    peer = connection;
    const collaboration = input.collaboration;
    if (collaboration) {
      const registration = await connection.request<{ engineInstanceId?: string }>("rakazo.tools.register", {
        sessionKey,
        runId,
        tools: collaboration.tools,
        ...(collaboration.toolMode ? { toolMode: collaboration.toolMode } : {}),
        ...(collaboration.nativeTools ? { nativeTools: collaboration.nativeTools } : {}),
        ...(collaboration.privateContextAllowed !== undefined
          ? { privateContextAllowed: collaboration.privateContextAllowed } : {}),
      });
      if (!saved && typeof registration?.engineInstanceId === "string")
        record.engineInstanceId = registration.engineInstanceId;
    } else if (record.approval?.kind === "collaboration") {
      throw new NativeExecutionError(
        "Collaboration tools are unavailable during resume",
        "unconfirmed",
      );
    }
    if (record.status === "approval" && record.approval?.kind === "collaboration") {
      const waiting = await connection.request<{ calls: CollaborationCall[] }>(
        "rakazo.tools.poll",
        { sessionKey, runId },
      );
      if (
        record.approval.expiresAtMs <= Date.now() ||
        !waiting.calls?.some((call) => call.id === record.approval?.callId)
      )
        throw new NativeExecutionError(
          "Native collaboration request expired or was cancelled; start a new task to send it",
          "failed",
        );
      record.status = "running";
      delete record.approval;
      await persist();
    } else if (record.status === "approval") {
      const approval = record.approval;
      if (!approval || !Number.isFinite(approval.expiresAtMs) || approval.expiresAtMs <= Date.now())
        throw new NativeExecutionError(
          "Native approval expired; native termination must be confirmed",
          "unconfirmed",
        );
      const answer = input.answeredApproval;
      const decision =
        answer?.id === approval.id &&
        (approval.kind === "question"
          ? Boolean(answer.actionId.trim()) && answer.actionId.length <= 64_000
          : ["allow-once", "deny"].includes(answer.actionId))
          ? answer.actionId
          : undefined;
      if (!decision || (approval.kind !== "question" && !approval.decisions.includes(decision))) {
        paused = true;
        input.onNotice?.({
          type: approval.kind === "question" ? "question" : "approval",
          text: approval.command,
          id: approval.id,
          decisions: approval.decisions,
        });
      } else {
        await connection.request(
          "exec.approval.resolve",
          approval.kind === "question"
            ? { id: approval.id, decision: "answer", value: decision }
            : { id: approval.id, decision },
        );
        // Another request may arrive before the resolution ACK. Never clear
        // that newer request using the answer for this one.
        if (record.approval?.id === approval.id) {
          record.status = "running";
          delete record.approval;
          await persist();
        }
      }
    } else if (!saved) {
      if (input.signal?.aborted)
        throw new NativeExecutionError("External task cancelled before dispatch", "cancelled");
      // Persist BEFORE dispatch. A process crash or lost ACK must never launch another task.
      await persist();
      // The attachment validator looks up provider and bare model separately.
      // Keep the qualified reference in our record, but split it on the wire.
      const separator = input.modelId?.indexOf("/") ?? -1;
      const modelOverride = input.modelId === undefined ? {} : separator > 0
        ? { provider: input.modelId.slice(0, separator), model: input.modelId.slice(separator + 1) }
        : { model: input.modelId };
      input.onNotice?.({ type: "progress", text: "正在分析请求…" });
      setThinking(true);
      if (input.signal?.aborted) throw new NativeExecutionError("External task cancelled before dispatch", "cancelled");
      dispatchAttempted = true;
      const accepted = await connection.request<any>(
        "agent",
        {
          agentId: input.agentId,
          ...modelOverride,
          ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
          sessionKey,
          // Rakazo owns delivery. Mark its internal engine session as webchat so
          // OpenClaw publishes live assistant/tool events to our operator socket.
          channel: "webchat",
          message: input.message,
          extraSystemPrompt:
            "When sharing an existing local document, use its exact absolute path in a Markdown link. Never abbreviate the path with ellipses or invent a file location.\n\n" +
            input.instructions +
            (collaboration
              ? "\n\nRakazo collaboration tools are connected to this bot's active run. Use the provided message_bot/handoff_to_bot tools for Rakazo teammates; tool results confirm delivery. Your Rakazo sender identity and space permissions are supplied by the host. Never substitute a shell command or a claim in plain text for a collaboration tool call."
              : ""),
          idempotencyKey: runId,
          deliver: false,
          timeout: Math.ceil(runMs / 1000),
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        },
        // Attachment parsing/catalog loading can outlast the socket handshake.
        { timeoutMs: options.dispatchMs ?? 60_000 },
      ).catch((error: unknown) => {
        // Only a definitive pre-execution rejection proves the task did not start.
        if (error instanceof Error && "gatewayCode" in error && error.gatewayCode === "INVALID_REQUEST") {
          const message = error.message.includes("active model does not accept image inputs")
            ? `OpenClaw 拒绝了图片：当前模型未声明支持图片输入，请检查模型配置。详情：${error.message}`
            : error.message;
          throw new NativeExecutionError(message, "failed");
        }
        if (error instanceof Error && error.message === "gateway request timeout for agent")
          throw new NativeExecutionError(
            "OpenClaw 未及时确认是否接收任务，当前执行状态未确认，请先核实，勿重复提交。",
            "unconfirmed",
          );
        throw error;
      });
      if (accepted.runId !== runId)
        throw new NativeExecutionError(
          "Native run ID does not match the idempotency key",
          "unconfirmed",
        );
      if (record.status === "dispatching") record.status = "running";
      await persist();
      await input.onStarted?.();
    }
    let unconfirmedPolls = 0;
    const checkStatus = async () => {
      let terminal: any;
      try {
        terminal = await connection.request<any>(
          kernel ? "rakazo.run.status" : "agent.wait",
          kernel ? { runId, sessionKey, startedAt: record.startedAt, engineInstanceId: record.engineInstanceId } : { runId, timeoutMs: Math.min(pollMs, 1000) },
          { timeoutMs: Math.min(pollMs, 1000) + 5000 },
        );
      } catch (error) {
        // Observation is not execution. A timed-out status request must not
        // discard an already-received lifecycle result or redispatch the task.
        if (!/request timeout|request timed out|connection|disconnected|socket|not connected/i.test(String(error))) throw error;
        recovering();
        if (Date.now() - record.startedAt >= runMs)
          return await cancel("External task exceeded its execution deadline");
        if (!outcome) await wait(Math.min(pollMs, 1000));
        return "retry";
      }
      if (paused || record.status === "approval") return "retry";
      if (kernel && terminal.status === "unconfirmed") {
        // One inconclusive poll is not proof that the run was lost: the engine may still
        // be between request registration and its abort controller, or rebuilding its
        // receipt. Observe through a bounded window before holding the session as
        // unconfirmed, so a transient answer cannot freeze it permanently.
        if (++unconfirmedPolls <= (options.unconfirmedPolls ?? 6)) {
          recovering();
          if (Date.now() - record.startedAt >= runMs)
            return await cancel("External task exceeded its execution deadline");
          await wait(Math.min(pollMs, 1000));
          return "retry";
        }
        throw new NativeExecutionError("后台任务状态尚未确认，请勿重复提交；需恢复连接后核对原任务。", "unconfirmed");
      }
      unconfirmedPolls = 0;
      if (terminal.reason === "engine_restarted") await confirmNativeBackgroundWorkStopped(connection, record);
      if (isNativeCancelled(terminal))
        throw new NativeExecutionError("Native task was cancelled", "cancelled");
      if (terminal.status === "error" || terminal.status === "aborted")
        throw new NativeExecutionError(
          String(terminal.error ?? "Native execution failed"),
          terminal.unconfirmed === true
            ? "unconfirmed"
            : terminal.status === "aborted"
              ? "cancelled"
              : "failed",
        );
      if (terminal.status === "running" && record.status === "unconfirmed") {
        record.status = "running";
        delete record.error;
        await persist();
      }
      return terminal.status === "ok" ? "done" : "running";
    };
    while (true) {
      if (paused && input.signal?.aborted) {
        await pending;
        return record.text;
      }
      if (input.signal?.aborted) return await cancel("External task cancelled");
      if (outcome === "failed")
        throw new NativeExecutionError(
          nativeError || "External agent failed",
          nativeErrorUnconfirmed ? "unconfirmed" : "failed",
        );
      if (outcome === "cancelled")
        throw new NativeExecutionError("Native task was cancelled", "cancelled");
      if (outcome === "done") break;
      if (paused) {
        if (Date.now() - record.startedAt >= runMs)
          return await cancel("External task exceeded its execution deadline");
        await wait(Math.min(pollMs, 1000));
        continue;
      }
      if (kernel) {
        const status = await checkStatus();
        if (status === "done") break;
        if (status === "retry") continue;
      }
      if (Date.now() - record.startedAt >= runMs)
        return await cancel("External task exceeded its execution deadline");
      if (collaboration) {
        let batch: { calls: CollaborationCall[] };
        try {
          batch = await connection.request<{ calls: CollaborationCall[] }>(
            "rakazo.tools.poll", { sessionKey, runId },
          );
        } catch (error) {
          if (!/request timeout|request timed out|connection|disconnected|socket|not connected/i.test(String(error))) throw error;
          recovering();
          await wait(Math.min(pollMs, 1000));
          continue;
        }
        if (!Array.isArray(batch.calls) || batch.calls.length > 128)
          throw new Error("Invalid native collaboration response");
        for (const call of batch.calls) {
          input.signal?.throwIfAborted();
          if (!collaboration.tools.some((tool) => tool.name === call.name))
            throw new Error("Native runtime requested an unavailable tool");
          const executionId = `native-tool:${hash(`${runId}:${call.id}`)}`;
          const started = Date.now();
          let result: unknown;
          let error: unknown;
          try {
            result = await collaboration.execute(call.name, call.args, executionId);
          } catch (failure) {
            error = failure;
            result = { error: "Rakazo collaboration tool failed; delivery is not confirmed" };
          }
          const toolPaused = isToolPauseResult(result);
          try {
            await collaboration.completed?.({
              name: call.name,
              executionId,
              durationMs: Date.now() - started,
              result,
              ...(error === undefined ? {} : { error }),
              ...(toolPaused ? { paused: true } : {}),
            });
          } catch {
            /* Audit hooks do not change the tool outcome. */
          }
          if (toolPaused) {
            paused = true;
            record.status = "approval";
            record.approval = {
              kind: "collaboration",
              id: executionId,
              command: call.name,
              callId: call.id,
              decisions: [],
              expiresAtMs: Date.now() + 30 * 60_000,
            };
            await persist();
            collaboration.onPaused();
            return record.text;
          }
          await connection.request("rakazo.tools.resolve", {
            sessionKey,
            runId,
            id: call.id,
            result: result ?? null,
          });
        }
      }
      if (!kernel) {
        const status = await checkStatus();
        if (status === "done") break;
        if (status === "retry") continue;
      }
      if (!outcome && !input.signal?.aborted && input.claimSteering) {
        const steering = await input.claimSteering(record.steeringIds ?? []);
        for (const item of steering) {
          if (input.signal?.aborted) return await cancel("External task cancelled");
          if (outcome) {
            record.unconfirmedSteeringIds = [...(record.unconfirmedSteeringIds ?? []), item.id];
            await persist();
            continue;
          }
          // /steer never starts a second business task if the active run just ended.
          // A deterministic key protects a lost acknowledgement from duplicate delivery.
          const steeringId = `rakazo-steer-${hash(`${input.key}:${item.id}`)}`;
          steeringResults.set(steeringId, undefined);
          let dispatched = false;
          try {
            await connection.request(
              "chat.send",
              {
                sessionKey,
                message: `/steer ${item.text}`,
                idempotencyKey: steeringId,
                deliver: false,
                ...(item.attachments?.length ? { attachments: item.attachments } : {}),
              },
              { timeoutMs: options.connectMs ?? 15_000 },
            );
            dispatched = true;
          } catch {
            // A failed delivery must not disconnect a still-running business task.
          }
          const deadline = Date.now() + (options.connectMs ?? 15_000);
          while (dispatched && !steeringResults.get(steeringId) && Date.now() < deadline) {
            if (input.signal?.aborted) return await cancel("External task cancelled");
            await wait(Math.min(100, deadline - Date.now()));
          }
          const receipt = steeringResults.get(steeringId);
          steeringResults.delete(steeringId);
          if (receipt?.text)
            record.steeringReplies = [...(record.steeringReplies ?? []), receipt.text];
          // Dispatch ACKs precede command execution. Only the command's correlated
          // final response proves the active agent accepted the instruction.
          const delivered =
            receipt?.state === "final" && receipt.text.trim() === "steered current session.";
          record.steeringIds = [...(record.steeringIds ?? []), item.id];
          if (!delivered) {
            record.unconfirmedSteeringIds = [...(record.unconfirmedSteeringIds ?? []), item.id];
            input.onNotice?.({ type: "progress", text: "追加指令尚未确认送达，原任务继续执行。" });
          }
          await persist();
          if (delivered) input.onSteered?.(item.fromRunUser !== false);
        }
      }
      // A timeout here means the status query is still pending, not a failed task.
      await wait(Math.min(pollMs, 1000));
    }
    {
      let nativeResult: NativeRunResult | undefined;
      if (collaboration?.toolMode === "kernel") {
        for (let attempt = 0; attempt < 20; attempt++) {
          const receipt = await connection.request<{ result: NativeRunResult | null }>(
            "rakazo.run.result", { sessionKey, runId },
          );
          if (receipt.result) { nativeResult = receipt.result; break; }
          await wait(100);
        }
        if (!nativeResult || typeof nativeResult.text !== "string" || !nativeResult.text)
          throw new NativeExecutionError(
            "Native task ended without its correlated result; inspect before retrying", "unconfirmed",
          );
      }
      const history = nativeResult ? { messages: [] } :
        await connection.request<any>("chat.history", { sessionKey, limit: 1000, maxChars: 500_000 });
      const commandReplies = new Set(record.steeringReplies ?? []);
      if (record.steeringIds?.length) {
        for (const text of [
          "steered current session.",
          "⚠️ No current session to steer.",
          "⚠️ No active run to steer in this session.",
          "⚠️ Current run is active but not accepting steering right now.",
        ])
          commandReplies.add(text);
      }
      const last = nativeResult ?? (history.messages ?? []).findLast(
        (m: any) =>
          m.role === "assistant" &&
          Number(m.timestamp) >= record.startedAt &&
          !commandReplies.has(textOf(m).trim()),
      );
      if (
        input.modelId !== undefined &&
        last?.model !== input.modelId &&
        `${last?.provider}/${last?.model}` !== input.modelId
      )
        throw new NativeExecutionError(
          "Native result did not confirm the selected model; inspect before retrying",
          "unconfirmed",
        );
      let text = nativeResult?.text ?? textOf(last);
      if (!text)
        throw new NativeExecutionError(
          "Native task completed without a recoverable answer; inspect its session before retrying",
          "unconfirmed",
        );
      if (nativeResult?.blockedTools?.length)
        text += "\n\nRakazo 提示：本轮有工具操作被权限阻止，相关步骤尚未完成。请查看执行记录并处理授权后再继续。";
      if (record.unconfirmedSteeringIds?.length)
        text += "\n\nRakazo 提示：有追加指令尚未确认送达，请核实后重新发送。";
      const replace = !text.startsWith(record.text);
      const delta = replace ? text : text.slice(record.text.length);
      record.text = text;
      const calls = (history.messages ?? []).filter((message: any) =>
        message.role === "assistant" && Number(message.timestamp) >= record.startedAt &&
        message.usage && message.provider !== "openclaw");
      const aliases: Record<string, string> = {
        input: "inputTokens", output: "outputTokens", cacheRead: "cacheReadTokens", cacheWrite: "cacheWriteTokens",
      };
      const fieldValue = (message: any, field: string) => message.usage[field] ?? message.usage[aliases[field] ?? field];
      const sum = (field: string) => calls.length && calls.every((message: any) =>
        typeof fieldValue(message, field) === "number" && Number.isFinite(fieldValue(message, field)))
        ? calls.reduce((total: number, message: any) => total + fieldValue(message, field), 0) : undefined;
      record.usage = nativeResult?.usage ? {
        ...nativeResult.usage, source: "native-run-observed", coverage: "native-attempt",
      } : calls.length ? {
        input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"),
        cacheWrite: sum("cacheWrite"), totalTokens: sum("totalTokens"),
        inputTokens: sum("input"), outputTokens: sum("output"),
        cacheReadTokens: sum("cacheRead"), cacheWriteTokens: sum("cacheWrite"),
        observedCalls: calls.length, source: "native-transcript-observed",
        // No claim that a bounded history page contains an unbounded task's full usage.
        coverage: "observed",
      } : undefined;
      input.onUsage?.(record.usage);
      if (delta) input.onText?.(delta, replace);
    }
    record.status = "done";
    await persist();
    return record.text;
  } catch (error) {
    if (paused && input.signal?.aborted) {
      await pending;
      return record.text;
    }
    const state = error instanceof NativeExecutionError
      ? error.state
      : dispatchAttempted ? "unconfirmed" : "failed";
    record.status = state;
    record.error = error instanceof Error ? error.message : "External runtime failed";
    await persist();
    throw new NativeExecutionError(record.error, state);
  } finally {
    closing = true;
    input.signal?.removeEventListener("abort", onAbort);
    wake?.();
    if (input.collaboration && !paused && record.status !== "unconfirmed")
      await peer?.request("rakazo.tools.close", { sessionKey, runId }).catch(() => undefined);
    // The session belonged to this run only, and its conversation is already quoted into
    // the next turn, so drop it: one entry per turn would otherwise grow the engine's
    // per-agent session store without bound. Unconfirmed runs keep theirs as evidence.
    if (!paused && record.status === "done")
      await peer?.request("sessions.delete",
        { key: sessionKey, deleteTranscript: true, emitLifecycleHooks: false },
        { timeoutMs: 10_000 }).catch(() => undefined);
    peer?.stop();
    await pending;
  }
}
