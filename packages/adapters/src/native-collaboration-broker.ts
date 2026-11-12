import { createHash, randomBytes } from "node:crypto";
import { BUILTIN_TOOL_NAMES } from "@rakazo/contracts";

// The catalog is deliberately restricted. Execution still goes through the run's gate.
export const NATIVE_COLLABORATION_TOOLS = [
  "message_bot",
  "handoff_to_bot",
  "list_fleet",
  "connect_agent",
  "respond_agent_connection",
  "message_agent",
] as const;
const ENGINE_TOOL_NAMES = new Set([
  "shell", "list_files", "read_file", "write_file", "web_search", "web_fetch", "search_memory",
]);
export const NATIVE_ENGINE_TOOLS = [
  "exec", "process", "read", "ls", "find", "grep", "write", "edit", "apply_patch",
  "web_search", "web_fetch", "memory_search", "memory_get",
] as const;
/** Product actions remain host-authorized; ordinary filesystem and shell tools are native. */
export const NATIVE_KERNEL_HOST_TOOLS = [
  ...BUILTIN_TOOL_NAMES.filter(name => !ENGINE_TOOL_NAMES.has(name)), "rakazo_shell", "rakazo_write_file", "rakazo_read_file", "rakazo_list_files", "rakazo_connected_tool",
];
export const isNativeKernelExcludedTool = (name: string) => ENGINE_TOOL_NAMES.has(name);
export const isNativeKernelHostTool = (name: string) =>
  NATIVE_KERNEL_HOST_TOOLS.includes(name as never) ||
  ["list_tools", "get_tool", "use_tool"].includes(name);

