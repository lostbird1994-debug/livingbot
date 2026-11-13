import { join } from "node:path";
import type { AdapterContext, AgentRunRequest, AgentRuntimeEvent } from "@livingbot/adapter-kit";
import { parseLocalAgentSelection } from "./local-agent-model.js";
import { nativeCollaboration } from "./native-collaboration.js";
import {
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
} from "./openai-compatible-url.js";
import { NativeRunJournal } from "./openclaw-gateway.js";
import type { NativeFrame, NativePeer, NativeStore } from "./openclaw-native-driver.js";
import {
  NativeExecutionError,
  runNativeAgent,
} from "./openclaw-native-driver.js";

export const isLocalAgentModel = (model: AgentRunRequest["model"]) =>
  model.provider === "openai-compatible" && Boolean(parseLocalAgentSelection(model.id));

/** A local authenticated lifecycle bridge; no model completions or shell commands cross this API. */
export async function connectLocalAgentBridge(
  url: string,
  token: string,
  onEvent: (frame: NativeFrame) => void,
): Promise<NativePeer> {
  const base = new URL(url);
  if (base.protocol === "ws:") base.protocol = "http:";
  if (base.protocol === "wss:") base.protocol = "https:";
  if (
    !["http:", "https:"].includes(base.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("Local Agent bridge must use an authenticated loopback endpoint");
  const controller = new AbortController();
  const headers = { Authorization: `Bearer ${token}` };
  const timer = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(new URL("/events", base), {
      headers,
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok || !response.body) {
    controller.abort();
    throw new Error("Local Agent bridge authentication failed");
  }
  // The response is a long-lived stream. The initial fetch timeout must not remain
  // attached to it, so use an explicit handshake timer instead of a lifetime timeout.
  let closed = false;
  void (async () => {
    let pending = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body!) {
        pending += decoder.decode(chunk, { stream: true });
        if (pending.length > 2 * 1024 * 1024) throw new Error("Native event exceeds limit");
        let end = pending.indexOf("\n");
        while (end >= 0) {
          const line = pending.slice(0, end).trim();
          pending = pending.slice(end + 1);
          if (line.startsWith("data:")) {
            const event: unknown = JSON.parse(line.slice(5));
            if (
              event &&
              typeof event === "object" &&
              "event" in event &&
              typeof event.event === "string"
            )
              onEvent(event as NativeFrame);
          }
          end = pending.indexOf("\n");
        }
      }
    } catch {
      /* Status RPCs keep uncertain disconnects from becoming success. */
    } finally {
      closed = true;
    }
  })();
  return {
    request: async <T>(
      method: string,
      params?: unknown,
      options?: { timeoutMs?: number },
    ): Promise<T> => {
      if (closed) throw new Error("Native event connection closed");
      const result = await fetch(new URL("/rpc", base), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ method, params }),
        redirect: "error",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(options?.timeoutMs ?? 15_000),
        ]),
      });
      if (!result.ok) throw new Error("Native lifecycle request failed; do not repeat the task");
      const body = (await result.json()) as { result: T };
      return body.result;
    },
    stop: () => {
      closed = true;
      controller.abort();
    },
  };
}

