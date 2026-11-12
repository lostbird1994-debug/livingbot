import {
  NATIVE_COLLABORATION_TOOLS,
  NATIVE_KERNEL_HOST_TOOLS,
  NativeCollaborationBroker,
} from "./native-collaboration-broker.js";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NativeModelCallEnd } from "./native-collaboration-broker.js";
import { NativeProcessControl } from "./openclaw-process-control.js";
import type { NativeBootstrapEvent } from "./openclaw-workspace-context.js";
import { NativeWorkspaceContext } from "./openclaw-workspace-context.js";

// OpenClaw loads separate gateway and tool-discovery registries in one process.
// They must share pending calls, including when it imports the extension again.
const processState = globalThis as unknown as Record<symbol, NativeCollaborationBroker>;
const brokerKey = Symbol.for("rakazo.collaboration.broker.v1");
const broker = processState[brokerKey] ?? new NativeCollaborationBroker();
processState[brokerKey] = broker;
const processKey = Symbol.for("rakazo.process.control.v1");
const engineState = globalThis as unknown as Record<symbol, NativeProcessControl>;
// Background handles must survive an engine restart: without the ledger a restarted
// engine cannot prove that a command it started has already exited, and the session
// guard would stay closed forever.
const processLedger = join(homedir(), ".openclaw", ".rakazo", "process-owners.json");
const processes = engineState[processKey] ?? new NativeProcessControl(undefined, processLedger);
engineState[processKey] = processes;
const instanceKey = Symbol.for("rakazo.native-engine-instance.v1");
const instanceState = globalThis as unknown as Record<symbol, { id: string; startedAt: number }>;
const engineInstance = instanceState[instanceKey] ?? {
  id: randomUUID(), startedAt: Date.now() - process.uptime() * 1000,
};
instanceState[instanceKey] = engineInstance;
// A run can only reach "no abort controller" once its chat request ended. The grace
// covers registration/dispatch handshakes and short pauses, so a missing status payload
// becomes a terminal, evidence-backed answer instead of an unconfirmed dead end.
const SETTLEMENT_GRACE_MS = 180_000;
export const nativeHostToolNames = [...new Set([
  ...NATIVE_COLLABORATION_TOOLS, ...NATIVE_KERNEL_HOST_TOOLS, "list_tools", "get_tool", "use_tool",
])];

