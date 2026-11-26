import { setUiLocale } from "./i18n";
import { UI_LOCALES } from "./ui-locale";
import type { UiLocale } from "./ui-locale";
import { toast } from "@livingbot/ui-web";
import { hydrateLocalUiPreferences, uiPreferenceRevision } from "./local-ui-preferences";
import { hydrateConclusionFirstPreference } from "./conclusion-first-preference";
import { setUiAppearance } from "./ui-appearance";
import { setToolActivityPreference } from "./tool-activity-preference";
import { setResponseStreamingPreference } from "./response-streaming";
import { setChatAvatarVisible } from "./chat-avatar-preference";
import { setTurnTitleCount, setTurnTitlesEnabled } from "./turn-rail-preference";
import { setRemoteImagesPreference } from "./remote-images-preference";
import { setComposerEnterToSend } from "./composer-enter-to-send-pref";
import type { AppTextSize, ChatWidth } from "./reading-prefs";
import { setAppTextSize, setChatWidth } from "./reading-prefs";
import type { FileOpenMode, LinkOpenMode } from "./opening-prefs";
import { setFileOpenMode, setLinkOpenMode } from "./opening-prefs";
import { setBotsSidebarDensity } from "./bots-sidebar-density-pref";
import type { AppearancePreference } from "./ui-appearance";
import { APPEARANCE_PREFERENCES } from "./ui-appearance";
/**
 * Local-service boundary for the desktop build.
 *
 * The shell speaks the product's RPC contract; the 2.0 application exposes a
 * local HTTP API with a bearer token. This adapter maps the handful of
 * procedures the shell actually calls onto those endpoints, so the original
 * components render real local data instead of a mock or an empty list.
 */
import { useEffect, useRef, useState } from "react";
import { createRefreshCoalescer, runThreadSubscription, truncatedPlainText } from "@livingbot/core";
import type {
  AppBootstrap,
  MessageBlock,
  ProductEvent,
  ThreadMessage,
  ThreadSnapshot,
  Run,
  Group,
} from "@livingbot/contracts";
import { AppBootstrapSchema, BotSchema, GroupSchema, CreateGroupInput, UpdateGroupInput, CreateBotInput, UpdateBotInput } from "@livingbot/contracts";
import type {
  Interaction,
  InteractionAnswer,
  Message,
  Artifact,
  Conversation,
  Task,
  Run as NativeRun,
} from "../../../../packages/workbench/src/contracts";
import { desktopBridge } from "./desktop";
import { handleLocalModelSettings, readLocalModelDefaults } from "./local-model-settings";
import { createLocalRoutinesHandler, productLocalRoutine } from "./local-routines";
import type { Routine as NativeRoutine } from "../../../../packages/workbench/src/routines";
import { localAbilitiesRpc } from "./local-abilities";
import { hydrateBotVoicePreferences } from "./voice-assistant-pref";

type Connection = { origin: string; token: string; spaceId?: string };

/** Shared by the unchanged 1.0 TTS/recording clients in local mode. */
export async function localVoiceFetch(path: string, init: RequestInit): Promise<Response> {
  const local = await localConnection();
  if (!local) return fetch(path, init);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${local.token}`);
  headers.set("x-livingbot-space-id", selectedLocalSpaceId());
  return fetch(`${local.origin}${path}`, { ...init, headers });
}

/**
 * Headers for the streaming dictation tap, which posts JSON on its own instead of going
 * through localVoiceFetch. A browser session carries its cookie and adds nothing here.
 */
export async function localVoiceHeaders(headers?: HeadersInit): Promise<Headers> {
  const merged = new Headers(headers);
  const local = await localConnection();
  if (local) merged.set("authorization", `Bearer ${local.token}`);
  return merged;
}

let pending: Promise<Connection | null> | undefined;
let resolved: Connection | null = null;
const interactions = new Map<string, Interaction>();

export function localInteraction(id: string): Interaction | undefined {
  return interactions.get(id);
}

export const localInteractionClient = {
  async resolveInteraction(
    taskId: string,
    id: string,
    answer: InteractionAnswer,
  ): Promise<Interaction> {
    const connection = await localConnection();
    if (!connection) throw new Error("本机服务未连接");
    const prompt = await request<Interaction>(
      connection,
      // Colons are valid path-segment characters. Keep scheduled task IDs readable
      // to older local backends while an updated renderer runs before restart.
      `/api/tasks/${encodeURIComponent(taskId).replace(/%3A/gi, ":")}/interactions/${encodeURIComponent(id)}/resolve`,
      { method: "POST", body: JSON.stringify(answer) },
    );
    interactions.set(prompt.id, prompt);
    return prompt;
  },
};

const STORAGE_KEY = "livingbot.local-connection";

function readAddressConnection(): Connection | null {
  const params = new URLSearchParams(window.location?.search ?? "");
  const origin = params.get("localOrigin");
  const token = params.get("localToken");
  if (!origin || !token) return null;
  const url = new URL(origin);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)
  ) {
    throw new Error("只接受本机服务地址");
  }
  const connection = { origin: url.origin, token };
  // Persist before React's initial route redirect can discard these parameters.
  adoptConnection(connection);
  stripAddressBar();
  return connection;
}

function readStored(): Connection | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Connection;
    return parsed.origin && parsed.token ? parsed : null;
  } catch {
    return null;
  }
}

/** A browser session can carry the same pair the desktop preload hands out. */
export function adoptConnection(connection: Connection): void {
  resolved = connection;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
  } catch {
    // Session storage is best-effort; the in-memory copy still works.
  }
}

export function forgetConnection(): void {
  resolved = null;
  pending = undefined;
  interactions.clear();
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Connect the existing desktop notification click to its retained conversation. */
export function subscribeLocalResults(open: (route: string) => void): () => void {
  const bridge = (window as Window & { livingbotDesktop?: {
    onOpenResult?: (receive: (id: string) => void) => () => void;
  } }).livingbotDesktop;
  return bridge?.onOpenResult?.((id) => {
    void (async () => {
      const connection = await localConnection();
      if (!connection) return;
      const snapshot = await request<LocalSnapshot & {
        notifications: { id: string; conversationId: string; botId: string }[];
      }>(connection, "/api/snapshot");
      const notice = snapshot.notifications.find((item) => item.id === id);
      if (!notice) return;
      const conversation = snapshot.conversations.find((item) => item.id === notice.conversationId);
      if (!conversation) return;
      if (conversation.kind === "group") {
        open(`/app/g/${conversation.id}`);
      } else {
        // A result produced by a task session opens that session, not the Bot's home
        // thread, so the message the notification points at is actually there.
        const main = await mainConversationId(connection, notice.botId).catch(() => "");
        const session = conversation.id === main ? "" : conversation.id;
        open(`/app/${notice.botId}${session ? `?task=${encodeURIComponent(session)}` : ""}`);
      }
      await request(connection, `/api/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
    })().catch(console.error);
  }) ?? (() => {});
}

/** Desktop asks the preload; a browser uses the pair from the address bar. */
export function localConnection(): Promise<Connection | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  pending ??= (async () => {
    if (resolved) return resolved;
    const stored = readStored();
    if (stored) {
      resolved = stored;
      return stored;
    }
    const addressed = readAddressConnection();
    if (addressed) return addressed;
    const bridge = (window as Window & { livingbotDesktop?: { connect?: () => Promise<Connection | null> } }).livingbotDesktop
      ?? desktopBridge() as { connect?: () => Promise<Connection | null> } | undefined;
    const fromDesktop = await bridge?.connect?.().catch(() => null);
    if (fromDesktop?.origin && fromDesktop.token) {
      resolved = { origin: fromDesktop.origin, token: fromDesktop.token };
      return resolved;
    }
    return null;
  })();
  return pending;
}

async function request<T>(connection: Connection, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${connection.origin}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${connection.token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : undefined;
  if (!response.ok)
    throw new Error(String((value as { error?: string } | undefined)?.error ?? "本地服务请求失败"));
  return value as T;
}

type LocalBot = {
  autoSpeak?: boolean;
  voiceId?: string;
  createdAt?: number;
  id: string;
  spaceId?: string;
  agentId: string;
  name: string;
  description?: string;
  identity?: string;
  color?: string;
  avatarSet?: string;
  pinned?: boolean;
  position?: number;
  sectionId?: string;
  archivedAt?: number;
  notifyOnFinish?: boolean;
  spawnKey?: string;
};
type LocalMessage = Message;
type LocalSnapshot = {
  bots: LocalBot[];
  conversations: Conversation[];
  tasks: { id: string; botId: string; conversationId: string; status: string; updatedAt?: number; createdAt?: number }[];
  interactions: Interaction[];
  artifacts?: Artifact[];
  settings?: { model?: unknown };
  readState?: { conversationId: string; lastReadSeq: number; unread: boolean }[];
  lastMessageSeq?: Record<string, number>;
  lastMessages?: Record<string, { role: string; text: string; createdAt: number }>;
};

/** A conversation's newest message as a sidebar row shows it: one bounded line and when it arrived. */
function lastMessageLine(
  snapshot: LocalSnapshot,
  conversationId: string | undefined,
): { preview: string; updatedAt: string } | undefined {
  const latest = conversationId ? snapshot.lastMessages?.[conversationId] : undefined;
  if (!latest) return undefined;
  return {
    preview: truncatedPlainText(latest.text, 160).replace(/\s+/g, " ").trim(),
    updatedAt: new Date(latest.createdAt).toISOString(),
  };
}

/** Our product records keep text, thinking, tools, questions and files; keep them all. */
function toProductBlocks(
  blocks: LocalMessage["blocks"],
  artifacts: Artifact[] = [],
): MessageBlock[] {
  const output: MessageBlock[] = [];
  let steps: { label: string; count: number; tool?: string; detail?: string }[] = [];
  const flushSteps = () => {
    if (steps.length) output.push({ kind: "steps", steps });
    steps = [];
  };
  for (const block of blocks) {
    if (block.kind === "health_check") {
      flushSteps();
      output.push({ kind: "ask", text: block.summary, healthCheck: { reportId: block.reportId, botId: block.botId } });
      continue;
    }
    if (block.kind === "voice_call" || block.kind === "call_request") {
      flushSteps();
      const { id: _id, ...call } = block;
      output.push(call);
      continue;
    }
    if (block.kind === "widget") {
      flushSteps();
      output.push({kind:"text",text:`${block.title}（交互预览）`,preview:{blockId:block.id,title:block.title}});
      continue;
    }
    if (block.kind === "text") {
      flushSteps();
      if (block.text) output.push({ kind: "text", text: block.text,
        ...(block.voicePlayback ? { voicePlayback: block.voicePlayback } : {}) });
      continue;
    }
    if (block.kind === "reasoning") {
      flushSteps();
      if (block.text) output.push({ kind: "reasoning", text: block.text });
      continue;
    }
    if (block.kind === "tool") {
      steps.push({
        label: block.title ?? block.name ?? "工具",
        count: 1,
        tool: block.name,
        detail: block.detail,
      });
      continue;
    }
    flushSteps();
    // Approval and question blocks need an answer from the user; keep them visible.
    if (block.kind === "approval" || block.kind === "question") {
      output.push({ kind: "ask", text: block.title ?? "需要确认" });
      continue;
    }
    if (block.kind === "file") {
      // A delivered file keeps its real identity so the shell can open or download it.
      output.push({
        kind: "file",
        artifactId: block.artifactId ?? block.id ?? "",
        name: block.name ?? "交付文件",
        mimeType: block.mediaType ?? "application/octet-stream",
        size: artifacts.find((file) => file.id === block.artifactId)?.bytes ?? 0,
      });
    }
  }
  flushSteps();
  return output;
}

const SPACE_STORAGE_KEY = "rakazo:space-id";
function selectedLocalSpaceId(connection?: Connection): string {
  if (connection?.spaceId !== undefined) return connection.spaceId;
  try {
    return window.localStorage.getItem(SPACE_STORAGE_KEY) || "local";
  } catch {
    return "local";
  }
}
const SPACE_ID = "local";
const USER_ID = "local-owner";

/**
 * Every private conversation of one Bot in the original task-session shape.
 * The Bot's main conversation is not a task session: the shell shows it as the
 * Bot's own thread, so listing it here would duplicate it and hide the restorable
 * rows that live in the "deleted" filter.
 */
async function privateSessions(
  connection: Connection, botId: string,
): Promise<TaskSessionRow[]> {
  const [snapshot, main] = await Promise.all([
    request<LocalSnapshot>(connection, "/api/snapshot"),
    mainConversationId(connection, botId).catch(() => ""),
  ]);
  return (snapshot.conversations ?? [])
    .filter((entry) => entry.kind === "private" && (entry.botIds ?? []).includes(botId))
    .filter((entry) => entry.id !== main)
    .sort((a, b) =>
      Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) || a.createdAt - b.createdAt
      || a.id.localeCompare(b.id))
    .map((entry) => taskSessionRow(entry, botId, main || entry.id, snapshot));
}