export interface CollaborationTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface CollaborationCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export interface NativeRunResult {
  text: string;
  provider: string;
  model: string;
  usage?: Record<string, unknown>;
  blockedTools?: string[];
}
export interface NativeModelCallEnd {
  runId?: string;
  callId?: string;
  durationMs?: number;
  timeToFirstByteMs?: number;
  outcome?: string;
}
type PendingCall = CollaborationCall & {
  fingerprint: string;
  result?: unknown;
  done: boolean;
  cancelled?: boolean;
  resolve(value: unknown): void;
  promise: Promise<unknown>;
};
type RunReceipt = {
  result?: NativeRunResult;
  blockedTools?: Set<string>;
  modelCalls: Map<string, { durationMs: number; generationDurationMs?: number }>;
};
type Registration = {
  toolMode: "collaboration" | "kernel";
  sessionKey: string;
  runId: string;
  tools: CollaborationTool[];
  nativeTools: string[];
  privateContextAllowed: boolean;
  clientToken: string;
  expiresAt: number;
  calls: Map<string, PendingCall>;
  receipt: RunReceipt;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const failed = (error: string) => ({ error });

/** Only the authenticated native control connection may register, poll or resolve calls. */
export class NativeCollaborationBroker {
  private registrations = new Map<string, Registration>();
  // Read-only receipts survive tool expiry/close and subsequent runs in the same session.
  private receipts = new Map<string, RunReceipt>();
  private receipt(sessionKey: unknown, runId: unknown) {
    if (typeof sessionKey !== "string" || typeof runId !== "string")
      throw new Error("Invalid native receipt identity");
    const record = this.receipts.get(JSON.stringify([sessionKey, runId]));
    if (!record) throw new Error("Unknown native receipt identity");
    return record;
  }
  constructor(private now: () => number = Date.now) {}

  private active(sessionKey: unknown, runId?: unknown) {
    const record = typeof sessionKey === "string" ? this.registrations.get(sessionKey) : undefined;
    if (!record || (runId !== undefined && record.runId !== runId))
      throw new Error("No active Rakazo collaboration grant");
    if (record.expiresAt <= this.now()) {
      this.close({ sessionKey: record.sessionKey, runId: record.runId });
      throw new Error("Rakazo collaboration grant expired");
    }
    return record;
  }

  register(params: Record<string, unknown>) {
    const { sessionKey, runId, tools } = params;
    const toolMode = params.toolMode ?? "collaboration";
    const nativeTools = params.nativeTools ?? [];
    const privateContextAllowed = params.privateContextAllowed !== false;
    if (
      typeof sessionKey !== "string" ||
      !/^agent:[a-zA-Z0-9_-]+:rakazo:[a-f0-9]{64}$/.test(sessionKey) ||
      typeof runId !== "string" ||
      !/^rakazo-[a-f0-9]{64}$/.test(runId) ||
      !["collaboration", "kernel"].includes(toolMode as string) ||
      !Array.isArray(tools) ||
      !Array.isArray(nativeTools) || nativeTools.some(name =>
        !NATIVE_ENGINE_TOOLS.includes(name as never)) ||
      (params.privateContextAllowed !== undefined && typeof params.privateContextAllowed !== "boolean") ||
      new Set(nativeTools).size !== nativeTools.length ||
      (toolMode !== "kernel" && nativeTools.length !== 0) ||
      tools.length > (toolMode === "kernel" ? 512 : NATIVE_COLLABORATION_TOOLS.length) ||
      JSON.stringify(tools).length > (toolMode === "kernel" ? 1_024_000 : 128_000) ||
      tools.some(
        (tool) =>
          !object(tool) ||
          (toolMode === "kernel"
            ? typeof tool.name !== "string" || !isNativeKernelHostTool(tool.name)
            : !NATIVE_COLLABORATION_TOOLS.includes(tool.name as never)) ||
          typeof tool.description !== "string" ||
          !object(tool.inputSchema),
      ) ||
      new Set(tools.map((tool) => tool.name)).size !== tools.length
    )
      throw new Error("Invalid Rakazo collaboration registration");
    let prior = this.registrations.get(sessionKey);
    if (prior && prior.expiresAt <= this.now()) {
      this.close({ sessionKey, runId: prior.runId });
      prior = undefined;
    }
    if (prior && (prior.runId !== runId || prior.toolMode !== toolMode ||
      digest(prior.tools) !== digest(tools) || digest(prior.nativeTools) !== digest(nativeTools) ||
      prior.privateContextAllowed !== privateContextAllowed))
      throw new Error("An active collaboration grant cannot change identity or tools");
    const record: Registration = prior ?? {
      sessionKey,
      runId,
      toolMode: toolMode as "collaboration" | "kernel",
      tools: structuredClone(tools),
      nativeTools: structuredClone(nativeTools),
      privateContextAllowed,
      clientToken: randomBytes(32).toString("hex"),
      expiresAt: 0,
      calls: new Map(),
      receipt: this.receipts.get(JSON.stringify([sessionKey, runId])) ?? { modelCalls: new Map() },
    };
    record.expiresAt = this.now() + 30 * 60_000;
    this.registrations.set(sessionKey, record);
    this.receipts.set(JSON.stringify([sessionKey, runId]), record.receipt);
    return { clientToken: record.clientToken };
  }

  tools(sessionKey: string, runId?: string) {
    try {
      const record = this.active(sessionKey, runId);
      return { runId: record.runId, tools: structuredClone(record.tools) };
    } catch {
      return { runId: "", tools: [] };
    }
  }
  kernelSession(sessionKey: string) {
    try { return this.active(sessionKey).toolMode === "kernel"; }
    catch { return false; }
  }
  privateContextAllowed(sessionKey: string) {
    try { return this.active(sessionKey).privateContextAllowed; }
    catch { return false; }
  }
  observeResult(
    event: { runId?: string; provider?: string; model?: string; lastAssistant?: unknown; usage?: unknown },
    context: { sessionKey?: string; runId?: string },
  ) {
    if (!context.sessionKey || !context.runId || event.runId !== context.runId) return;
    let record: RunReceipt;
    try { record = this.receipt(context.sessionKey, context.runId); } catch { return; }
    if (!object(event.lastAssistant) || event.lastAssistant.role !== "assistant" ||
      !Array.isArray(event.lastAssistant.content) || typeof event.provider !== "string" ||
      typeof event.model !== "string") return;
    const text = event.lastAssistant.content.filter(part =>
      object(part) && part.type === "text" && typeof part.text === "string")
      .map(part => part.text).join("");
    if (!text || text.length > 1_000_000) return;
    record.result = { text, provider: event.provider, model: event.model,
      ...(object(event.usage) ? { usage: structuredClone(event.usage) } : {}) };
  }
  observeModelCall(event: NativeModelCallEnd, context: { sessionKey?: string; runId?: string }) {
    if (!context.sessionKey || !context.runId || event.runId !== context.runId ||
      typeof event.callId !== "string" || !event.callId || event.callId.length > 512 ||
      typeof event.durationMs !== "number" || !Number.isFinite(event.durationMs) || event.durationMs < 0 ||
      !["completed", "error"].includes(event.outcome ?? "")) return;
    let record: RunReceipt;
    try { record = this.receipt(context.sessionKey, context.runId); } catch { return; }
    const first = event.timeToFirstByteMs;
    record.modelCalls.set(event.callId, {
      durationMs: event.durationMs,
      ...(typeof first === "number" && Number.isFinite(first) && first >= 0 && first <= event.durationMs
        ? { generationDurationMs: event.durationMs - first } : {}),
    });
  }
  result(params: Record<string, unknown>) {
    const record = this.receipt(params.sessionKey, params.runId);
    const result = record.result ? structuredClone(record.result) : null;
    if (result && record.blockedTools?.size) result.blockedTools = [...record.blockedTools];
    if (result && record.modelCalls.size) {
      const calls = [...record.modelCalls.values()];
      result.usage = {
        ...result.usage,
        modelDurationMs: calls.reduce((total, call) => total + call.durationMs, 0),
        ...(calls.every(call => call.generationDurationMs !== undefined)
          ? { generationDurationMs: calls.reduce((total, call) => total + call.generationDurationMs!, 0) } : {}),
      };
    }
    return { result };
  }
  /** Closed/expired kernel sessions must never fall back to unrestricted engine tools. */
  nativeToolDecision(sessionKey: string, name: string) {
    if (!/^agent:[a-zA-Z0-9_-]+:rakazo:[a-f0-9]{64}$/.test(sessionKey)) return;
    try {
      const record = this.active(sessionKey);
      if (record.toolMode === "collaboration") return;
      if (
        (record.nativeTools.includes(name) || record.tools.some(tool => tool.name === name))) return;
    } catch { /* Missing host grant is a denial, including after stop. */ }
    try {
      const record = this.active(sessionKey);
      (record.receipt.blockedTools ??= new Set()).add(name);
    } catch { /* A missing grant remains denied. */ }
    return { block: true as const, blockReason: "此工具未获得当前 Bot 任务的授权。" };
  }

  /** sessionKey/runId come from the trusted native context, never model tool arguments. */
  async call(sessionKey: string, runId: string, call: CollaborationCall) {
    const record = this.active(sessionKey, runId);
    if (
      typeof call.id !== "string" ||
      !call.id ||
      call.id.length > 512 ||
      !record.tools.some((tool) => tool.name === call.name) ||
      !object(call.args) ||
      JSON.stringify(call.args).length > 128_000
    )
      throw new Error("Invalid collaboration tool call");
    const fingerprint = digest([call.name, call.args]);
    let pending = record.calls.get(call.id);
    if (pending && pending.fingerprint !== fingerprint)
      throw new Error("Collaboration call identity changed");
    if (!pending) {
      if (record.calls.size >= 128) throw new Error("Collaboration call limit exceeded");
      let resolve!: (value: unknown) => void;
      const promise = new Promise<unknown>((done) => {
        resolve = done;
      });
      pending = { ...structuredClone(call), fingerprint, done: false, promise, resolve };
      record.calls.set(call.id, pending);
    }
    // Expiry also releases a pending native tool if its worker never reconnects.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending.promise,
        new Promise((resolve) => {
          timer = setTimeout(
            () => {
              if (this.registrations.get(sessionKey) === record) this.close({ sessionKey, runId });
              resolve(failed("Rakazo collaboration grant expired"));
            },
            Math.max(1, record.expiresAt - this.now()),
          );
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  client(params: Record<string, unknown>) {
    const record = this.active(params.sessionKey, params.runId);
    if (typeof params.clientToken !== "string" || params.clientToken !== record.clientToken)
      throw new Error("Invalid collaboration client");
    return record;
  }

  poll(params: Record<string, unknown>) {
    const record = this.active(params.sessionKey, params.runId);
    return {
      calls: [...record.calls.values()]
        .filter((call) => !call.done)
        .map(({ id, name, args }) => ({ id, name, args })),
    };
  }

  resolve(params: Record<string, unknown>) {
    const record = this.active(params.sessionKey, params.runId);
    const call = record.calls.get(String(params.id));
    if (!call) throw new Error("Unknown collaboration call");
    if (call.cancelled) return { ok: true };
    if (call.done && digest(call.result) !== digest(params.result))
      throw new Error("Collaboration result identity changed");
    call.done = true;
    call.result = params.result;
    call.resolve(params.result);
    return { ok: true };
  }

  cancel(sessionKey: string, runId: string, id: string) {
    const record = this.active(sessionKey, runId);
    const call = record.calls.get(id);
    if (call && !call.done) {
      call.done = true;
      call.cancelled = true;
      call.result = failed("Native collaboration tool call cancelled");
      call.resolve(call.result);
    }
    return { ok: true };
  }

  close(params: Record<string, unknown>) {
    const record =
      typeof params.sessionKey === "string" ? this.registrations.get(params.sessionKey) : undefined;
    if (record && record.runId === params.runId) {
      for (const call of record.calls.values())
        if (!call.done) call.resolve(failed("Rakazo collaboration run closed"));
      this.registrations.delete(record.sessionKey);
    }
    return { ok: true };
  }
}