// Structural boundary keeps OpenClaw optional; the extension is bundled separately.
interface PluginApi {
  pluginConfig?: Record<string, unknown>;
  runtime?: { config: { loadConfig(): Record<string, any> } };
  registerHook?(event: string, handler: (event: NativeBootstrapEvent) => Promise<void>, options: { name: string }): void;
  on?: {
    (hook: "model_call_ended",
      handler: (event: NativeModelCallEnd, context: { sessionKey?: string; runId?: string }) => void): void;
    (hook: "llm_output",
      handler: (event: { runId?: string; provider?: string; model?: string; lastAssistant?: unknown; usage?: unknown },
        context: { sessionKey?: string; runId?: string }) => void): void;
    (hook: "before_tool_call",
      handler: (event: { toolName: string }, context: { sessionKey?: string }) =>
        { block: true; blockReason: string } | undefined): void;
    (hook: "after_tool_call",
      handler: (event: { toolName: string; runId?: string; result?: unknown },
        context: { sessionKey?: string; runId?: string }) => void): void;
    (hook: "before_prompt_build",
      handler: (event: unknown, context: { agentId?: string; sessionKey?: string }) =>
        Promise<{ appendSystemContext: string } | undefined>): void;
  };
  registerGatewayMethod(
    name: string,
    handler: (options: {
      params: Record<string, unknown>;
      context?: {
        dedupe: Map<string, { payload?: unknown; error?: { message?: string } }>;
        chatAbortControllers: Map<string, { sessionKey?: string }>;
      };
      respond(ok: boolean, payload?: unknown, error?: { code: string; message: string }): void;
    }) => void,
    options: { scope: "operator.write" },
  ): void;
  registerTool(
    factory: (context: { sessionKey?: string }) => unknown,
    options: { names: string[] },
  ): void;
}
export default {
  id: "rakazo-collaboration",
  name: "Rakazo collaboration",
  register(api: PluginApi) {
    // Installed extensions cannot register bundled-only trusted tool policies.
    // The supported before-tool hook enforces the same run-owned capability grant.
    api.on?.("before_tool_call", (event, context) =>
      context.sessionKey ? broker.nativeToolDecision(context.sessionKey, event.toolName) : undefined);
    api.registerGatewayMethod("rakazo.task.capabilities", ({ respond }) => respond(true, { managedSessions: true, hostFileTools: true, version: 1 }), { scope: "operator.write" });
    api.on?.("llm_output", (event, context) => broker.observeResult(event, context));
    api.on?.("model_call_ended", (event, context) => broker.observeModelCall(event, context));
    api.on?.("after_tool_call", (event, context) => processes.observe(event, context));
    if (typeof api.pluginConfig?.registryFile === "string" && api.runtime?.config) {
      const config = api.runtime.config;
      const workspaces = new NativeWorkspaceContext({
        registryFile: api.pluginConfig.registryFile,
        config: () => config.loadConfig(),
      });
      api.registerHook?.("agent:bootstrap", async event => {
        if (!event.context.sessionKey || broker.kernelSession(event.context.sessionKey))
          await workspaces.bootstrap(event, !event.context.sessionKey ||
            broker.privateContextAllowed(event.context.sessionKey));
      }, { name: "rakazo-workspace-files" });
      api.on?.("before_prompt_build", async (_event, context) =>
        context.agentId && context.sessionKey && broker.kernelSession(context.sessionKey)
          ? workspaces.guidance(context.agentId, broker.privateContextAllowed(context.sessionKey)) : undefined);
      api.registerGatewayMethod("rakazo.context.preview", async ({ params, respond }) => {
        try { respond(true, await workspaces.preview(params)); }
        catch { respond(false, undefined, { code: "INVALID_REQUEST", message: "Native context preview is unavailable" }); }
      }, { scope: "operator.write" });
    }
    api.registerGatewayMethod("rakazo.process.control", async ({ params, respond }) => {
      try {
        respond(true, await processes.control(params));
      } catch (error) {
        const message = error instanceof Error && /^(Native process|OpenClaw process|Native process control)/.test(error.message)
          ? error.message : "Native process control backend is unavailable";
        respond(false, undefined, {
          code: "INVALID_REQUEST", message,
        });
      }
    }, { scope: "operator.write" });
    api.registerGatewayMethod("rakazo.run.status", ({ params, respond, context }) => {
      // Validate the run-owned receipt independently of tool authorization. Attempt
      // lifecycle events and agent.wait's lifecycle cache are not final receipts.
      const { runId, sessionKey } = params;
      if (typeof runId !== "string" || !/^rakazo-[a-f0-9]{64}$/.test(runId) ||
        typeof sessionKey !== "string" || !/^agent:[a-zA-Z0-9_-]+:rakazo:[a-f0-9]{64}$/.test(sessionKey)) {
        respond(true, { status: "unconfirmed" });
        return;
      }
      let known = false;
      try {
        broker.result(params);
        known = true;
      } catch { /* Receipt memory can be lost when the engine process restarts. */ }
      if (known) {
        const entry = context?.dedupe.get(`agent:${runId}`);
        const payload = entry?.payload as Record<string, any> | undefined;
        if (payload?.runId === runId && ["ok", "error", "timeout"].includes(payload.status)) {
          const executionError = payload.result?.meta?.error;
          respond(true, {
            status: executionError ? "error" : payload.status === "timeout" ? "aborted" : payload.status,
            error: executionError?.message ?? entry?.error?.message ?? payload.summary,
          });
          return;
        }
        if (payload?.runId === runId && payload.status === "accepted") {
          respond(true, { status: "running" });
          return;
        }
      }
      const active = context?.chatAbortControllers.get(runId);
      if (active && (active.sessionKey === sessionKey || (known && !active.sessionKey))) {
        respond(true, { status: "running" });
        return;
      }
      const sessionActive = context && [...context.chatAbortControllers.values()]
        .some(entry => entry.sessionKey === sessionKey);
      const instanceChanged = typeof params.engineInstanceId === "string"
        ? params.engineInstanceId !== engineInstance.id
        : typeof params.startedAt === "number" && Number.isFinite(params.startedAt) && params.startedAt > 0 &&
          params.startedAt < engineInstance.startedAt - 1000;
      // This proves controller termination, not business success or rollback.
      // The host separately verifies any background command handles it observed.
      if (context && !active && !sessionActive && instanceChanged) {
        respond(true, { status: "error", reason: "engine_restarted",
          error: "执行内核已重启，原任务已中断；此前操作可能已经执行，请核实结果后再决定是否重做。" });
        return;
      }
      // A receipt proves this engine accepted the run. With the process unchanged and
      // no live controller for the run or its session, nothing is executing it any
      // more: the volatile dedupe cache losing the terminal payload must not pin an
      // already-finished run to "unconfirmed" forever and lock the session. Report a
      // terminal outcome instead, preferring the receipt's own answer as the result.
      const startedAt =
        typeof params.startedAt === "number" && Number.isFinite(params.startedAt) && params.startedAt > 0
          ? params.startedAt : 0;
      if (context && known && !active && !sessionActive && startedAt &&
        Date.now() - startedAt >= SETTLEMENT_GRACE_MS) {
        let receiptResult: unknown;
        try { receiptResult = broker.result(params).result; } catch { /* Receipt lost by a restart. */ }
        const text = receiptResult && typeof receiptResult === "object"
          ? (receiptResult as { text?: unknown }).text : undefined;
        if (typeof text === "string" && text) {
          respond(true, { status: "ok", recovered: true });
          return;
        }
        respond(true, { status: "error", reason: "outcome_unavailable",
          error: "上一轮任务已经结束，但执行内核没有保留终态回执；结果可能已经产生，请核实后再决定是否重做。" });
        return;
      }
      respond(true, { status: "unconfirmed" });
    }, { scope: "operator.write" });
    api.registerGatewayMethod("rakazo.run.result", ({ params, respond }) => {
      try { respond(true, broker.result(params)); }
      catch { respond(false, undefined, { code: "INVALID_REQUEST", message: "Native run result is unavailable" }); }
    }, { scope: "operator.write" });
    for (const method of ["register", "poll", "resolve", "close"] as const) {
      api.registerGatewayMethod(
        `rakazo.tools.${method}`,
        ({ params, respond }) => {
          try {
            const result = broker[method](params);
            respond(true, method === "register" ? { ...result, engineInstanceId: engineInstance.id } : result);
          } catch {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "Rakazo collaboration request rejected",
            });
          }
        },
        { scope: "operator.write" },
      );
    }
    api.registerTool(
      (context) => {
        if (!context.sessionKey) return null;
        const sessionKey = context.sessionKey;
        const { runId, tools } = broker.tools(sessionKey);
        return tools.map((tool) => ({
          name: tool.name,
          label: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          async execute(id: string, args: Record<string, unknown>, signal?: AbortSignal) {
            signal?.throwIfAborted();
            const cancel = () => {
              try {
                broker.cancel(sessionKey, runId, id);
              } catch {
                /* Grant already closed. */
              }
            };
            const pending = broker.call(sessionKey, runId, { id, name: tool.name, args });
            signal?.addEventListener("abort", cancel, { once: true });
            try {
              const result = await pending;
              signal?.throwIfAborted();
              return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
            } finally {
              signal?.removeEventListener("abort", cancel);
            }
          },
        }));
      },
      { names: nativeHostToolNames },
    );
  },
};