type TaskSessionRow = {
  id: string; botId: string; threadId: string; mainThreadId: string; title: string;
  modelProvider: string | null; modelId: string | null; thinkingLevel: string | null;
  createdAt: string; updatedAt: string; archivedAt: string | null;
  unread: boolean; latestRunId: string | null; status: string; resourceWaitReason: string | null;
};

/** One session row in the original complete schema, including its live task state. */
function taskSessionRow(
  entry: Conversation, botId: string, mainThreadId: string, snapshot: LocalSnapshot,
): TaskSessionRow {
  const tasks = (snapshot.tasks ?? []).filter((task) => task.conversationId === entry.id);
  const active = tasks
    .filter((task) => ["queued", "running", "waiting", "stopping"].includes(task.status))
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
  const latest = active[0];
  const read = (snapshot.readState ?? []).find((row) => row.conversationId === entry.id);
  const messages = (snapshot.lastMessageSeq ?? {})[entry.id];
  return {
    id: entry.id,
    botId,
    threadId: entry.id,
    mainThreadId,
    title: entry.title || "会话",
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    createdAt: new Date(entry.createdAt).toISOString(),
    updatedAt: new Date(entry.updatedAt ?? entry.createdAt).toISOString(),
    archivedAt: entry.archivedAt === undefined ? null : new Date(entry.archivedAt).toISOString(),
    unread: Boolean(
      read && (read.unread || (typeof messages === "number" && read.lastReadSeq < messages)),
    ),
    latestRunId: latest ? latest.id : null,
    status: latest ? taskSessionStatus(latest.status) : (tasks.length ? "completed" : "queued"),
    resourceWaitReason: latest?.status === "stopping" ? "stopping" : null,
  };
}

function taskSessionStatus(status: string): string {
  if (status === "waiting") return "waiting_input";
  if (status === "running" || status === "stopping") return "running";
  return status;
}

/** The Bot's own conversation, created on first use by the local service. */
async function mainConversationId(connection: Connection, botId: string): Promise<string> {
  if (!botId) throw new Error("缺少 Bot 标识");
  return (await request<{ id: string }>(
    connection, `/api/bots/${encodeURIComponent(botId)}/private-conversation`, { method: "POST" },
  )).id;
}

/**
 * One place that decides which conversation a shell call addresses. Every procedure
 * that carries a thread target goes through it, so a task session can never silently
 * fall back to the Bot's main conversation.
 */
type ThreadTargetInput = { botId?: string; groupId?: string; taskSessionId?: string };

async function resolveTarget(
  connection: Connection, input: ThreadTargetInput,
): Promise<{ conversationId: string; botId: string; groupId?: string }> {
  const groupId = input.groupId ? String(input.groupId) : undefined;
  if (groupId) {
    const snapshot = await request<LocalSnapshot>(connection, "/api/snapshot");
    const group = snapshot.conversations.find((entry) => entry.id === groupId && entry.kind === "group");
    if (!group || (group.spaceId ?? "local") !== selectedLocalSpaceId(connection)) throw new Error("群聊不存在");
    return { conversationId: groupId, botId: String(input.botId ?? group.botIds[0] ?? ""), groupId };
  }
  const botId = String(input.botId ?? "");
  if (!botId) throw new Error("缺少 Bot 标识");
  const owner = (await request<LocalSnapshot>(connection, "/api/snapshot"))
    .bots.find((bot) => bot.id === botId);
  if (owner && (owner.spaceId ?? "local") !== selectedLocalSpaceId(connection)) throw new Error("Bot 不属于当前空间");
  const sessionId = input.taskSessionId ? String(input.taskSessionId) : undefined;
  if (!sessionId) return { conversationId: await mainConversationId(connection, botId), botId };
  const snapshot = await request<LocalSnapshot>(connection, "/api/snapshot");
  const session = snapshot.conversations.find((entry) => entry.id === sessionId);
  if (!session || session.kind !== "private" || !session.botIds.includes(botId) ||
    (session.spaceId ?? owner?.spaceId ?? "local") !== selectedLocalSpaceId(connection)) {
    throw new Error("会话不存在或不属于这个 Bot");
  }
  return { conversationId: sessionId, botId };
}


/** One session in the same shape, after a rename or archive. */
async function sessionProduct(connection: Connection, botId: string, id: string) {
  const sessions = await privateSessions(connection, botId);
  const found = sessions.find((session) => session.id === id);
  if (!found) throw new Error("会话不存在");
  return found;
}

type KernelUsage = {
  usageReport?: { state: string };
  input?: number | null; output?: number | null; cacheRead?: number | null; cacheWrite?: number | null;
  totalTokens?: number | null;
  messageCounts?: { assistant?: number; total?: number };
  latency?: { count?: number; avgMs?: number };
  generationDurationMs?: number | null;
  modelUsage?: { count?: number; totals?: { totalTokens?: number } }[];
};
type UsageResponse = {
  sessions?: { key?: string; usage?: KernelUsage | null }[];
  totals?: KernelUsage | null;
  timeseries?: { points?: { timestamp: number; input?: number; output?: number; cacheRead?: number;
    cacheWrite?: number; totalTokens?: number }[] } | null;
  latestRun?: { id: string; status: string; startedAt: number | null; completedAt: number | null } | null;
  latestCalls?: KernelUsage[] | null;
  latestModelRequestDurationMs?: number | null;
};

