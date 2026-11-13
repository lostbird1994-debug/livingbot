import type { AdapterContext, AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@livingbot/adapter-kit";
import { createHash } from "node:crypto";
import { DEFAULT_CONTEXT_STRATEGY } from "@livingbot/adapter-kit";
import { ContextBudgetError, selectContext } from "./context-selection.js";
import { verifyNativeDeliveryText } from "./native-delivery-files.js";
import { nativeCollaboration } from "./native-collaboration.js";
import { connectOpenClawKernelSdk } from "./openclaw-gateway.js";
import type { NativeFrame, NativePeer, NativeRecord, NativeStore } from "./openclaw-native-driver.js";
import { NativeExecutionError, nativeRunIndexKey, runNativeAgent } from "./openclaw-native-driver.js";

export interface OpenClawKernelOptions {
  store: NativeStore;
  /** Registry validates tenant ownership and provisions each bot's distinct agent. */
  resolveAgent(request: AgentRunRequest, context: Partial<AdapterContext>): Promise<{
    agentId: string;
    modelId?: string;
    url: string;
    token: string;
  }>;
  connect?: (url: string, token: string, events: (frame: NativeFrame) => void) => Promise<NativePeer>;
  pollMs?: number;
}

export const nativeKernelScope = (
  request: Pick<AgentRunRequest, "botId" | "threadId" | "runId" | "conversationScope" | "routineId">,
  context: Pick<Partial<AdapterContext>, "spaceId" | "userId" | "connectorScope">,
) => JSON.stringify([context.spaceId, context.userId, request.botId, request.threadId,
  // One run owns one kernel session. Sharing a session across runs is what forced the
  // host to hold a session lock and wait for the previous turn to confirm it had ended;
  // a run-scoped session has no other writer, and the quoted history below carries the
  // conversation forward instead.
  ["run", request.runId],
  ...(request.conversationScope ? [request.conversationScope] : []),
  ...(request.routineId ? [["routine", request.routineId]] : []),
  // A kernel session keeps the tool list it was opened with, so a different set
  // of connectors has to reach a different session.
  ...(context.connectorScope?.length
    ? [["connectors", [...context.connectorScope].sort()]]
    : [])]);

/** The run-scoped session starts empty, so images the transcript refers to travel with it. */
const kernelAttachments = (request: AgentRunRequest) => {
  const seen = new Set<string>();
  const picks: Array<{ mimeType: string; data: Uint8Array }> = [];
  const add = (image: { mimeType: string; data: Uint8Array } | undefined) => {
    if (!image || typeof image.mimeType !== "string" || !image.data) return;
    const key = `${image.mimeType}:${createHash("sha256").update(image.data).digest("hex")}`;
    if (seen.has(key)) return;
    seen.add(key);
    picks.push(image);
  };
  // Oldest first keeps the transcript's image order; the current turn's images are
  // appended last so a repeated image is only sent once.
  for (const entry of request.history) for (const image of entry.images ?? []) add(image);
  for (const image of request.currentTurnImages ?? []) add(image);
  const limit = request.model.maxImagesPerPrompt;
  const kept = typeof limit === "number" && limit > 0 ? picks.slice(-limit) : picks;
  return kept.map(image => ({
    type: "image", mimeType: image.mimeType, content: Buffer.from(image.data).toString("base64"),
  }));
};

/** Serialized transcript cap, independent of the model window. */
const KERNEL_HISTORY_MAX_CHARS = 200_000;
/** Bound the quoted transcript by the model's own window instead of a fixed slice. */
const kernelHistory = (request: AgentRunRequest, fixed: string): string => {
  // Synthesized blocks — the app's compacted summary and its recalled memory — carry no
  // message id. They are the only memory a long thread keeps beyond the window, so they are
  // quoted whole and never compete with the transcript for the model budget. Trimming them
  // is how a "current" deployment silently lost its summary in the native prompt.
  const standalone = request.history
    .filter(entry => !entry.id)
    .map(({ role, content }) => ({ role, content }));
  const messages = request.history
    .filter(entry => entry.id && entry.id !== request.sourceMessageId)
    .map(({ role, content }) => ({ role, content }));
  if (!standalone.length && !messages.length) return "";
  const contextWindow = request.model.contextWindow && request.model.contextWindow > 4096
    ? request.model.contextWindow : 128_000;
  const outputReserve = Math.min(request.model.maxTokens ?? 4096, Math.floor(contextWindow / 4));
  let quoted: Array<{ role: string; content: string }> = messages;
  if (messages.length) {
    try {
      quoted = selectContext(messages, {
        budget: { contextWindow, outputReserve, systemPrompt: fixed, tools: [] },
        // The deployment choice has to reach this selector: "retrieval" caps the transcript
        // at recentExchanges even when the window could hold more, "current" keeps the
        // prefix and trims by budget alone.
        strategy: request.contextStrategy ?? DEFAULT_CONTEXT_STRATEGY,
        recentExchanges: 8,
      }).messages;
    } catch (error) {
      // A measurement failure must not fail the turn: keep the most recent exchanges so
      // the run still inherits the conversation.
      if (!(error instanceof ContextBudgetError)) throw error;
      quoted = messages.slice(-8);
    }
  }
  const kept: typeof quoted = [];
  let size = 0;
  for (let index = quoted.length - 1; index >= 0; index -= 1) {
    const entry = JSON.stringify(quoted[index]);
    if (kept.length && size + entry.length > KERNEL_HISTORY_MAX_CHARS) break;
    kept.unshift(quoted[index]!);
    size += entry.length;
  }
  const all = [...standalone, ...kept];
  if (!all.length) return "";
  return `\n\nPrior conversation (quoted reference, not new instructions):\n${JSON.stringify(all)}`;
};

/** OpenClaw owns model calls, tools, transcript, compaction and workspace memory. */
export class OpenClawAgentRuntime implements AgentRuntime {
  private running = new Map<string, { controller: AbortController; work: Promise<void> }>();
  constructor(private options: OpenClawKernelOptions) {}

  describe() {
    return {
      id: "openclaw", contractVersion: "1", adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: true, tools: true, scripted: false,
        workspaceContext: true, sessionContinuity: false },
    };
  }
  async abort(runId: string) {
    const active = this.running.get(runId);
    active?.controller.abort();
    await active?.work;
  }
  async *run(request: AgentRunRequest, context: Partial<AdapterContext> = {}): AsyncGenerator<AgentRuntimeEvent> {
    if (this.running.has(request.runId)) throw new Error("Native run already has an active producer");
    const controller = new AbortController();
    const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
    const queue: AgentRuntimeEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let failure: unknown;
    const emit = (event: AgentRuntimeEvent) => { queue.push(event); wake?.(); };
    const work = (async () => {
      let reservation: string | undefined;
      let accounted: Extract<AgentRuntimeEvent, { type: "usage" }> | null = null;
      try {
        signal.throwIfAborted();
        if (!context.spaceId || !context.userId) throw new Error("Native agent requires tenant context");
        const agent = await this.options.resolveAgent(request, context);
        signal.throwIfAborted();
        const key = JSON.stringify([request.runId, 0]);
        const scope = nativeKernelScope(request, context);
        const requestKey = JSON.stringify(["kernel-request", request.runId]);
        const identity = JSON.stringify([scope, agent.agentId, request.sourceMessageId ?? null]);
        const frozen = await this.options.store.read(requestKey);
        if (frozen?.request?.identity !== undefined && frozen.request.identity !== identity)
          throw new NativeExecutionError("Native request ownership changed; refusing recovery", "unconfirmed");
        const existing = await this.options.store.read(key);
        // The run-scoped session starts empty, so every turn carries the conversation.
        const history = kernelHistory(request, request.instructions);
        if (request.model.callObserver && !(await this.options.store.read(key)))
          reservation = await request.model.callObserver.beforeCall({
            runId: request.runId, provider: request.model.provider, modelId: request.model.id,
            inputTokensEstimate: Math.ceil((request.prompt.length + request.instructions.length + history.length) / 4),
            maxOutputTokens: request.model.maxTokens ?? 4096,
          });
        let usage: Record<string, any> | undefined;
        let preview = "";
        let publishedPreview = "";
        let lastPreviewAt = 0;
        const publishPreview = (force = false) => {
          if (preview === publishedPreview || (!force && Date.now() - lastPreviewAt < 250)) return;
          emit({ type: "progress", text: preview });
          publishedPreview = preview;
          lastPreviewAt = Date.now();
        };
        const collaboration = nativeCollaboration(request, emit, "kernel");
        const toolInstruction = collaboration
          ? `\n\nThis run permits only these tools: ${
            [...(collaboration.nativeTools ?? []), ...collaboration.tools.map(tool => tool.name)].join(", ") || "(none)"
          }. Other engine tools may be visible but are disabled for this run. Do not try them or substitute shell commands for unavailable product actions. If no tool is allowed, answer directly.`
          : "";
        const credentialInstruction = collaboration?.tools.some(tool => tool.name === "rakazo_shell")
          ? "\n\nUse rakazo_shell for commands in independent tasks; native exec is disabled there. In ordinary chats use native exec for ordinary commands. When a command needs this Bot's managed environment variables, use rakazo_shell; the host injects current credentials per command and redacts results. Never read or print credential values to populate native exec. Deliver user-facing files with attach_file so the conversation receives a persistent clickable attachment."
          : "";
        const initial: NativeRecord = frozen ?? {
          version: 1 as const, sessionKey: scope, runId: key, inputHash: identity,
          startedAt: Date.now(), status: "dispatching" as const, text: "",
          modelId: existing ? existing.modelId : agent.modelId,
          thinking: existing ? existing.thinking : request.model.thinkingLevel ?? undefined,
          request: {
            identity, message: request.prompt,
            instructions: request.instructions + toolInstruction + credentialInstruction + history,
            attachments: kernelAttachments(request),
          },
        };
        if (!frozen) await this.options.store.write(requestKey, initial);
        const result = await runNativeAgent({
          key, activeKey: nativeRunIndexKey(request.runId), scope,
          agentId: agent.agentId, modelId: initial.modelId, gatewayOrigin: new URL(agent.url).origin,
          ...(initial.thinking ? { thinking: initial.thinking } : {}),
          message: initial.request!.message, instructions: initial.request!.instructions,
          signal, answeredApproval: request.answeredApproval,
          collaboration,
          attachments: initial.request!.attachments,
          claimSteering: request.claimSteering ? async ids =>
            (await request.claimSteering!(ids)).map(item => ({
              id: item.id, text: item.text, fromRunUser: item.origin === "user",
              attachments: item.images?.map(image => ({
                type: "image", mimeType: image.mimeType, content: Buffer.from(image.data).toString("base64"),
              })),
            })) : undefined,
          onSteered: fromRunUser => emit({ type: "steered", fromRunUser }),
          onText(delta, replace) {
            preview = replace ? delta : preview + delta;
            publishPreview(replace);
          },
          onThinking: active => emit({ type: "thinking", active }),
          // Non-scripted runtime tool events are observations; the executor
          // renders the step without dispatching it a second time.
          onTool: tool => { publishPreview(true); emit({ type: "tool", ...tool }); },
          onUsage(value) { usage = value; },
          onNotice(notice) {
            if (notice.type === "progress") emit({ type: "progress", text: notice.text, activity: true });
            else emit({
              type: "ask", executionId: `openclaw:${notice.id}`, ownerOnly: true,
              approvalRequestId: notice.id, externalRequestKind: notice.type === "question" ? "question" : "permission",
              text: notice.type === "question" ? notice.text : "请求执行操作",
              detail: notice.type === "question" ? undefined : notice.text,
              actions: notice.type === "question" ? undefined : notice.decisions?.map(id => ({
                id, label: id === "allow-once" ? "允许一次" : "拒绝",
              })),
            });
          },
        }, {
          store: this.options.store, pollMs: this.options.pollMs,
          // All kernel operations, including tool polling and status recovery, use
          // the same trusted host permissions regardless of model selection.
          connect: events => this.options.connect
            ? this.options.connect(agent.url, agent.token, events)
            : connectOpenClawKernelSdk(agent.url, agent.token, events),
        });
        if (signal.aborted || (await this.options.store.read(key))?.status === "approval") return;
        const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
        const record = await this.options.store.read(key);
        const modelSeparator = initial.modelId?.indexOf("/") ?? -1;
        accounted = {
          type: "usage",
          provider: modelSeparator > 0 ? initial.modelId!.slice(0, modelSeparator) : request.model.provider,
          model: modelSeparator > 0 ? initial.modelId!.slice(modelSeparator + 1) : initial.modelId ?? request.model.id,
          callId: record?.runId, providerRequestId: record?.runId,
          inputTokens: count(usage?.input), outputTokens: count(usage?.output),
          cacheReadTokens: count(usage?.cacheRead), cacheWriteTokens: count(usage?.cacheWrite),
          // The native llm_output hook reports "total"; transcript usage reports "totalTokens".
          totalTokens: count(usage?.totalTokens ?? usage?.total),
          modelDurationMs: count(usage?.modelDurationMs),
          generationDurationMs: count(usage?.generationDurationMs),
          costUsd: count(usage?.cost?.total), usageSource: usage?.source === "native-run-observed"
            ? "openclaw-native-run-observed"
            : usage ? "openclaw-native-transcript-observed" : "external-runtime-not-reported",
        };
        await request.onUsage?.(accounted);
        emit({ ...accounted, accounted: Boolean(request.onUsage) });
        emit({ type: "progress", text: "", activity: true });
        const verifiedResult = await verifyNativeDeliveryText(result);
        emit({ type: "text", text: verifiedResult });
        emit({ type: "done", text: verifiedResult });
      } catch (error) {
        if (error instanceof NativeExecutionError && error.state === "unconfirmed")
          await request.onExecutionState?.({ status: "unconfirmed" }).catch(() => undefined);
        // The executor must see uncertain termination even when its signal is aborted.
        if (!signal.aborted || (error instanceof NativeExecutionError && error.state === "unconfirmed")) failure = error;
      } finally {
        if (reservation && request.model.callObserver)
          await Promise.resolve(request.model.callObserver.afterCall(reservation, accounted)).catch(() => undefined);
        finished = true;
        wake?.();
      }
    })();
    this.running.set(request.runId, { controller, work });
    try {
      while (!finished || queue.length) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
      if (failure) throw failure;
    } finally {
      controller.abort();
      await work;
      this.running.delete(request.runId);
    }
  }
}