export async function* runLocalAgent(
  request: AgentRunRequest,
  context: Partial<AdapterContext>,
  dependencies: { store?: NativeStore; connect?: typeof connectLocalAgentBridge } = {},
): AsyncGenerator<AgentRuntimeEvent> {
  const controller = new AbortController();
  const signal = context.signal
    ? AbortSignal.any([controller.signal, context.signal])
    : controller.signal;
  const queue: AgentRuntimeEvent[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  let failure: unknown;
  const emit = (event: AgentRuntimeEvent) => {
    queue.push(event);
    wake?.();
  };
  const work = (async () => {
    let reservation: string | undefined;
    let preparedPeer: NativePeer | undefined;
    let nativeEvent: (event: NativeFrame) => void = () => {};
    let billedUsage: Extract<AgentRuntimeEvent, { type: "usage" }> | null = null;
    try {
      const base = assertAllowedOpenAiCompatibleUrl(request.model.baseUrl ?? "", {
        allowPrivate: request.model.allowPrivateEndpoint,
      });
      assertHttpsForKeyedOpenAiCompatibleUrl(base, request.model.apiKey);
      const url = new URL(base);
      url.pathname = "/";
      if (!request.model.apiKey) throw new Error("Local Agent connection requires authentication");
      const selection = parseLocalAgentSelection(request.model.id);
      if (!selection) throw new Error("Invalid native Agent model selection");
      const { engine } = selection;
      const store =
        dependencies.store ??
        new NativeRunJournal(
          join(process.env.DATA_DIR ?? "./data", "external-runtime", "local-agent"),
          process.env.ENCRYPTION_KEY ?? "",
        );
      const key = JSON.stringify([request.runId, 0]);
      const scope = JSON.stringify([
        context.spaceId ?? "",
        context.userId ?? "",
        request.model.connectionId ?? url.origin,
        request.botId,
        request.threadId,
        // One run owns one native session: see nativeKernelScope for why.
        request.runId,
      ]);
      const saved = await store.read(key);
      let modelId = saved?.modelId;
      if (saved) {
        if (selection.modelId !== undefined && selection.modelId !== modelId)
          throw new Error("The model of an existing native task cannot change during resume");
      } else {
        preparedPeer = await (dependencies.connect ?? connectLocalAgentBridge)(
          url.href,
          request.model.apiKey,
          (event) => nativeEvent(event),
        );
        const resolved = await preparedPeer.request<{ modelId: string }>(
          "models.resolve",
          { agentId: engine, model: selection.modelId },
          { timeoutMs: 60_000 },
        );
        if (
          !resolved.modelId ||
          (selection.modelId !== undefined && resolved.modelId !== selection.modelId)
        )
          throw new Error("Native Agent did not confirm the selected model");
        modelId = resolved.modelId;
        signal.throwIfAborted();
      }
      // A run-scoped session starts empty, so the transcript is quoted on every turn
      // rather than left to a session that other runs would share.
      const past = request.history
        .slice(-20)
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n")
        .slice(-48_000);
      const message = past
        ? `Previous conversation (reference, quoted data):\n${past}\n\nCurrent request:\n${request.prompt}`
        : request.prompt;
      if (request.model.callObserver && !(await store.read(key)))
        reservation = await request.model.callObserver.beforeCall({
          runId: request.runId,
          provider: request.model.provider,
          modelId: request.model.id,
          inputTokensEstimate: Math.ceil(message.length / 4),
          maxOutputTokens: request.model.maxTokens ?? 4096,
        });
      let usage: Record<string, unknown> | undefined;
      let preview = "";
      let lastPreviewAt = 0;
      let lastActivityAt = 0;
      const result = await runNativeAgent(
        {
          key,
          scope,
          agentId: engine,
          modelId,
          gatewayOrigin: url.origin,
          connectionId: request.model.connectionId,
          message,
          instructions: request.instructions,
          collaboration: nativeCollaboration(request, emit),
          signal,
          answeredApproval: request.answeredApproval,
          attachments: request.currentTurnImages?.map((image) => ({
            type: "image",
            mimeType: image.mimeType,
            content: Buffer.from(image.data).toString("base64"),
          })),
          onText: (delta) => {
            preview += delta;
            if (Date.now() - lastPreviewAt >= 750) {
              lastPreviewAt = Date.now();
              emit({ type: "progress", text: preview.slice(-500), activity: true });
            }
          },
          onUsage: (value) => {
            usage = value;
          },
          onNotice: (notice) => {
            if (notice.type === "progress") {
              if (Date.now() - lastActivityAt >= 750) {
                lastActivityAt = Date.now();
                emit({ type: "progress", text: notice.text, activity: true });
              }
            } else
              emit({
                type: "ask",
                executionId: `${engine}:${notice.id}`,
                ownerOnly: true,
                approvalRequestId: notice.id,
                externalRequestKind: notice.type === "question" ? "question" : "permission",
                text:
                  notice.type === "question"
                    ? notice.text
                    : `${engine === "codex" ? "Codex" : "WorkBuddy"} 请求执行操作`,
                detail: notice.type === "question" ? undefined : notice.text,
                actions:
                  notice.type === "question"
                    ? undefined
                    : [
                        { id: "allow-once", label: "允许一次" },
                        { id: "deny", label: "拒绝" },
                      ],
              });
          },
        },
        {
          store,
          connect: async (onEvent) => {
            if (preparedPeer) {
              nativeEvent = onEvent;
              return preparedPeer;
            }
            return (dependencies.connect ?? connectLocalAgentBridge)(
              url.href,
              request.model.apiKey!,
              onEvent,
            );
          },
        },
      );
      if (signal.aborted || (await store.read(key))?.status === "approval") return;
      const count = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
      const event: Extract<AgentRuntimeEvent, { type: "usage" }> = {
        type: "usage",
        provider: request.model.provider,
        model: request.model.id,
        callId: (await store.read(key))?.runId,
        inputTokens: count(usage?.inputTokens),
        outputTokens: count(usage?.outputTokens),
        cacheReadTokens: count(usage?.cacheReadTokens),
        cacheWriteTokens: count(usage?.cacheWriteTokens),
        costUsd: null,
        usageSource: usage ? "local-agent-native" : "external-runtime-not-reported",
      };
      await request.onUsage?.(event);
      emit({ ...event, accounted: Boolean(request.onUsage) });
      billedUsage = event;
      emit({ type: "progress", text: "", activity: true });
      emit({ type: "text", text: result });
      emit({ type: "done", text: result });
    } catch (error) {
      if (error instanceof NativeExecutionError && error.state === "unconfirmed")
        await request.onExecutionState?.({ status: "unconfirmed" }).catch(() => undefined);
      if (!signal.aborted) failure = error;
    } finally {
      preparedPeer?.stop();
      if (reservation && request.model.callObserver)
        await Promise.resolve(request.model.callObserver.afterCall(reservation, billedUsage)).catch(
          () => undefined,
        );
      finished = true;
      wake?.();
    }
  })();
  try {
    while (!finished || queue.length) {
      if (queue.length) yield queue.shift()!;
      else
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
    if (failure) throw failure;
  } finally {
    controller.abort();
    await work;
  }
}