function known(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The kernel reports prompt tokens split into uncached input plus cache reads, so a
 * hit rate is cacheRead / (input + cacheRead). A field the kernel does not report
 * stays null: the composer says "unknown" rather than showing a made-up number.
 */
function usageTotals(row: KernelUsage | null | undefined, options?: { callsFallback?: number }) {
  const reported = !row?.usageReport || row.usageReport.state === "available";
  const input = reported ? known(row?.input) : null;
  const output = reported ? known(row?.output) : null;
  const cacheRead = reported ? known(row?.cacheRead) : null;
  const cacheWrite = reported ? known(row?.cacheWrite) : null;
  const measured = [input, output, cacheRead, cacheWrite].filter((value): value is number => value !== null);
  const knownTokens = measured.reduce((sum, value) => sum + value, 0);
  const modelCalls = (row?.modelUsage ?? []).reduce((sum, entry) => sum + (entry.count ?? 0), 0);
  const calls = known(row?.latency?.count) ?? (modelCalls || (options?.callsFallback ?? 0));
  const reportedCalls = (row?.modelUsage ?? [])
    .filter((entry) => entry.totals && known(entry.totals.totalTokens) !== null)
    .reduce((sum, entry) => sum + (entry.count ?? 0), 0);
  const prompt = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  // Official sessions.usage latency may be user-to-assistant elapsed time,
  // including tools and waits. It is neither model time nor generation speed.
  const duration = known(row?.generationDurationMs);
  const modelDurationMs = duration !== null && duration > 0 ? duration : null;
  // A call the kernel logged without tokens is not a zero-token call, and an empty
  // "reported" count would hide a column that does have tokens behind it.
  const measuredCalls = reportedCalls > 0
    ? reportedCalls
    : (measured.length > 0 ? Math.max(1, calls) : 0);
  return {
    calls,
    reportedCalls: Math.min(measuredCalls, Math.max(calls, measuredCalls)),
    tokens: (reported ? known(row?.totalTokens) : null) ?? (measured.length === 4 ? knownTokens : null),
    knownTokens,
    inputTokens: input === null || cacheRead === null || cacheWrite === null ? null : prompt,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheHitRate: cacheRead !== null && prompt > 0 ? cacheRead / prompt : null,
    tokensPerSecond: output !== null && known(row?.generationDurationMs) !== null && row!.generationDurationMs! > 0
      ? (output * 1000) / row!.generationDurationMs! : null,
    modelDurationMs,
  };
}

/**
 * Usage straight from the official reads: the session aggregate plus its per-call
 * ledger. "This run" includes every model call belonging to that native run.
 */
export function conversationUsage(threadId: string, raw: UsageResponse) {
  if (!Array.isArray(raw.sessions)) throw new Error("用量接口返回了未知结构");
  const merge = (rows: KernelUsage[]) => {
    const totals = rows.map((row) => usageTotals(row));
    const sum = (key: keyof ReturnType<typeof usageTotals>) => totals.every((row) => row[key] !== null)
      ? totals.reduce((value, row) => value + Number(row[key]), 0) : null;
    const inputTokens = sum("inputTokens");
    const cacheReadTokens = sum("cacheReadTokens");
    // Reuse 1.0's all-calls-measured rule, including its positive-time guard.
    const generation = rows.every((row) =>
      known(row.generationDurationMs) !== null && row.generationDurationMs! > 0)
      ? rows.reduce((value, row) => value + row.generationDurationMs!, 0) : null;
    const outputTokens = sum("outputTokens");
    return {
      calls: totals.reduce((value, row) => value + row.calls, 0),
      reportedCalls: totals.reduce((value, row) => value + row.reportedCalls, 0),
      tokens: sum("tokens"), knownTokens: sum("knownTokens") ?? 0, inputTokens, outputTokens, cacheReadTokens,
      cacheHitRate: inputTokens && cacheReadTokens !== null ? cacheReadTokens / inputTokens : null,
      tokensPerSecond: generation && outputTokens !== null ? outputTokens * 1000 / generation : null,
      modelDurationMs: sum("modelDurationMs"),
    };
  };
  const total = merge(raw.sessions.length
    ? raw.sessions.map((entry) => entry.usage ?? {}) : [raw.totals ?? {}]);
  const points = raw.timeseries?.points ?? [];
  // The server selects the latest run with native usage, retaining the previous
  // reading while a new run has no ledger entries. No cross-thread cache here.
  const run = raw.latestRun;
  // Old fixtures can use the official timeseries while it still has individual
  // points. The live endpoint supplies raw native calls, avoiding its 200-point bins.
  const calls = raw.latestCalls !== undefined ? raw.latestCalls :
    run?.startedAt !== null && run?.startedAt !== undefined && points.length < 200
      ? points.filter((point) => point.timestamp >= run.startedAt! &&
          (run.completedAt === null || point.timestamp <= run.completedAt))
      : null;
  const latest = calls?.length && run
    ? {
        runId: run.id,
        status: run.status,
        startedAt: run.startedAt === null ? null : new Date(run.startedAt).toISOString(),
        completedAt: run.completedAt === null ? null : new Date(run.completedAt).toISOString(),
        ...merge(calls.map((call) => ({ ...call, latency: { count: 1 } }))),
        // Native model_call_ended measures the request, not token generation.
        modelRequestDurationMs: known(raw.latestModelRequestDurationMs),
      }
    : null;
  return { threadId, total, latest, context: null };
}

type LocalRun = {
  id: string;
  taskId: string;
  state: string;
  createdAt: number;
  lastSequence?: number;
};

/** One product Run built from the service's run record; never the task id. */
function productRun(run: LocalRun, botId: string, threadId: string, taskId: string): Run {
  const stamp = new Date(run.createdAt).toISOString();
  const terminal = ["completed", "failed", "cancelled"].includes(run.state);
  return {
    id: run.id,
    userId: USER_ID,
    botId,
    threadId,
    taskId,
    status:
      run.state === "waiting"
        ? "waiting_input"
        : run.state === "queued"
          ? "queued"
          : run.state === "failed"
            ? "failed"
            : run.state === "cancelled"
              ? "cancelled"
              : run.state === "completed"
                ? "completed"
                : "running",
    trigger: "user",
    routineId: null,
    modelProvider: null,
    modelId: null,
    error: null,
    startedAt: terminal ? stamp : stamp,
    completedAt: terminal ? stamp : null,
    createdAt: stamp,
  };
}

function interactionMessage(prompt: Interaction, botId: string): LocalMessage {
  const answered = !["pending", "answering"].includes(prompt.status);
  return {
    id: prompt.id,
    conversationId: prompt.conversationId,
    botId,
    runId: prompt.runId,
    taskId: prompt.taskId,
    role: "assistant",
    final: answered,
    createdAt: prompt.createdAt,
    updatedAt: prompt.createdAt,
    blocks: [
      {
        id: prompt.id,
        kind: prompt.kind,
        requestId: prompt.id,
        title: prompt.title,
        payload: { prompt },
      },
    ],
  };
}

function productMessage(
  message: LocalMessage,
  seq: number,
  botId: string,
  artifacts: Artifact[],
): ThreadMessage {
  const blocks = message.blocks.flatMap((block): MessageBlock[] => {
    if (block.kind !== "approval" && block.kind !== "question")
      return toProductBlocks([block], artifacts);
    const prompt = block.payload.prompt as Interaction | undefined;
    if (!prompt) return toProductBlocks([block], artifacts);
    const question = prompt.questions[0];
    const answered = !["pending", "answering"].includes(prompt.status);
    return [
      {
        kind: "ask",
        text: prompt.questions.map((field) => field.question).join("\n\n") || prompt.title,
        approvalRequestId: prompt.id,
        externalRequestKind: prompt.kind === "approval" ? "permission" : "question",
        ...(prompt.secureInput ? {
          input: "secret" as const, purpose: "api_key" as const,
          text: prompt.secureInput.connection ? prompt.title : prompt.secureInput.name,
          detail: prompt.secureInput.connection
            ? prompt.secureInput.connection.fields.map((field) => field.key).join(", ")
            : prompt.secureInput.allowedHosts.join(", "),
          ...(prompt.secureInput.connection ? {
            secureConnection: prompt.secureInput.connection.name,
            loginFields: prompt.secureInput.connection.fields.map((field) => field.label),
          } : {}),
          ...(answered && prompt.status !== "answered" ? { dismissed: true as const } : {}),
        } : {}),
        status: answered ? "answered" : "pending",
        ...(answered
          ? {
              answer:
                prompt.answer?.decision ??
                Object.values(prompt.answer?.answers ?? {})
                  .flat()
                  .join(", "),
            }
          : {}),
        ...(prompt.kind === "approval" ? { approvalEffectId: prompt.id } : {}),
        actions:
          prompt.kind === "approval"
            ? prompt.decisions.map((decision) => ({
                id:
                  decision === "allow-once"
                    ? "allow"
                    : decision === "allow-always"
                      ? "always"
                      : "deny",
                label:
                  decision === "deny"
                    ? "拒绝"
                    : decision === "allow-always"
                      ? "始终允许"
                      : "允许一次",
              }))
            : questionsActions(question),
      },
    ];
  });
  return {
    id: message.id,
    threadId: message.conversationId,
    seq,
    botId: message.botId || botId || undefined,
    runId: message.runId,
    ...(message.clientNonce ? { clientNonce: message.clientNonce } : {}),
    role: message.role === "assistant" ? "bot" : message.role,
    blocks,
    // A reaction is a user message that answers another one: the original transcript
    // renders it under its target and hides the bubble, so the link has to survive.
    ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    ...(message.replyQuote ? { replyQuote: message.replyQuote } : {}),
    ...(message.turnTitle ? { turnTitle: message.turnTitle } : {}),
    createdAt: new Date(message.createdAt).toISOString(),
  };
}

function questionsActions(question: Interaction["questions"][number] | undefined) {
  return question?.options.map((option) => ({ id: option.value, label: option.label }));
}

function productArtifact(file: Artifact, groupId?: string) {
  return {
    id: file.id,
    botId: groupId ? null : file.botId,
    groupId: groupId ?? null,
    runId: null,
    name: file.name,
    description: null,
    mimeType: file.mediaType,
    size: file.bytes,
    version: 1,
    createdAt: new Date(file.createdAt).toISOString(),
  };
}

async function threadSnapshot(
  connection: Connection,
  target: { conversationId: string; botId: string; groupId?: string },
): Promise<ThreadSnapshot> {
  const { conversationId, botId, groupId } = target;
  const [history, snapshot] = await Promise.all([
    request<{ messages: LocalMessage[]; cursor: number; artifacts?: Artifact[] }>(
      connection,
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    ),
    request<LocalSnapshot>(connection, "/api/snapshot"),
  ]);
  const clearedAt = snapshot.conversations.find((entry) => entry.id === conversationId)?.clearedAt ?? 0;
  for (const prompt of snapshot.interactions ?? []) interactions.set(prompt.id, prompt);
  const tasks = snapshot.tasks.filter(
    (task) =>
      task.conversationId === conversationId &&
      ["queued", "running", "waiting", "stopping"].includes(task.status),
  );
  const runs = (
    await Promise.all(
      tasks.map(async (task) => {
        const run = await latestRun(connection, task.id);
        return run ? productRun(run, task.botId ?? botId, conversationId, task.id) : undefined;
      }),
    )
  ).filter((run): run is Run => Boolean(run));
  const messages = [
    ...history.messages,
    ...(snapshot.interactions ?? [])
      .filter((prompt) => prompt.conversationId === conversationId && prompt.createdAt >= clearedAt)
      .map((prompt) => interactionMessage(prompt, snapshot.tasks.find((task) => task.id === prompt.taskId)?.botId ?? botId)),
  ].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const group = groupId ? snapshot.conversations.find((entry) => entry.id === groupId && entry.kind === "group") : undefined;
  return {
    threadId: conversationId,
    ...(groupId ? { groupId } : { botId }),
    ...(group ? { groupName: group.title, members: productGroup(group, snapshot.bots).members } : {}),
    cursor: history.cursor,
    olderCursor: null,
    messages: messages.map((message, index) =>
      productMessage(message, index, botId, history.artifacts ?? snapshot.artifacts ?? []),
    ),
    run: runs.find((run) => run.status === "running" || run.status === "waiting_input") ?? runs[0] ?? null,
    activeRuns: runs,
  };
}

async function latestRun(connection: Connection, taskId: string): Promise<LocalRun | undefined> {
  const detail = await request<{ run: LocalRun | null }>(
    connection,
    `/api/tasks/${encodeURIComponent(taskId)}`,
  ).catch(() => ({ run: null }));
  return detail.run ?? undefined;
}

function botStatus(tasks: { botId: string; status: string }[], botId: string) {
  const running = tasks.filter(
    (task) =>
      task.botId === botId &&
      ["queued", "running", "waiting", "stopping"].includes(task.status),
  );
  if (running.some((task) => task.status === "running" || task.status === "stopping"))
    return "running";
  if (running.some((task) => task.status === "waiting")) return "waiting_input";
  return running.length ? "queued" : "idle";
}

function bot(bot: LocalBot, threadId?: string, status = "idle") {
  return botFrom(bot, threadId, status, false);
}

function botFrom(
  bot: LocalBot,
  threadId: string | undefined,
  status: string,
  unread: boolean,
  snapshot?: LocalSnapshot,
) {
  const stamp = new Date(bot.createdAt ?? Date.now()).toISOString();
  // The row shows the bot's newest message and when it arrived, like the 1.0 sidebar.
  const latest = snapshot ? lastMessageLine(snapshot, threadId) : undefined;
  return BotSchema.parse({
    id: bot.id,
    spaceId: bot.spaceId ?? SPACE_ID,
    name: bot.name,
    title: "",
    description: bot.description ?? "",
    instructions: bot.identity ?? "",
    color: bot.color ?? "teal",
    avatarSet: bot.avatarSet,
    pinned: bot.pinned ?? false,
    notifyOnFinish: bot.notifyOnFinish ?? true,
    sectionId: bot.sectionId ?? null,
    archivedAt: bot.archivedAt === undefined ? null : new Date(bot.archivedAt).toISOString(),
    unread,
    parentBotId: null,
    memoryScope: "isolated",
    threadId: threadId ?? `thread:${bot.id}`,
    preview: latest?.preview ?? "",
    status,
    runErrorId: null,
    computerMode: "dedicated",
    voiceId: bot.voiceId ?? null,
    autoSpeak: bot.autoSpeak ?? false,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    webhookConfigured: false,
    spawnKey: bot.spawnKey ?? null,
    updatedAt: latest?.updatedAt ?? stamp,
    createdAt: stamp,
  });
}

/** True when a conversation's newest message is past the stored read boundary. */
function conversationUnread(snapshot: LocalSnapshot, conversationId: string | undefined): boolean {
  if (!conversationId) return false;
  const read = (snapshot.readState ?? []).find((row) => row.conversationId === conversationId);
  const latest = (snapshot.lastMessageSeq ?? {})[conversationId];
  if (!read) return typeof latest === "number" && latest >= 0;
  return read.unread || (typeof latest === "number" && read.lastReadSeq < latest);
}

function productGroup(
  group: Conversation,
  bots: LocalBot[],
  unread = false,
  snapshot?: LocalSnapshot,
): Group {
  const latest = snapshot ? lastMessageLine(snapshot, group.id) : undefined;
  return GroupSchema.parse({
    id: group.id,
    spaceId: group.spaceId ?? SPACE_ID,
    name: group.title,
    pinned: group.pinned ?? false,
    sectionId: group.sectionId ?? null,
    archivedAt: group.archivedAt === undefined ? null : new Date(group.archivedAt).toISOString(),
    threadId: group.id,
    members: group.botIds.flatMap((id) => {
      const member = bots.find((entry) => entry.id === id);
      return member ? [{ botId: id, name: member.name, color: member.color ?? "teal", avatarSet: member.avatarSet }] : [];
    }),
    preview: latest?.preview ?? "",
    unread,
    updatedAt: latest?.updatedAt ?? new Date(group.updatedAt ?? group.createdAt).toISOString(),
    createdAt: new Date(group.createdAt).toISOString(),
  });
}

/** The stored preference row, projected onto the fields the shell reads from `me`. */
function productPreferences(row: Record<string, unknown>): { avatarStyle?: string; timezone?: string | null } {
  const avatarStyle = typeof row.avatarStyle === "string" ? row.avatarStyle : undefined;
  const timezone = row.timezone === null || typeof row.timezone === "string"
    ? (row.timezone as string | null) : undefined;
  return { ...(avatarStyle ? { avatarStyle } : {}), ...(timezone !== undefined ? { timezone } : {}) };
}

/** The shell's one bootstrap call, built from the local snapshot. */
async function bootstrap(
  connection: Connection,
  input: { botId?: string },
  includeThread = true,
  rosterOnly = false,
): Promise<AppBootstrap> {
  const [allSnapshot, spaceResult] = await Promise.all([
    request<LocalSnapshot>(connection, "/api/snapshot"),
    request<{ spaces: {
      id: string; name: string; createdAt: number; isDefault: boolean; canRename: boolean; canDelete: boolean;
      hasContent: boolean; botCount: number; bots: LocalBot[]; groups: Conversation[];
      botSections: { id: string; name: string; position: number }[];
    }[] }>(connection, "/api/spaces"),
  ]);
  const spaces = spaceResult.spaces;
  const selectedSpaceId = selectedLocalSpaceId(connection);
  const activeSpace = spaces.find((space) => space.id === selectedSpaceId) ?? spaces[0]!;
  const activeBots = allSnapshot.bots.filter((bot) => (bot.spaceId ?? "local") === activeSpace.id);
  const activeConversations = allSnapshot.conversations
    .filter((chat) => (chat.spaceId ?? "local") === activeSpace.id);
  const activeConversationIds = new Set(activeConversations.map((chat) => chat.id));
  const snapshot: LocalSnapshot = {
    ...allSnapshot,
    bots: activeBots,
    conversations: activeConversations,
    tasks: allSnapshot.tasks.filter((task) => activeConversationIds.has(task.conversationId)),
    interactions: allSnapshot.interactions.filter((interaction) => activeConversationIds.has(interaction.conversationId)),
    readState: allSnapshot.readState?.filter((read) => activeConversationIds.has(read.conversationId)),
    lastMessageSeq: Object.fromEntries(Object.entries(allSnapshot.lastMessageSeq ?? {})
      .filter(([id]) => activeConversationIds.has(id))),
    lastMessages: Object.fromEntries(Object.entries(allSnapshot.lastMessages ?? {})
      .filter(([id]) => activeConversationIds.has(id))),
  };
  const modelDefaults = rosterOnly
    ? { needsModel: true, defaultProvider: null, defaultModel: null }
    : await readLocalModelDefaults(connection, request);
  const { routines: localRoutines } = rosterOnly
    ? { routines: [] as NativeRoutine[] }
    : await request<{ routines: NativeRoutine[] }>(connection, "/api/routines");
  const preferenceRevision = uiPreferenceRevision();
  const preferences = await request<Record<string, unknown>>(connection, "/api/preferences");
  hydrateLocalUiPreferences(preferences, (patch) =>
    request(connection, "/api/preferences", { method: "POST", body: JSON.stringify(patch) }),
    (key, value) => {
      if (key === "livingbot.conclusionFirst" && ["on", "off"].includes(value)) hydrateConclusionFirstPreference(value);
      if (key === "rakazo.uiLocale" && UI_LOCALES.includes(value as UiLocale)) void setUiLocale(value as UiLocale);
      if (key === "rakazo.uiAppearance" && APPEARANCE_PREFERENCES.includes(value as AppearancePreference)) setUiAppearance(value as AppearancePreference);
      if (key === "rakazo.showToolActivity" && ["on", "off"].includes(value)) setToolActivityPreference(value as "on" | "off");
      if (key === "rakazo.responseStreaming" && ["on", "off"].includes(value)) setResponseStreamingPreference(value as "on" | "off");
      if (key === "rakazo.loadRemoteImages" && ["on", "off"].includes(value)) setRemoteImagesPreference(value as "on" | "off");
      if (key === "rakazo.composerEnterToSend" && ["1", "0"].includes(value)) setComposerEnterToSend(value === "1");
      if (key === "rakazo.chatAvatar" && ["on", "off"].includes(value)) setChatAvatarVisible(value === "on");
      if (key === "rakazo.showTurnTitles" && ["on", "off"].includes(value)) setTurnTitlesEnabled(value === "on");
      if (key === "rakazo.turnTitleCount") setTurnTitleCount(Number(value));
      if (key === "rakazo.botsSidebarDensity" && ["compact", "comfortable"].includes(value)) setBotsSidebarDensity(value as "compact" | "comfortable");
      if (key === "rakazo.appTextSize" && ["small", "default", "large", "largest"].includes(value)) setAppTextSize(value as AppTextSize);
      if (key === "rakazo.chatWidth" && ["narrow", "default", "wide"].includes(value)) setChatWidth(value as ChatWidth);
      if (key === "rakazo.linkOpenMode" && ["system", "in-app"].includes(value)) setLinkOpenMode(value as LinkOpenMode);
      if (key === "rakazo.fileOpenMode" && ["preview", "system"].includes(value)) setFileOpenMode(value as FileOpenMode);
    }, () => toast.error("设置未保存，请重试"), preferenceRevision);
  hydrateBotVoicePreferences(preferences, (patch) =>
    request(connection, "/api/preferences", { method: "POST", body: JSON.stringify(patch) }));
  const bots = (snapshot.bots ?? []).filter((bot) => bot.archivedAt === undefined)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const chosen = includeThread ? (input.botId ?? bots[0]?.id) : undefined;
  // The endpoint creates the private conversation on first use, so it is a POST.
  const conversation = chosen ? { id: await mainConversationId(connection, chosen) } : undefined;
  const sections = await request<{ sections: { id: string; name: string; position: number }[] }>(
    connection,
    `/api/bot-sections?spaceId=${encodeURIComponent(activeSpace.id)}`,
  ).catch(() => ({ sections: [] }));
  const groups = (snapshot.conversations ?? []).filter((entry) => entry.kind === "group");
  const productBots = bots.map((entry) => {
    const threadId =
      entry.id === chosen
        ? conversation?.id
        : snapshot.conversations.find(
            (chat) => chat.kind === "private" && chat.botIds.includes(entry.id),
          )?.id;
    return botFrom(
      entry,
      threadId,
      botStatus(snapshot.tasks ?? [], entry.id),
      conversationUnread(snapshot, threadId),
      snapshot,
    );
  });
  const productGroups = groups.filter((group) => group.archivedAt === undefined)
    .map((group) => productGroup(group, bots, conversationUnread(snapshot, group.id), snapshot));
  const archivedGroups = groups.filter((group) => group.archivedAt !== undefined)
    .map((group) => productGroup(group, bots, conversationUnread(snapshot, group.id), snapshot));
  const productSections = sections.sections.map((section) => ({
    id: section.id,
    name: section.name,
    position: section.position,
    createdAt: new Date(Number((section as { createdAt?: number }).createdAt ?? Date.now())).toISOString(),
    updatedAt: new Date(Number((section as { updatedAt?: number }).updatedAt ?? Date.now())).toISOString(),
  }));
  return AppBootstrapSchema.parse({
    me: {
      userId: USER_ID,
      email: "local@livingbot.invalid",
      name: "本机用户",
      spaceId: activeSpace.id,
      ticketBoardEnabled: false,
      phoneCallsEnabled: true,
      navLinks: [],
      isDeploymentOwner: false,
      maxUploadSizeBytes: 26_214_400,
      maxAttachmentsPerMessage: 8,
      ...modelDefaults,
      hostCredentialProvider: null,
      hostCredentialSource: null,
      computerHost: "this-mac",
      canChooseHostComputer: false,
      sandboxProvider: "local",
      avatarStyle: "organic",
      ...productPreferences(preferences),
      billingEnabled: false,
    },
    bots: productBots,
    groups: productGroups,
    botSections: productSections,
    archivedBots: snapshot.bots.filter((entry) => entry.archivedAt !== undefined).map((entry) => bot(entry)),
    archivedGroups,
    routines: localRoutines.filter((routine) => routine.botId === chosen).map(productLocalRoutine),
    spaces: spaces.map((space) => {
      const spaceBots = space.bots.filter((bot) => bot.archivedAt === undefined)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((entry) => {
          const threadId = allSnapshot.conversations.find(
            (chat) => chat.kind === "private" && chat.botIds.includes(entry.id) && (chat.spaceId ?? "local") === space.id,
          )?.id;
          return botFrom(entry, threadId, botStatus(allSnapshot.tasks, entry.id), conversationUnread(allSnapshot, threadId), allSnapshot);
        });
      const spaceGroups = space.groups.filter((group) => group.archivedAt === undefined)
        .map((group) => productGroup(group, space.bots, conversationUnread(allSnapshot, group.id), allSnapshot));
      return {
        id: space.id,
        name: space.name,
        isDefault: space.isDefault,
        hasContent: space.hasContent,
        canRename: space.canRename,
        canDelete: space.canDelete,
        botCount: space.botCount,
        bots: spaceBots,
        groups: spaceGroups,
        externalConversations: [],
        botSections: space.botSections.map((section) => ({
          id: section.id, name: section.name, position: section.position,
          createdAt: new Date(Number((section as { createdAt?: number }).createdAt ?? Date.now())).toISOString(),
          updatedAt: new Date(Number((section as { updatedAt?: number }).updatedAt ?? Date.now())).toISOString(),
        })),
      };
    }),
    // The bootstrap thread must carry the same run facts as a later snapshot.
    thread: chosen ? await threadSnapshot(connection, { conversationId: conversation!.id, botId: chosen }) : null,
  });
}

/** The file a message actually delivered, matched by id, name or trailing path. */
function matchMessageFile(
  messages: LocalMessage[], artifacts: Artifact[], messageId: string, reference: string,
): { artifactId: string; name: string; bytes: number | undefined; mediaType: string } | undefined {
  const base = reference.split("/").at(-1) ?? reference;
  const candidates = messages.filter((message) => message.id === messageId)
    .flatMap((message) => message.blocks.flatMap((block) => (block.kind === "file" ? [block] : [])));
  const found = candidates.find((block) =>
    block.artifactId === reference || block.name === reference || block.name === base ||
    block.artifactId.split("/").at(-1) === base);
  if (!found) return undefined;
  // The block carries identity and name; the artifact record carries the real size.
  const artifact = artifacts.find((entry) => entry.id === found.artifactId);
  return {
    artifactId: found.artifactId, name: found.name,
    bytes: artifact?.bytes, mediaType: found.mediaType,
  };
}

/** One raw search row from the local service. */
type LocalSearchHit = {
  messageId: string; conversationId: string; kind: "private" | "group"; role: string;
  createdAt: number; seq: number; botId?: string; botName?: string;
  groupId?: string; groupName?: string; title: string; text: string;
};

/** The shell's search hit: it always names the exact conversation the message lives in. */
function searchHit(hit: LocalSearchHit, snapshot?: LocalSnapshot) {
  // The service returns conversation ids; the sidebar needs the Bot or group name and
  // must be able to reopen the exact session, not the Bot's main thread.
  const conversation = snapshot?.conversations.find((entry) => entry.id === hit.conversationId);
  const botId = hit.botId ?? (conversation?.kind === "private" ? conversation.botIds[0] : undefined);
  const botName = hit.botName ?? snapshot?.bots.find((entry) => entry.id === botId)?.name;
  const groupId = hit.groupId ?? (conversation?.kind === "group" ? conversation.id : undefined);
  const groupName = hit.groupName ?? (conversation?.kind === "group" ? conversation.title : undefined);
  return {
    kind: "message" as const,
    ...(groupId ? { groupId, groupName: groupName ?? "" } : {}),
    ...(botId ? { botId } : {}),
    ...(botName ? { botName } : {}),
    title: hit.title || botName || groupName || "消息",
    snippet: hit.text,
    messageId: hit.messageId,
    seq: hit.seq,
    // Not part of the original hit, but the sidebar needs it to reopen the session
    // the message belongs to instead of the Bot's main thread.
    taskSessionId: conversation?.kind === "private" ? hit.conversationId : undefined,
  };
}

type FindItem =
  | { kind: "message"; id: string; messageId: string; seq: number; role: "user" | "bot";
      senderName: string; createdAt: string; snippet: string }
  | { kind: "file"; id: string; messageId: string; seq: number; role: "user" | "bot";
      senderName: string; createdAt: string; name: string; mimeType: string; size?: number;
      artifactId?: string; path?: string };

/** The sidebar's file filter groups by what the file is, not by its extension list. */
function fileTypeOf(mediaType: string, name: string): "document" | "spreadsheet" | "image" | "other" {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.includes("spreadsheet") || mediaType.includes("csv") || /\.(csv|xlsx?|numbers)$/i.test(name))
    return "spreadsheet";
  if (mediaType.startsWith("text/") || /\.(md|txt|pdf|docx?|pages|json)$/i.test(name)) return "document";
  return "other";
}

