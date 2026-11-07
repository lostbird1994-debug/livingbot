import { createHash } from "node:crypto";

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
  modelId?: string;
  startedAt: number;
  status: "dispatching" | "running" | "approval" | "done" | "failed" | "cancelled" | "unconfirmed";
  text: string;
  usage?: Record<string, unknown>;
  gatewayOrigin?: string;
  connectionId?: string;
  error?: string;
  approval?: {
    id: string;
    expiresAtMs: number;
    command: string;
    decisions: string[];
    kind?: "question";
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
  scope: string;
  agentId: string;
  modelId?: string;
  gatewayOrigin?: string;
  connectionId?: string;
  message: string;
  instructions: string;
  signal?: AbortSignal;
  answeredApproval?: { id: string; actionId: string };
  attachments?: unknown[];
  onText?: (delta: string) => void;
  onNotice?: (notice: NativeNotice) => void;
  onStarted?: () => Promise<void>;
  onUsage?: (usage: Record<string, unknown> | undefined) => void;
}
export interface NativeOptions {
  store: NativeStore;
  connect(onEvent: (frame: NativeFrame) => void): Promise<NativePeer>;
  connectMs?: number;
  runMs?: number;
  cancelMs?: number;
  pollMs?: number;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const nativeSessionKey = (scope: string, agentId: string) =>
  `agent:${agentId}:rakazo:${hash(scope)}`;
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
    ]),
  );
  const saved = await options.store.read(input.key);
  if (
    saved &&
    (saved.sessionKey !== sessionKey ||
      saved.runId !== runId ||
      saved.modelId !== input.modelId ||
      (saved.inputHash !== inputHash && saved.status !== "approval"))
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
  if (saved && ["failed", "cancelled", "unconfirmed"].includes(saved.status))
    throw new NativeExecutionError(
      saved.error ?? "External task requires an explicit new run",
      saved.status,
    );
  const sessionOwnerKey = `session-owner:${sessionKey}`;
  const owner = await options.store.read(sessionOwnerKey);
  if (
    owner &&
    owner.runId !== runId &&
    ["dispatching", "running", "approval", "unconfirmed"].includes(owner.status)
  )
    throw new NativeExecutionError(
      "An earlier task in this native session is unresolved; inspect it before submitting another task",
      "unconfirmed",
    );
  let lastStoredStatus: NativeRecord["status"] | undefined;
  let lastTextPersistAt = 0;
  let record: NativeRecord = saved ?? {
    version: 1,
    sessionKey,
    runId,
    inputHash,
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
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
      if (writeOwner) await options.store.write(sessionOwnerKey, { ...snapshot, text: "" });
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
  const notify = () => wake?.();
  const onEvent = (frame: NativeFrame) => {
    if (closing) return;
    const p = frame.payload ?? {};
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
      if (p.state === "error") {
        outcome = "failed";
        nativeError = String(p.errorMessage ?? "External agent failed");
      }
      // Agent RPC's lifecycle is authoritative; a chat delta may contain cumulative text.
    }
    if (frame.event === "agent") {
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
      if (p.stream === "tool") {
        const name = String(p.data?.name ?? "tool");
        const phase = String(p.data?.phase ?? "update");
        input.onNotice?.({ type: "progress", text: `${name}: ${phase}` });
      }
      if (p.stream === "lifecycle") {
        if (p.data?.phase === "end") outcome = "done";
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
    // 'aborted' acknowledges the signal; agent.wait proves that the native runner settled.
    if (!result.aborted && !outcome) {
      const current = await peer.request<any>(
        "agent.wait",
        { runId, timeoutMs: Math.min(cancelMs, 1000) },
        { timeoutMs: cancelMs },
      );
      if (current.status !== "ok" && current.status !== "error" && current.status !== "aborted")
        throw new NativeExecutionError(
          "Cancellation could not be confirmed; do not retry this task",
          "unconfirmed",
        );
    } else if (!outcome) {
      const terminal = await bounded(
        peer.request<any>(
          "agent.wait",
          { runId, timeoutMs: cancelMs },
          { timeoutMs: cancelMs + 1000 },
        ),
        cancelMs + 1000,
        "Native cancellation did not settle",
      );
      if (!["ok", "error", "aborted"].includes(terminal.status))
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
    input.signal?.throwIfAborted();
    const connection: NativePeer = await bounded(
      options.connect(onEvent).then((value) => {
        if (closing) value.stop();
        return value;
      }),
      options.connectMs ?? 15_000,
      "External runtime connection timed out",
    );
    peer = connection;
    if (record.status === "approval") {
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
      // Persist BEFORE dispatch. A process crash or lost ACK must never launch another task.
      await persist();
      const accepted = await connection.request<any>(
        "agent",
        {
          agentId: input.agentId,
          ...(input.modelId !== undefined ? { model: input.modelId } : {}),
          sessionKey,
          message: input.message,
          extraSystemPrompt: input.instructions,
          idempotencyKey: runId,
          deliver: false,
          timeout: Math.ceil(runMs / 1000),
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        },
        { timeoutMs: options.connectMs ?? 15_000 },
      );
      if (accepted.runId !== runId)
        throw new NativeExecutionError(
          "Native run ID does not match the idempotency key",
          "unconfirmed",
        );
      if (record.status === "dispatching") record.status = "running";
      await persist();
      await input.onStarted?.();
    }
    while (true) {
      if (paused && input.signal?.aborted) {
        await pending;
        return record.text;
      }
      if (input.signal?.aborted) return await cancel("External task cancelled");
      if (Date.now() - record.startedAt >= runMs)
        return await cancel("External task exceeded its execution deadline");
      if (outcome === "failed")
        throw new NativeExecutionError(
          nativeError || "External agent failed",
          nativeErrorUnconfirmed ? "unconfirmed" : "failed",
        );
      if (outcome === "cancelled")
        throw new NativeExecutionError("Native task was cancelled", "cancelled");
      if (outcome === "done") break;
      if (paused) {
        await wait(Math.min(pollMs, 1000));
        continue;
      }
      const terminal = await connection.request<any>(
        "agent.wait",
        { runId, timeoutMs: Math.min(pollMs, 1000) },
        { timeoutMs: Math.min(pollMs, 1000) + 5000 },
      );
      if (paused || record.status === "approval") continue;
      if (terminal.stopReason === "aborted")
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
      if (terminal.status === "ok") break;
      // A timeout here means the status query is still pending, not a failed task.
      await wait(Math.min(pollMs, 1000));
    }
    {
      const history = await connection.request<any>("chat.history", { sessionKey, limit: 20 });
      const last = (history.messages ?? []).findLast(
        (m: any) => m.role === "assistant" && Number(m.timestamp) >= record.startedAt,
      );
      if (input.modelId !== undefined && last?.model !== input.modelId)
        throw new NativeExecutionError(
          "Native result did not confirm the selected model; inspect before retrying",
          "unconfirmed",
        );
      const text = textOf(last);
      if (!text)
        throw new NativeExecutionError(
          "Native task completed without a recoverable answer; inspect its session before retrying",
          "unconfirmed",
        );
      const delta = text.startsWith(record.text) ? text.slice(record.text.length) : text;
      record.text = text;
      record.usage = last?.usage;
      input.onUsage?.(record.usage);
      if (delta) input.onText?.(delta);
    }
    record.status = "done";
    await persist();
    return record.text;
  } catch (error) {
    if (paused && input.signal?.aborted) {
      await pending;
      return record.text;
    }
    const state = error instanceof NativeExecutionError ? error.state : "unconfirmed";
    record.status = state;
    record.error = error instanceof Error ? error.message : "External runtime failed";
    await persist();
    throw new NativeExecutionError(record.error, state);
  } finally {
    closing = true;
    input.signal?.removeEventListener("abort", onAbort);
    wake?.();
    peer?.stop();
    await pending;
  }
}