/** Which procedure paths this adapter can answer. Everything else stays unhandled. */
export async function localRpc(procedure: string, input: unknown, spaceId?: string | null): Promise<unknown> {
  // oRPC addresses procedures with slashes ("threads/send"); the switches below read dotted names.
  const path = procedure.replace(/^\//, "").replaceAll("/", ".");
  const currentConnection = await localConnection();
  if (!currentConnection) throw new Error("本机服务未连接");
  const connection = spaceId === undefined ? currentConnection : { ...currentConnection, spaceId: spaceId ?? "local" };
  if (path === "bootstrap") return bootstrap(connection, (input ?? {}) as { botId?: string });
  if (path === "memory.loadedContext") {
    const body = (input ?? {}) as { botId?: string };
    if (!body.botId) throw new Error("缺少 Bot 标识");
    return request(connection, `/api/bots/${encodeURIComponent(body.botId)}/loaded-context`);
  }
  if (path === "usage.thread") {
    const body = (input ?? {}) as ThreadTargetInput;
    const target = await resolveTarget(connection, body);
    const query = new URLSearchParams({ botId: target.botId, conversationId: target.conversationId });
    const raw = await request<Record<string, unknown>>(connection, `/api/usage?${query}`);
    return conversationUsage(target.conversationId, raw);
  }
  if (path === "usage.summary") {
    const spaceId = selectedLocalSpaceId(connection);
    const raw = await request<UsageResponse & { runs: number }>(
      connection, `/api/usage?${new URLSearchParams({ spaceId })}`,
    );
    if (!Number.isInteger(raw.runs) || raw.runs < 0) throw new Error("用量接口返回了未知运行次数");
    const { total } = conversationUsage(spaceId, raw);
    return {
      runs: raw.runs,
      inputTokens: total.inputTokens,
      outputTokens: total.outputTokens,
      totalTokens: total.tokens,
      modelCalls: total.calls,
      costUsd: null,
      models: [],
    };
  }
  if (path === "preferences.update") {
    const body = (input ?? {}) as Record<string, unknown>;
    await request<unknown>(connection, "/api/preferences", { method: "POST", body: JSON.stringify(body) });
    return (await bootstrap(connection, {}, false)).me;
  }
  if (path.startsWith("autoReview.") || path.startsWith("approvalRules.")) {
    const body = (input ?? {}) as Record<string, unknown>;
    const scope = body.scope === "space" ? "?scope=space" : "";
    if (path === "autoReview.get") return request(connection, `/api/approval-settings${scope}`);
    if (path === "approvalRules.list") return request(connection, `/api/approval-rules${scope}`);
    if (path === "autoReview.set") return request(connection, `/api/approval-settings${scope}`, {
      method: "POST", body: JSON.stringify(body),
    });
    if (path === "approvalRules.remove") return request(connection, `/api/approval-rules/remove${scope}`, {
      method: "POST", body: JSON.stringify({ id: body.id }),
    });
    throw new Error("原生授权可撤销，新增授权请通过执行时的审批卡片确认");
  }
  if (path === "search.query") {
    const body = (input ?? {}) as { q?: string };
    const query = String(body.q ?? "").trim();
    if (!query) return { hits: [] };
    const [result, snapshot] = await Promise.all([
      request<{ hits: LocalSearchHit[] }>(connection, `/api/search?q=${encodeURIComponent(query)}`),
      request<LocalSnapshot>(connection, "/api/snapshot"),
    ]);
    const visible = new Set(snapshot.conversations
      .filter((conversation) => (conversation.spaceId ?? "local") === selectedLocalSpaceId(connection))
      .map((conversation) => conversation.id));
    return {
      hits: result.hits.filter((hit) => visible.has(hit.conversationId))
        .slice(0, 25).map((hit) => searchHit(hit, snapshot)),
    };
  }
  if (path === "threads.find") {
    const body = (input ?? {}) as ThreadTargetInput & {
      mode?: string; query?: string; sender?: string; from?: string; to?: string;
      fileType?: string; before?: number;
    };
    const target = await resolveTarget(connection, body);
    const mode = body.mode === "files" ? "files" : "messages";
    const query = String(body.query ?? "").trim();
    const before = typeof body.before === "number" ? body.before : undefined;
    const [history, snapshot] = await Promise.all([
      request<{ messages: LocalMessage[]; artifacts?: Artifact[] }>(connection,
        `/api/conversations/${encodeURIComponent(target.conversationId)}/messages`),
      request<LocalSnapshot>(connection, "/api/snapshot"),
    ]);
    const files = history.artifacts ?? snapshot.artifacts ?? [];
    const from = body.from ? Date.parse(body.from) : undefined;
    const to = body.to ? Date.parse(body.to) : undefined;
    const sender = body.sender ?? "all";
    const wantedType = body.fileType ?? "all";
    const items: FindItem[] = [];
    const messages = history.messages
      .map((message, seq) => ({ message, seq }))
      .reverse();
    for (const { message, seq } of messages) {
      if (before !== undefined && seq >= before) continue;
      if (sender !== "all" && (sender === "user") !== (message.role === "user")) continue;
      if (from !== undefined && message.createdAt < from) continue;
      if (to !== undefined && message.createdAt > to) continue;
      const role = message.role === "user" ? "user" as const : "bot" as const;
      const senderName = role === "user" ? "你" :
        snapshot.bots.find((bot) => bot.id === message.botId)?.name ?? "Bot";
      const common = { messageId: message.id, seq, role, senderName,
        createdAt: new Date(message.createdAt).toISOString() };
      if (mode === "messages") {
        const text = message.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("\n");
        if (!text || (query && !text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) continue;
        items.push({
          ...common, kind: "message", id: message.id, snippet: text.slice(0, 400),
        });
      } else {
        for (const block of message.blocks) {
          if (block.kind !== "file") continue;
          const file = files.find((entry) => entry.id === block.artifactId);
          if (wantedType !== "all" && fileTypeOf(block.mediaType, block.name) !== wantedType) continue;
          if (query && !block.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
          items.push({ ...common, kind: "file", id: `${message.id}:${block.artifactId}`,
            name: block.name, mimeType: block.mediaType, size: file?.bytes,
            artifactId: block.artifactId, path: block.name });
        }
      }
    }
    // Keep a message's file references on the same page; the cursor is its real seq.
    const boundary = items[24]?.seq;
    const page = boundary === undefined ? items : items.filter((item) => item.seq >= boundary);
    return { items: page, nextBefore: page.length < items.length ? boundary! : null };
  }
  if (path === "threads.markRead") {
    const body = (input ?? {}) as ThreadTargetInput;
    const target = await resolveTarget(connection, body);
    const result = await request<{ ok: true; unreadAfterSeq: number | null }>(connection,
      `/api/conversations/${encodeURIComponent(target.conversationId)}/read-state`, {
        method: "POST", body: JSON.stringify({}),
      });
    return { ok: true, unreadAfterSeq: result.unreadAfterSeq ?? null };
  }
  if (path === "threads.markUnread") {
    const body = (input ?? {}) as ThreadTargetInput & { messageId?: string };
    const target = await resolveTarget(connection, body);
    await request<unknown>(connection, `/api/conversations/${encodeURIComponent(target.conversationId)}/read-state`, {
      method: "POST",
      body: JSON.stringify({ unread: true, ...(body.messageId ? { messageId: body.messageId } : {}) }),
    });
    return { ok: true };
  }
  if (path === "threads.react") {
    const body = (input ?? {}) as ThreadTargetInput & {
      messageId?: string; reaction?: string; clientNonce?: string;
    };
    const target = await resolveTarget(connection, body);
    const messageId = String(body.messageId ?? "");
    const reaction = String(body.reaction ?? "");
    if (!messageId || !reaction) throw new Error("缺少消息或表情");
    // The service writes the emoji reply under its target in one step; a retried
    // click reuses the nonce and resolves to the same row.
    await request<unknown>(connection, `/api/messages/${encodeURIComponent(messageId)}/reactions`, {
      method: "POST",
      body: JSON.stringify({
        emoji: reaction,
        clientNonce: body.clientNonce ?? crypto.randomUUID(),
        conversationId: target.conversationId,
      }),
    });
    return { ok: true };
  }
  if (path === "threads.fileInfo" || path === "threads.filePreview" || path === "threads.fileAction") {
    const body = (input ?? {}) as ThreadTargetInput & {
      messageId?: string; path?: string; action?: "open" | "reveal";
    };
    const target = await resolveTarget(connection, body);
    const reference = String(body.path ?? "");
    if (!reference) throw new Error("缺少文件标识");
    if (!body.messageId) throw new Error("缺少消息标识");
    // The reference comes from the message text; it is matched to the file that
    // message actually owns in this conversation, never read from the host disk.
    const history = await request<{ messages: LocalMessage[]; artifacts?: Artifact[] }>(connection,
      `/api/conversations/${encodeURIComponent(target.conversationId)}/messages`);
    const file = matchMessageFile(history.messages, history.artifacts ?? [], body.messageId, reference);
    if (!file) throw new Error("这条消息没有交付该文件");
    const artifactId = file.artifactId;
    if (path === "threads.fileAction") {
      // The shell only needs to know the action ran; the service may answer with
      // the file's own body, so the receipt is the product's, not the transport's.
      const response = await fetch(`${connection.origin}/api/files/${encodeURIComponent(artifactId)}/action`, {
        method: "POST",
        headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
        body: JSON.stringify({ action: body.action ?? "open" }),
      });
      if (!response.ok) throw new Error("文件动作未执行");
      return { ok: true as const };
    }
    const metadata = file.bytes !== undefined ? file : await request<{ id: string; name: string; bytes: number; mediaType: string }>(
      connection, `/api/files/${encodeURIComponent(artifactId)}?metadata=1`);
    if (path === "threads.fileInfo") {
      return { path: reference, name: metadata.name, size: metadata.bytes };
    }
    const response = await fetch(`${connection.origin}/api/files/${encodeURIComponent(artifactId)}`, {
      headers: { authorization: `Bearer ${connection.token}` },
    });
    if (!response.ok) throw new Error("文件读取失败");
    return { name: metadata.name, text: await response.text() };
  }
  if (path === "me") return (await bootstrap(connection, {}, false)).me;
  if (path === "events.head") {
    const snapshot = await request<{ cursor: number }>(connection, "/api/snapshot");
    return { threadId: "local-inventory", cursor: snapshot.cursor };
  }
  if (path.startsWith("models.")) {
    const result = await handleLocalModelSettings(path, input, connection, request);
    if (result.handled) return result.value;
  }
  if (path.startsWith("routines.")) return createLocalRoutinesHandler(connection, request)(path, input);
  if (path.startsWith("voice.")) return request(connection, `/api/voice/rpc/${path.slice(6)}`, {
    method: "POST", body: JSON.stringify({ ...(input ?? {}) as object, spaceId: selectedLocalSpaceId(connection) }),
  });
  if (path === "computer.files" || path === "computer.fileAction") {
    const body = (input ?? {}) as { botId?: string; path?: string; action?: "open" | "reveal" };
    const botId = encodeURIComponent(body.botId ?? "");
    const root = `bots/${body.botId ?? ""}`;
    if (!body.botId || !body.path || (body.path !== root && !body.path.startsWith(`${root}/`))) {
      throw new Error("文件路径不属于当前 Bot");
    }
    const relativePath = body.path === root ? "" : body.path.slice(root.length + 1);
    if (path === "computer.files") {
      const query = new URLSearchParams({ path: relativePath });
      const entries = await request<{ path: string; kind: "file" | "dir"; size: number }[]>(
        connection, `/api/bots/${botId}/workspace-files?${query}`,
      );
      return entries.map((entry) => ({ ...entry, path: `${root}/${entry.path}` }));
    }
    return request(connection, `/api/bots/${botId}/workspace-files/action`, {
      method: "POST", body: JSON.stringify({ path: relativePath, action: body.action }),
    });
  }
  if (path.startsWith("scratchpad.")) {
    const body = (input ?? {}) as { botId?: string; itemId?: string; title?: string; status?: string; notes?: string; includeDone?: boolean };
    if (path === "scratchpad.list") {
      const query = new URLSearchParams({ botId: body.botId ?? "", ...(body.includeDone ? { includeDone: "1" } : {}) });
      return request(connection, `/api/scratchpad?${query}`);
    }
    if (path === "scratchpad.create")
      return request(connection, "/api/scratchpad", { method: "POST", body: JSON.stringify(body) });
    if (path === "scratchpad.update")
      return request(connection, `/api/scratchpad/${encodeURIComponent(body.itemId ?? "")}/update`, {
        method: "PATCH", body: JSON.stringify(body),
      });
    if (path === "scratchpad.remove")
      return request(connection, `/api/scratchpad/${encodeURIComponent(body.itemId ?? "")}/remove`, {
        method: "DELETE",
      });
  }
  if (path === "taskSessions.capabilities") return { enabled: true, concurrency: 2 };
  if (path === "taskSessions.list" || path === "taskSessions.start" || path === "taskSessions.rename"
    || path === "taskSessions.archive" || path === "taskSessions.delete") {
    const body = (input ?? {}) as {
      botId?: string; taskSessionId?: string; title?: string; archived?: boolean;
      text?: string; clientNonce?: string; artifactIds?: string[];
    };
    const botId = String(body.botId ?? "");
    const sessions = await privateSessions(connection, botId);
    if (path === "taskSessions.list") {
      // The "deleted" filter in the original dialog is client-side, so archived rows
      // have to come back too; the main thread is not a task session and stays out.
      return sessions;
    }
    if (path === "taskSessions.start") {
      // A new session is a real private conversation: the kernel key is derived from
      // its id, so it never shares context with the Bot's main conversation. The nonce
      // pins that conversation, so a retried acceptance cannot open a second session.
      const title = (body.title ?? body.text ?? "新会话").trim().slice(0, 100) || "新会话";
      const submissionId = body.clientNonce ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const created = await request<{ id: string; title: string }>(connection, "/api/conversations", {
        method: "POST", body: JSON.stringify({ kind: "private", botIds: [botId], title, clientNonce: submissionId }),
      });
      let task: { id: string; conversationId: string };
      let requestMatched = true;
      try {
        task = await request<{ id: string; conversationId: string }>(connection, "/api/submissions", {
          method: "POST", body: JSON.stringify({
            submissionId, conversationId: created.id, botId,
            message: body.text ?? "", attachmentIds: body.artifactIds,
          }),
        });
      } catch (error) {
        // The same nonce with different text is not a retry: the first acceptance stands
        // and the caller keeps the edited text as a draft on that task.
        if (!/conflict/i.test(String(error))) throw error;
        const snapshot = await request<{ tasks: { id: string; conversationId: string }[] }>(
          connection, "/api/snapshot");
        const accepted = snapshot.tasks.find((entry) => entry.conversationId === created.id);
        if (!accepted) throw error;
        task = accepted;
        requestMatched = false;
      }
      const detail = await request<{ run: { id: string } | null }>(
        connection, `/api/tasks/${encodeURIComponent(task.id)}`).catch(() => ({ run: null }));
      const history = await request<{ messages: LocalMessage[] }>(
        connection, `/api/conversations/${encodeURIComponent(created.id)}/messages`).catch(() => ({ messages: [] }));
      return {
        session: await sessionProduct(connection, botId, created.id),
        taskId: task.id, runId: detail?.run?.id ?? task.id,
        seq: Math.max(0, history.messages.findIndex((message) => message.id === `input:${submissionId}`)),
        requestMatched,
      };
    }
    const id = String(body.taskSessionId ?? "");
    if (!id) throw new Error("缺少会话标识");
    if (path === "taskSessions.rename") {
      await request<unknown>(connection, `/api/conversations/${encodeURIComponent(id)}`, {
        method: "PATCH", body: JSON.stringify({ title: body.title ?? "会话" }),
      });
      return sessionProduct(connection, botId, id);
    }
    // Archive and delete both keep the messages: the conversation is marked, never dropped.
    await request<unknown>(connection, `/api/conversations/${encodeURIComponent(id)}`, {
      method: path === "taskSessions.delete" ? "DELETE" : "PATCH",
      ...(path === "taskSessions.delete" ? {} : { body: JSON.stringify({ archived: body.archived !== false }) }),
    });
    return sessionProduct(connection, botId, id);
  }

  if (path === "taskSessions.activeRuns") {
    const snapshot = await request<{ tasks: Task[]; runs: NativeRun[] }>(connection, "/api/snapshot");
    return snapshot.tasks.filter((task) => task.botId === (input as { botId: string }).botId &&
      !["completed", "failed", "cancelled"].includes(task.status)).flatMap((task) => {
        const run = snapshot.runs.findLast((run) => run.taskId === task.id);
        // The dialog lists which session each active run belongs to, so stopping it
        // from the list keeps the session identity instead of collapsing to null.
        return run ? [{
          id: run.id, threadId: task.conversationId, taskSessionId: task.conversationId,
          title: task.title, status: productRun(run, task.botId, task.conversationId, task.id).status,
        }] : [];
      });
  }
  if (path === "taskSessions.stopAll") {
    const body = input as { botId: string; runIds: string[] };
    const snapshot = await request<{ tasks: Task[]; runs: NativeRun[] }>(connection, "/api/snapshot");
    let stopped = 0;
    for (const run of snapshot.runs.filter((run) => body.runIds.includes(run.id))) {
      const task = snapshot.tasks.find((task) => task.id === run.taskId && task.botId === body.botId);
      if (!task) throw new Error("任务不属于当前 Bot");
      await request(connection, `/api/tasks/${encodeURIComponent(task.id)}/cancel`, { method: "POST", body: "{}" });
      stopped++;
    }
    return { stopped };
  }
  if (/^(agentSkills|capabilities|connections|mcp|abilities|marketplace)\./.test(path)) {
    const result = await localAbilitiesRpc(path, input, (url, init) => request(connection, url, init));
    if (result !== undefined) return result;
  }
  if (path === "runs.list") {
    const snapshot = await request<{ bots: LocalBot[]; tasks: Task[]; runs: NativeRun[]; conversations: Conversation[] }>(connection, "/api/snapshot");
    const active = (input as { filter: string }).filter === "active";
    const visibleBotIds = new Set(snapshot.bots
      .filter((bot) => (bot.spaceId ?? "local") === selectedLocalSpaceId(connection))
      .map((bot) => bot.id));
    const runs = (snapshot.runs ?? []).flatMap((run) => {
      const task = snapshot.tasks.find((task) => task.id === run.taskId);
      if (!task || !visibleBotIds.has(task.botId)) return [];
      const terminal = ["completed", "failed", "cancelled"].includes(run.state);
      if (active === terminal) return [];
      const group = snapshot.conversations.find((chat) => chat.id === task.conversationId && chat.kind === "group");
      return [{
        runId: run.id, botId: task.botId,
        botName: snapshot.bots.find((bot) => bot.id === task.botId)?.name ?? task.botId,
        groupId: group?.id ?? null, groupName: group?.title ?? null, threadId: task.conversationId,
        status: run.state === "interrupted" ? "waiting_input" : productRun(run, task.botId, task.conversationId, task.id).status,
        trigger: task.routine ? "routine" : "user", notificationsEnabled: true,
        promptSnippet: task.title, agentMessage: null,
        updatedAt: new Date(run.endedAt ?? task.updatedAt).toISOString(),
      }];
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { runs: active ? runs : runs.slice(0, 100) };
  }
  if (path === "spaces.list") {
    const seed = await bootstrap(connection, {}, false, true);
    const current = seed.spaces.find((space) => space.id === selectedLocalSpaceId(connection)) ?? seed.spaces[0]!;
    return {
      current: {
        id: current.id,
        name: current.name,
        bots: seed.bots,
        groups: seed.groups,
        externalConversations: [],
        botSections: seed.botSections,
      },
      spaces: seed.spaces,
    };
  }
  if (path === "spaces.create") {
    const created = await request<{ id: string; name: string }>(connection, "/api/spaces", {
      method: "POST", body: JSON.stringify(input),
    });
    return {
      ...created, isDefault: false, hasContent: false, canRename: true, canDelete: true,
      botCount: 0, bots: [], groups: [], externalConversations: [], botSections: [],
    };
  }
  if (path === "spaces.rename") {
    const body = input as { spaceId: string; name: string };
    return request(connection, `/api/spaces/${encodeURIComponent(body.spaceId)}`, {
      method: "PATCH", body: JSON.stringify({ name: body.name }),
    });
  }
  if (path === "spaces.remove") {
    const body = input as { spaceId: string };
    return request(connection, `/api/spaces/${encodeURIComponent(body.spaceId)}`, { method: "DELETE" });
  }
  if (path === "groups.create") {
    const body = CreateGroupInput.parse(input);
    const created = await request<Conversation>(connection, "/api/conversations", {
      method: "POST",
      body: JSON.stringify({ kind: "group", botIds: body.botIds, title: body.name }),
    });
    const snapshot = await request<LocalSnapshot>(connection, "/api/snapshot");
    return productGroup(created, snapshot.bots);
  }
  if (path === "groups.update") {
    const { groupId, name, ...patch } = UpdateGroupInput.parse(input);
    const updated = await request<Conversation>(
      connection, `/api/conversations/${encodeURIComponent(groupId)}`, {
        method: "PATCH", body: JSON.stringify({ ...patch, ...(name !== undefined ? { title: name } : {}) }),
      });
    const snapshot = await request<LocalSnapshot>(connection, "/api/snapshot");
    return productGroup(updated, snapshot.bots);
  }
  if (path === "groups.list" || path === "groups.listArchived" || path === "groups.get") {
    const snapshot = await request<LocalSnapshot>(connection, "/api/snapshot");
    const groups = snapshot.conversations.filter((entry) => entry.kind === "group" &&
      (entry.spaceId ?? "local") === selectedLocalSpaceId(connection));
    if (path === "groups.get") {
      const group = groups.find((entry) => entry.id === (input as { groupId: string }).groupId);
      if (!group) throw new Error("群聊不存在");
      return productGroup(group, snapshot.bots);
    }
    return groups.filter((entry) => (entry.archivedAt !== undefined) === (path === "groups.listArchived"))
      .map((entry) => productGroup(entry, snapshot.bots));
  }
  if (path === "groups.remove" || path === "groups.archive" || path === "groups.restore") {
    const { groupId } = input as { groupId: string };
    await request<Conversation>(connection, `/api/conversations/${encodeURIComponent(groupId)}`, {
      method: path === "groups.restore" ? "PATCH" : "DELETE",
      ...(path === "groups.restore" ? { body: JSON.stringify({ archived: false }) } : {}),
    });
    return { ok: true };
  }
  if (path === "bots.list" || path === "bots.listArchived" || path === "bots.get") {
    const body = (input ?? {}) as { botId?: string; id?: string };
    const seed = await bootstrap(connection, {}, false, true);
    if (path === "bots.list") return seed.bots;
    if (path === "bots.listArchived") return seed.archivedBots;
    const found = [...seed.bots, ...seed.archivedBots].find((entry) => entry.id === (body.botId ?? body.id));
    if (!found) throw new Error("Bot 不存在");
    return found;
  }
  if (path === "bots.create" || path === "bots.duplicate") {
    const body = path === "bots.duplicate"
      ? await localRpc("bots.get", input) as Record<string, unknown>
      : CreateBotInput.parse(input);
    const created = await request<LocalBot>(connection, "/api/bots", {
      method: "POST", body: JSON.stringify({
        ...(path === "bots.create" ? body : { ...body, id: undefined, spawnKey: undefined, name: `${body.name} 副本` }),
        spaceId: selectedLocalSpaceId(connection),
        identity: body.instructions ?? "",
      }),
    });
    const chat = await request<{ id: string }>(connection, `/api/bots/${encodeURIComponent(created.id)}/private-conversation`, { method: "POST" });
    return bot(created, chat.id);
  }
  if (path === "bots.reorder") {
    await request(connection, "/api/bots/reorder", { method: "POST", body: JSON.stringify({
      ids: (input as { botIds: string[] }).botIds, spaceId: selectedLocalSpaceId(connection),
    }) });
    return { ok: true };
  }
  if (path === "bots.remove") {
    const body = input as { botId: string; deleteMemories?: boolean };
    return request(connection, `/api/bots/${encodeURIComponent(body.botId)}/remove`, {
      method: "POST", body: JSON.stringify({ deleteMemories: body.deleteMemories === true }),
    });
  }
  if (path === "bots.archive" || path === "bots.restore") {
    await request(connection, `/api/bots/${encodeURIComponent((input as { botId: string }).botId)}/${path.split(".")[1]}`, { method: "POST", body: "{}" });
    return { ok: true };
  }
  if (path.startsWith("botSections.")) {
    const body = (input ?? {}) as { sectionId?: string; name?: string; botId?: string; groupId?: string };
    if (path === "botSections.list") return (await request<{ sections: Record<string, unknown>[] }>(connection, `/api/bot-sections?spaceId=${encodeURIComponent(selectedLocalSpaceId(connection))}`)).sections.map((section) => ({ ...section, spaceId: selectedLocalSpaceId(connection) }));
    if (path === "botSections.create") {
      const section = await request<{ id: string }>(connection, "/api/bot-sections", { method: "POST", body: JSON.stringify({ name: body.name, spaceId: selectedLocalSpaceId(connection) }) });
      if (body.botId) await localRpc("bots.update", { botId: body.botId, sectionId: section.id });
      if (body.groupId) await localRpc("groups.update", { groupId: body.groupId, sectionId: section.id });
      return { ...section, spaceId: selectedLocalSpaceId(connection) };
    }
    if (path === "botSections.update") return {
      ...await request<Record<string, unknown>>(connection, `/api/bot-sections/${encodeURIComponent(body.sectionId ?? "")}`, { method: "PATCH", body: JSON.stringify({ name: body.name }) }), spaceId: selectedLocalSpaceId(connection),
    };
    if (path === "botSections.remove") {
      const snapshot = await request<LocalSnapshot>(connection, "/api/snapshot");
      await request(connection, `/api/bot-sections/${encodeURIComponent(body.sectionId ?? "")}`, { method: "DELETE" });
      return { id: body.sectionId,
        releasedBots: snapshot.bots.filter((bot) => bot.sectionId === body.sectionId &&
          (bot.spaceId ?? "local") === selectedLocalSpaceId(connection)).length,
        releasedGroups: snapshot.conversations.filter((chat) => chat.sectionId === body.sectionId &&
          (chat.spaceId ?? "local") === selectedLocalSpaceId(connection)).length };
    }
  }
  if (path === "bots.update") {
    const body = UpdateBotInput.parse(input);
    if (body.modelProvider != null || body.modelId != null || body.thinkingLevel != null) {
      throw new Error("本机模型由全局设置统一管理");
    }
    if (body.crossSpaceCommunication !== undefined || body.fleetManagement !== undefined)
      throw new Error("本机模式暂不支持跨工作区通信或伙伴管理权限设置");
    const id = body.botId;
    const chat = await request<{ id: string }>(connection, `/api/bots/${encodeURIComponent(id)}/private-conversation`, { method: "POST" });
    return bot(
      await request<LocalBot>(connection, `/api/bots/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ ...body, ...(body.instructions !== undefined ? { identity: body.instructions } : {}) }),
      }),
      chat.id,
    );
  }
  if (path === "threads.send" || path === "threads.sendWithRoutines" || path === "threads.followUp") {
    const body = (input ?? {}) as ThreadTargetInput & {
      text?: string;
      artifactIds?: string[];
      queueMode?: "steer" | "followup";
      clientNonce?: string;
      voicePlayback?: { messageId: string; heardText: string };
      replyToMessageId?: string;
      replyQuote?: string;
    };
    const groupId = body.groupId ? String(body.groupId) : undefined;
    const botId = String(body.botId ?? "");
    // A group turn goes through the group submission flow: the service decides who
    // receives it, and each recipient gets its own task in this one conversation.
    if (groupId) {
      const snapshot = await request<{ conversations: { id: string; kind: string; botIds: string[] }[] }>(
        connection, "/api/snapshot");
      const group = (snapshot.conversations ?? []).find((entry) => entry.id === groupId);
      if (!group || group.kind !== "group") throw new Error("群聊不存在");
      const submissionId = body.clientNonce ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const receipt = await request<{ outcomes: { botId: string; task: { id: string }; accepted: boolean }[] }>(
        connection, "/api/group-submissions", {
          method: "POST",
          body: JSON.stringify({ submissionId, conversationId: groupId, botIds: group.botIds,
            message: body.text ?? "", attachmentIds: body.artifactIds,
            queueMode: path === "threads.followUp" ? "steer" : body.queueMode }),
        });
      const accepted = receipt.outcomes.filter((outcome) => outcome.accepted);
      const first = accepted[0];
      if (!first) throw new Error("群内没有 Bot 接收这条消息");
      const detail = await request<{ run: { id: string } | null }>(
        connection, `/api/tasks/${encodeURIComponent(first.task.id)}`).catch(() => ({ run: null }));
      const history = await request<{ messages: LocalMessage[]; cursor: number }>(
        connection, `/api/conversations/${encodeURIComponent(groupId)}/messages`).catch(() => ({ messages: [], cursor: 0 }));
      const groupSend = { taskId: first.task.id, runId: detail?.run?.id ?? first.task.id,
        seq: Math.max(0, history.messages.findIndex((message) => message.id === `group-input:${submissionId}`)) };
      return path === "threads.sendWithRoutines" ? { routineRunIds: [], send: groupSend }
        : path === "threads.followUp" ? { ok: true } : groupSend;
    }
    // A follow-up in a task session stays in that session; only an untargeted send
    // addresses the Bot's main conversation.
    const target = await resolveTarget(connection, body);
    // The shell identifies a send by its nonce; reuse it as the accepted submission
    // identity so a retried click cannot create a second native input.
    const submissionId = body.clientNonce ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const task = await request<{ id: string; runId?: string; conversationId: string }>(
      connection,
      "/api/submissions",
      {
        method: "POST",
        body: JSON.stringify({
          submissionId,
          conversationId: target.conversationId,
          botId: target.botId,
          message: body.text ?? "",
          voicePlayback: body.voicePlayback,
          attachmentIds: body.artifactIds,
          queueMode: path === "threads.followUp" ? "steer" : body.queueMode,
        }),
      },
    );
    // The native run identity comes from the run record the service keeps for this task.
    const detail = await request<{ run: { id: string } | null }>(
      connection,
      `/api/tasks/${encodeURIComponent(task.id)}`,
    ).catch(() => ({ run: null }));
    const history = await request<{ messages: LocalMessage[] }>(
      connection,
      `/api/conversations/${encodeURIComponent(target.conversationId)}/messages`,
    ).catch(() => ({ messages: [] }));
    const send = {
      taskId: task.id,
      runId: detail?.run?.id ?? task.runId ?? task.id,
      seq: Math.max(
        0,
        history.messages.findIndex((message) => message.id === `input:${submissionId}`),
      ),
    };
    return path === "threads.sendWithRoutines" ? { routineRunIds: [], send } : path === "threads.followUp" ? { ok: true } : send;
  }
  if (path === "threads.get" || path === "threads.head" || path === "threads.messages") {
    const body = (input ?? {}) as ThreadTargetInput & {
      before?: number; around?: { messageId?: string; seq?: number };
    };
    const target = await resolveTarget(connection, body);
    const snapshot = await threadSnapshot(connection, target);
    if (path === "threads.messages")
      return { threadId: snapshot.threadId, messages: snapshot.messages, olderCursor: null };
    if (path === "threads.head") return { threadId: snapshot.threadId, cursor: snapshot.cursor };
    return snapshot;
  }
  if (path === "threads.nameTurns") {
    // Naming runs against the model the kernel is configured with; the answer is the titles
    // that came back, so the caller can stop asking for them.
    const body = (input ?? {}) as ThreadTargetInput & { messageIds?: string[] };
    const target = await resolveTarget(connection, body);
    return request<{ named: { id: string; title: string }[] }>(
      connection,
      `/api/conversations/${encodeURIComponent(target.conversationId)}/turn-titles`,
      { method: "POST", body: JSON.stringify({ messageIds: body.messageIds ?? [] }) },
    );
  }
  if (path === "threads.stop") {
    // Stopping the thread means stopping every native run and queued input the
    // resolved conversation currently owns, and saying how many.
    const body = (input ?? {}) as ThreadTargetInput;
    const target = await resolveTarget(connection, body);
    const snapshot = await request<{
      tasks: { id: string; conversationId: string; status: string }[];
    }>(connection, "/api/snapshot");
    const active = (snapshot.tasks ?? []).filter(
      (task) =>
        task.conversationId === target.conversationId &&
        ["queued", "running", "waiting", "stopping"].includes(task.status),
    );
    for (const task of active) {
      await request<unknown>(connection, `/api/tasks/${encodeURIComponent(task.id)}/cancel`, {
        method: "POST",
        body: "{}",
      });
    }
    return {
      ok: true,
      cancelledRunCount: active.filter((task) => task.status !== "queued").length,
      cancelledPendingMessageCount: active.filter((task) => task.status === "queued").length,
    };
  }
  if (["threads.answerCall", "threads.declineCall", "threads.endCall"].includes(path)) {
    return request(connection, `/api/calls/${path.slice(8)}`, {
      method: "POST", body: JSON.stringify(input ?? {}),
    });
  }
  if (path === "threads.answer") {
    const body = (input ?? {}) as {
      botId?: string;
      runId: string;
      messageId: string;
      answer: string;
      dismiss?: boolean;
      clientNonce?: string;
      fields?: { label: string; value: string; hidden: boolean }[];
    };
    const snapshot = await request<{
      interactions: Interaction[];
    }>(connection, "/api/snapshot");
    const interaction = (snapshot.interactions ?? []).find(
      (entry) => entry.id === body.messageId && entry.runId === body.runId,
    );
    if (!interaction) throw new Error("没有等待回答的问题或审批");
    // An answer belongs to the session that asked; a card opened from another
    // session must not resolve it silently.
    const target = await resolveTarget(connection, body);
    if (interaction.conversationId !== target.conversationId) throw new Error("这张卡片不属于当前会话");
    const resolutionId = body.clientNonce ?? crypto.randomUUID();
    if (interaction.secureInput) {
      const binding = interaction.secureInput.connection;
      if (binding && !body.dismiss && (!body.fields || body.fields.length !== binding.fields.length ||
        binding.fields.some((field, index) => body.fields?.[index]?.label !== field.label))) {
        throw new Error("请填写全部凭证字段");
      }
      await request(connection,
        `/api/tasks/${encodeURIComponent(interaction.taskId)}/interactions/${encodeURIComponent(interaction.id)}/credential`, {
          method: "POST",
          body: JSON.stringify(body.dismiss
            ? { resolutionId: interaction.resolutionId ?? resolutionId, cancel: true }
            : binding
              ? { values: Object.fromEntries(binding.fields.map((field, index) => [field.key, body.fields![index]!.value])) }
              : { resolutionId: interaction.resolutionId ?? resolutionId, value: body.answer }),
        });
      return { ok: true };
    }
    const question = interaction.questions[0];
    if (interaction.kind === "question" && !question) throw new Error("问题缺少字段");
    if (
      interaction.kind === "question" &&
      (interaction.questions.length > 1 || question?.multiSelect)
    ) {
      throw new Error("请在问题卡片中完成选择");
    }
    const answer =
      interaction.kind === "approval"
        ? {
            resolutionId,
            decision:
              body.answer === "allow"
                ? "allow-once"
                : body.answer === "always"
                  ? "allow-always"
                  : body.answer,
          }
        : body.dismiss
          ? { resolutionId, cancel: true }
          : { resolutionId, answers: { [question!.id]: [body.answer] } };
    await request<unknown>(
      connection,
      `/api/tasks/${encodeURIComponent(interaction.taskId)}/interactions/${encodeURIComponent(interaction.id)}/resolve`,
      { method: "POST", body: JSON.stringify(answer) },
    );
    return { ok: true };
  }
  if (path === "threads.upload" || path === "artifacts.upload" || path === "artifacts.create") {
    const body = (input ?? {}) as ThreadTargetInput & {
      conversationId?: string;
      file?: File;
      name?: string;
      mimeType?: string;
      contentBase64?: string;
      clientNonce?: string;
      draftTitle?: string;
    };
    const file =
      body.file ??
      (body.contentBase64
        ? new File(
            [Uint8Array.from(atob(body.contentBase64), (char) => char.charCodeAt(0))],
            body.name ?? "附件",
            { type: body.mimeType ?? "application/octet-stream" },
          )
        : undefined);
    if (!file) throw new Error("没有可上传的文件");
    // An attachment belongs to the session it was dropped into, not always to main.
    let target: ThreadTargetInput = body;
    if (body.taskSessionId?.startsWith("draft:")) {
      if (!body.botId || body.groupId) throw new Error("新会话缺少所属 Bot");
      const created = await request<{ id: string }>(connection, "/api/conversations", {
        method: "POST", body: JSON.stringify({ kind: "private", botIds: [body.botId],
          title: body.draftTitle?.trim() || "新会话", clientNonce: body.taskSessionId }),
      });
      target = { botId: body.botId, taskSessionId: created.id };
    }
    const conversationId = body.conversationId ??
      (await resolveTarget(connection, target)).conversationId;
    const group = body.groupId ? (await request<LocalSnapshot>(connection, "/api/snapshot"))
      .conversations.find((entry) => entry.id === body.groupId && entry.kind === "group") : undefined;
    const attachmentBotId = body.botId ?? group?.botIds[0] ?? "";
    const query = new URLSearchParams({
      botId: attachmentBotId,
      name: file.name,
      mediaType: file.type || "application/octet-stream",
    });
    const response = await fetch(
      `${connection.origin}/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(body.clientNonce ?? crypto.randomUUID())}?${query}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.token}`,
          "content-type": "application/octet-stream",
        },
        body: file,
      },
    );
    if (!response.ok) {
      const failure = await response.json().catch(() => undefined) as { error?: string } | undefined;
      throw new Error(failure?.error || "附件上传失败");
    }
    return productArtifact((await response.json()) as Artifact, body.groupId);
  }
  if (path === "artifacts.listSpace" || path === "artifacts.list") {
    const body = (input ?? {}) as { botId?: string; cursor?: string; limit?: number };
    const query = new URLSearchParams();
    if (body.botId) query.set("botId", body.botId);
    if (body.cursor) query.set("cursor", body.cursor);
    if (body.limit) query.set("limit", String(body.limit));
    const [page, snapshot] = await Promise.all([
      request<{ files: Artifact[]; next?: string }>(connection, `/api/files?${query}`),
      request<LocalSnapshot>(connection, "/api/snapshot"),
    ]);
    const items = page.files.map((file) => ({
      ...productArtifact(file, snapshot.conversations.find((chat) => chat.id === file.conversationId && chat.kind === "group")?.id),
      versionCount: 1,
    }));
    return path === "artifacts.list" ? items : { items, nextCursor: page.next ?? null };
  }
  if (path === "artifacts.listVersions" || path === "artifacts.fileInfo") {
    const body = input as { artifactId?: string; familyId?: string };
    const metadata = await request<Artifact>(connection, `/api/files/${encodeURIComponent(body.artifactId ?? body.familyId ?? "")}?metadata=1`);
    if (path === "artifacts.fileInfo") return { sourcePath: null, size: metadata.bytes };
    return [{ id: metadata.id, name: metadata.name, version: 1, createdAt: new Date(metadata.createdAt).toISOString() }];
  }
  if (path === "artifacts.fileAction" || path === "artifacts.remove") {
    const body = input as { artifactId: string; action?: string };
    return request(connection, `/api/files/${encodeURIComponent(body.artifactId)}/${path === "artifacts.remove" ? "trash" : "action"}`, {
      method: "POST", body: JSON.stringify({ action: body.action }),
    });
  }
  if (path === "artifacts.get" || path === "artifacts.getById") {
    const body = (input ?? {}) as { artifactId?: string; id?: string };
    const id = String(body.artifactId ?? body.id ?? "");
    const metadata = await request<Artifact>(
      connection,
      `/api/files/${encodeURIComponent(id)}?metadata=1`,
    );
    const response = await fetch(`${connection.origin}/api/files/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${connection.token}` },
    });
    if (!response.ok) throw new Error("文件读取失败");
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return {
      ...productArtifact(metadata),
      contentBase64: btoa(binary),
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
      size: bytes.byteLength,
    };
  }
  if (path === "threads.clear") {
    // Clearing is recoverable: the transcript leaves the view and the same
    // conversation keeps working, so nothing on disk is dropped.
    const body = (input ?? {}) as ThreadTargetInput;
    const target = await resolveTarget(connection, body);
    await request<unknown>(connection, `/api/conversations/${encodeURIComponent(target.conversationId)}/clear`, {
      method: "POST", body: "{}",
    });
    return { ok: true };
  }
  if (path === "export.bot") {
    const body = (input ?? {}) as { botId?: string; botIds?: string[] } & ThreadTargetInput;
    const botId = String(body.botId ?? body.botIds?.[0] ?? "");
    if (!botId) throw new Error("缺少 Bot 标识");
    // The reviewed exporter already knows how to package a Bot; reuse it verbatim.
    const exported = await request<{ files: { name: string; contentBase64: string }[]; name?: string }>(
      connection, `/api/marketplace/export`, { method: "POST", body: JSON.stringify({ botId }) },
    );
    return exported;
  }
  if (path === "threads.file" || path === "artifacts.content") {
    const body = (input ?? {}) as { artifactId?: string; id?: string };
    const id = String(body.artifactId ?? body.id ?? "");
    const response = await fetch(`${connection.origin}/api/files/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${connection.token}` },
    });
    if (!response.ok) throw new Error("文件读取失败");
    return { url: URL.createObjectURL(await response.blob()) };
  }
  throw new Error(`本机服务尚未实现：${path}`);
}

/**
 * The task-session chat's subscription, served from the same local journal the main
 * chat uses instead of a second transport. Each change re-reads the conversation and
 * yields the messages that appeared or changed, so live output streams into the
 * transcript exactly like the private chat.
 */
export async function* localThreadSubscription(
  input: ThreadTargetInput & { cursor?: number },
  signal: AbortSignal,
): AsyncGenerator<ProductEvent> {
  const connection = await localConnection();
  if (!connection) return;
  const target = await resolveTarget(connection, input);
  const known = new Map<string, string>();
  let artifacts: Artifact[] = [];
  const loaded = await request<{ messages: LocalMessage[]; artifacts?: Artifact[] }>(connection,
    `/api/conversations/${encodeURIComponent(target.conversationId)}/messages`)
    .catch(() => ({ messages: [] as LocalMessage[], artifacts: [] as Artifact[] }));
  artifacts = loaded.artifacts ?? [];
  for (const message of loaded.messages) known.set(message.id, messageFingerprint(message));
  for await (const stored of openLocalThreadEvents(signal, input.cursor ?? 0)) {
    if (stored.type === "thread.call.ended" && stored.data.conversationId === target.conversationId) {
      yield {
        id: `local:${stored.cursor}:call`, spaceId: selectedLocalSpaceId(), botId: target.botId,
        threadId: target.conversationId, seq: stored.cursor, type: "thread.call.ended",
        createdAt: new Date().toISOString(), payload: stored.data,
      };
      continue;
    }
    if (stored.type === "heartbeat") {
      yield {
        id: "local:heartbeat", spaceId: selectedLocalSpaceId(), botId: target.botId,
        threadId: target.conversationId, seq: 0, type: "heartbeat",
        createdAt: new Date().toISOString(), payload: {},
      };
      continue;
    }
    if (!localThreadEventTypes.has(stored.type)) continue;
    const history = await request<{ messages: LocalMessage[]; artifacts?: Artifact[] }>(connection,
      `/api/conversations/${encodeURIComponent(target.conversationId)}/messages`)
      .catch(() => ({ messages: [] as LocalMessage[], artifacts: [] as Artifact[] }));
    if (history.artifacts) artifacts = history.artifacts;
    for (const message of history.messages) {
      const fingerprint = messageFingerprint(message);
      const previous = known.get(message.id);
      if (previous === fingerprint) continue;
      known.set(message.id, fingerprint);
      yield {
        id: `local:${stored.cursor}:${message.id}`,
        spaceId: selectedLocalSpaceId(),
        botId: message.botId || target.botId,
        threadId: target.conversationId,
        seq: stored.cursor,
        runId: message.runId,
        type: previous === undefined ? "thread.message.created" : "thread.message.updated",
        createdAt: new Date(message.createdAt).toISOString(),
        payload: {
          messageId: message.id,
          localTranscript: true,
          role: message.role === "assistant" ? "bot" : message.role,
          blocks: toProductBlocks(message.blocks, artifacts),
          ...(message.clientNonce ? { clientNonce: message.clientNonce } : {}),
          ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
        },
      };
    }
    artifacts = history.artifacts ?? artifacts;
    yield {
      id: `local:${stored.cursor}:meta`, spaceId: selectedLocalSpaceId(), botId: target.botId,
      threadId: target.conversationId, seq: stored.cursor, type: "thread.meta",
      createdAt: new Date().toISOString(), payload: { localJournalType: stored.type },
    };
  }
}

const localThreadEventTypes = new Set([
  "messages.changed", "conversations.changed", "tasks.changed", "runs.changed", "interactions.changed",
]);

function messageFingerprint(message: LocalMessage): string {
  return JSON.stringify([message.blocks, message.final, message.updatedAt]);
}

/**
 * Run `refresh` whenever the local journal reports one of `types`. The task tab row
 * uses it so a status change shows up on the event instead of waiting for its timer.
 */
export function useLocalJournalRefresh(types: string[], refresh: () => void): void {
  // Reuse the inventory feed's current cursor and reconnect handling. Starting
  // from zero replays the entire history and can close a busy feed on backpressure.
  useLocalInventoryUpdates(async () => refresh(), types);
}

/** True when a local connection was already handed to this page (URL or preload). */export function localConnected(): boolean {
  if (resolved) return true;
  try {
    if (window.sessionStorage.getItem(STORAGE_KEY)) return true;
  } catch {
    // Storage unavailable; fall back to the address bar.
  }
  return Boolean(readAddressConnection());
}

/** Reuse 1.0's reconnect loop for native journal updates outside the open chat. */
export function useLocalInventoryUpdates(onChange: () => Promise<void>, eventTypes = [
  "tasks.changed", "bots.changed", "botSections.changed", "conversations.changed",
  "artifacts.changed", "routines.changed", "notifications.changed",
]): void {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const key = eventTypes.join(",");
  useEffect(() => {
    if (!localConnected()) return;
    const controller = new AbortController();
    const wanted = new Set(key.split(","));
    const refresh = createRefreshCoalescer(() => onChangeRef.current());
    let head: { threadId: string; cursor: number } | null = null;
    const load = async () => {
      head = await localRpc("events.head", {}) as { threadId: string; cursor: number };
      return head;
    };
    void runThreadSubscription({
      signal: controller.signal, loadInitial: load, loadHead: load,
      refresh: async () => { await refresh.invalidate(); await load(); },
      currentSnapshot: () => head,
      subscribe: async (cursor, signal) => (async function* () {
        for await (const event of openLocalThreadEvents(signal, cursor)) yield {
          id: `local-inventory:${event.cursor}`, spaceId: selectedLocalSpaceId(), botId: "local-inventory",
          threadId: "local-inventory", seq: event.cursor,
          type: event.type === "heartbeat" ? "heartbeat" as const : "thread.meta" as const,
          createdAt: new Date().toISOString(), payload: { localJournalType: event.type },
        };
      })(),
      applyEvent: (event) => { head = { threadId: "local-inventory", cursor: event.seq }; },
      onEvent: (event) => {
        if (wanted.has(String(event.payload.localJournalType)))
          void refresh.invalidate().catch(() => undefined);
      },
    }).catch(() => undefined);
    return () => controller.abort();
  }, [key]);
}

/**
 * The desktop app has no Better Auth server: the local service already
 * authenticated the page with its own token, so the shell's session is that
 * connection. Nothing is faked beyond the identity the local service owns.
 */
export function localSession(): {
  user: Record<string, unknown>;
  session: Record<string, unknown>;
} | null {
  if (!localConnected()) return null;
  const now = new Date();
  return {
    user: {
      id: "local-owner",
      email: "local@livingbot.invalid",
      name: "本机用户",
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    },
    session: {
      id: "local-session",
      token: "local",
      userId: "local-owner",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 24 * 3600_000),
    },
  };
}

/** Removes the credential-bearing parameters while keeping the current route. */
function stripAddressBar(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("localOrigin");
    url.searchParams.delete("localToken");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // A read-only history still leaves the in-memory connection usable.
  }
}

/** One hook for both gates: the local connection when present, Better Auth otherwise. */
export function useLocalSession<T>(remote: () => T): T {
  const result = remote();
  // The desktop hands the connection over asynchronously, so the first paint cannot
  // decide on sessionStorage alone: ask once and re-render when it resolves.
  const [, bump] = useState(0);
  useEffect(() => {
    let active = true;
    void localConnection().then((connection) => {
      if (active && connection) bump((value) => value + 1);
    });
    return () => {
      active = false;
    };
  }, []);
  const local = localSession();
  if (!local) return result;
  return {
    ...(result as Record<string, unknown>),
    data: local,
    error: null,
    isPending: false,
    isRefetching: false,
  } as unknown as T;
}

/**
 * Event feed from the local service. The shell refreshes the open thread when
 * anything changes, so no delta protocol has to be invented here.
 */
export async function* openLocalThreadEvents(
  signal: AbortSignal,
  after = 0,
): AsyncGenerator<{ cursor: number; type: string; data: Record<string, unknown> }> {
  const connection = await localConnection();
  if (!connection) return;
  const cursor = Math.max(0, after);
  if (signal.aborted) return;
  const response = await fetch(`${connection.origin}/api/events?after=${cursor}`, {
    headers: { authorization: `Bearer ${connection.token}`, accept: "text/event-stream" },
    signal,
  });
  if (!response.ok || !response.body) throw new Error("事件连接失败");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      let end: number;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) {
          if (frame.startsWith(":")) yield { cursor: 0, type: "heartbeat", data: {} };
          continue;
        }
        const stored = JSON.parse(data) as {
          cursor?: number;
          type?: string;
          data?: { role?: string; status?: string; blocks?: unknown };
        };
        yield stored as { cursor: number; type: string; data: Record<string, unknown> };
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (signal.aborted) return;
  throw new Error("事件连接已断开");
}

/** Reuse the native preview transport without exposing connection credentials to components. */
export const localPreviewClient = {
  get origin(): string { return resolved?.origin ?? ""; },
  async request<T>(path: string, body?: unknown): Promise<T> {
    const connection = await localConnection();
    if (!connection) throw new Error("本机服务未连接");
    return request<T>(connection,path,body === undefined ? undefined : {method:"POST",body:JSON.stringify(body)});
  },
  send(input: {submissionId:string;conversationId:string;botId:string;message:string}): Promise<unknown> {
    return this.request("/api/submissions",{...input,queueMode:"steer"});
  },
};
