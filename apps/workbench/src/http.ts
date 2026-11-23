import { BotRemoval } from "./bot-removal.ts";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { Artifact, Bot, BotSection, ContextShare, Conversation, GroupAssignment, Message, ProductEvent, Run, ScratchpadItem, Task } from "../../../packages/workbench/src/contracts.ts";
import type { WorkbenchService } from "../../../packages/workbench/src/service.ts";
import type { InteractionAnswer } from "../../../packages/workbench/src/interactions.ts";
import { maxFileBytes } from "../../../packages/workbench/src/files.ts";
import { memoryReference } from "../../../packages/kernel-runtime/src/memory.ts";
import type { MemoryQuery } from "../../../packages/kernel-runtime/src/memory.ts";
import type { Migrations } from "../../../packages/workbench/src/migration.ts";
import type { Marketplace } from "../../../packages/workbench/src/marketplace.ts";
import type { ServiceConnections, ServiceConnectionInput, ServiceConnectionUpdate } from "../../../packages/kernel-runtime/src/connections.ts";
import type { ServiceAuthorizations } from "../../../packages/workbench/src/service-authorizations.ts";
import type { OpenClawModelSettings } from "../../../packages/kernel-runtime/src/model-settings.ts";
import { routineExecutionId, routineSchedule } from "../../../packages/kernel-runtime/src/routines.ts";
import type { Workspaces } from "../../../packages/workbench/src/workspaces.ts";
import type { NativeContextPreview } from "../../../packages/kernel-runtime/src/context-preview.ts";
import type { AgentRegistration } from "../../../packages/kernel-runtime/src/agents.ts";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { botIntroPrompt } from "../../../packages/workbench/src/bot-intro.ts";
import { localVoice } from "./voice.ts";
import { localCalls } from "./calls.ts";
import { OpenClawApprovalSettings } from "../../../packages/kernel-runtime/src/approval-settings.ts";
import { modelRequestDuration, recordModelRequestUsage } from "../../../packages/workbench/src/model-usage.ts";

import { OpenClawMemorySettings } from "../../../packages/kernel-runtime/src/memory-settings.ts";
import type { MemoryPreferencesInput } from "../../../packages/kernel-runtime/src/memory-settings.ts";
import { SuperAdministrator } from "../../../packages/workbench/src/admin.ts";
import { SkillDocuments } from "../../../packages/kernel-runtime/src/skill-documents.ts";
import { SystemSettings } from "./system-settings.ts";
import type { AuditSettingsInput } from "./system-settings.ts";

class HttpFailure extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type ApiOptions = {
  service: WorkbenchService;
  token: string;
  allowedOrigins?: string[];
  webRoot?: string;
  nativeToolToken?: string;
  migrations?: Migrations;
  marketplace?: Marketplace;
  connections?: ServiceConnections;
  authorizations?: ServiceAuthorizations;
  modelSettings?: Pick<OpenClawModelSettings, "read" | "save"> & Partial<Pick<OpenClawModelSettings, "discover">>;
  botWorkspaces?: Workspaces;
  agentRegistration?: AgentRegistration;
  nativeContextPreview?: (agentId: string) => Promise<NativeContextPreview>;
};

function authenticate(request: IncomingMessage, token: string): void {
  const credential = request.headers.authorization;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(typeof credential === "string" ? credential : "");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new HttpFailure(401, "Authentication required");
  }
}

async function body(request: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new HttpFailure(415, "Expected application/json");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new HttpFailure(413, "Request is too large");
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new HttpFailure(400, "Expected a JSON object");
  }
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new HttpFailure(400, `Missing ${name}`);
  return value;
}

/**
 * A UUID-shaped id derived from what the user submitted, so a retried new-session
 * acceptance lands on the same conversation instead of opening another one.
 */
function sessionIdFor(botIds: string[], clientNonce: string): string {
  const digest = createHash("sha256").update(JSON.stringify([botIds, clientNonce])).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

/** Newest first, scoped to this conversation, for the latest reported usage. */
function conversationUsageRuns(
  store: { list<T>(kind: string, limit?: number): T[]; find<T>(kind: string, field: "taskId", value: string): T[] },
  conversationId: string,
): { id: string; botId: string; sessionKey: string; status: string; startedAt: number; completedAt: number | null }[] {
  return store.list<Task>("tasks", -1)
    .filter((entry) => entry.conversationId === conversationId)
    .flatMap((task) => store.find<Run>("runs", "taskId", task.id).map((run) => ({
      id: run.id, botId: task.botId, sessionKey: run.sessionKey, status: run.state,
      startedAt: run.createdAt, completedAt: run.endedAt ?? null,
    })))
    .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
}

async function fileBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxFileBytes) throw new HttpFailure(413, "File exceeds 25 MB");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createWorkbenchApi(options: ApiOptions) {
  if (options.token.length < 32) throw new Error("An application token of at least 32 characters is required");
  const streams = new Set<ServerResponse>();
  const voice = localVoice(options.service.store);
  const calls = localCalls(options.service);
  const botRemoval = new BotRemoval(options.service, options.botWorkspaces);
  const approvalSettings = new OpenClawApprovalSettings(options.service.kernel);
  const memorySettings = new OpenClawMemorySettings(options.service.kernel);
  const systemSettings = new SystemSettings(options.service, options.botWorkspaces, options.agentRegistration, options.modelSettings ? async () => (await options.modelSettings!.read()).configured : undefined);
  const skillDocuments = new SkillDocuments(options.service.kernel);
  const administrator = options.botWorkspaces ? new SuperAdministrator(options.service, options.botWorkspaces) : undefined;
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.end(); return; }
      const status = error instanceof HttpFailure ? error.status : 400;
      json(response, status, { error: error instanceof Error ? error.message : "Request failed" });
    });
  });
  server.requestTimeout = 45_000;
  server.headersTimeout = 10_000;

  async function startBotIntro(bot: Bot): Promise<void> {
    if (bot.spawnKey !== "onboarding:first" || !options.modelSettings) return;
    const store = options.service.store;
    const id = `bot-intro:${bot.id}`;
    if (store.get("submissions", id) || store.list<Task>("tasks", -1).some((task) => task.botId === bot.id)) return;
    if (!(await options.modelSettings.read().catch(() => ({ configured: false }))).configured) return;
    const conversation = store.privateConversation(bot.id);
    if (store.messages(conversation.id).length) return;
    const space = store.listSpaces().find((entry) => entry.id === (bot.spaceId ?? "local"));
    // Persist through the existing submission/recovery path, exactly once.
    await options.service.submit({
      submissionId: id, botId: bot.id, conversationId: conversation.id,
      message: botIntroPrompt(space?.name ?? ""), hiddenInput: true,
    }).catch((error: unknown) => {
      store.recordEvent("operation.failed", bot.id, {
        stage: "bot-intro", message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const address = server.address() as AddressInfo | null;
    const host = `127.0.0.1:${address?.port}`;
    if (request.headers.host !== host) throw new HttpFailure(403, "Invalid local host");
    const origin = request.headers.origin;
    const permitted = new Set([`http://${host}`, ...(options.allowedOrigins ?? [])]);
    if (origin && !permitted.has(origin)) throw new HttpFailure(403, "Origin is not allowed");
    if (origin) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE");
      response.setHeader("access-control-allow-headers", "Authorization, Content-Type, Last-Event-ID");
      response.writeHead(204); response.end(); return;
    }
    const url = new URL(request.url ?? "/", `http://${host}`);
    const method = request.method;
    if (method === "GET" && !url.pathname.startsWith("/api/") && options.webRoot) {
      const root = await realpath(options.webRoot);
      const name = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const path = resolve(root, name);
      if (path !== root && !path.startsWith(`${root}${sep}`)) throw new HttpFailure(403, "Invalid asset path");
      let actual = await realpath(path).catch(() => undefined);
      if (!actual || !actual.startsWith(`${root}${sep}`)) {
        // A route inside the single-page app: serve its entry document, not a 404.
        // Only extensionless paths qualify, so a missing asset still fails loudly.
        if (extname(url.pathname) === "") actual = await realpath(resolve(root, "index.html")).catch(() => undefined);
        if (!actual || !actual.startsWith(`${root}${sep}`)) throw new HttpFailure(404, "Unknown asset");
      }
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2",
        // A browser asks for the icon and any png asset by name; without these it gets a 404.
        ".png": "image/png", ".ico": "image/x-icon",
      };
      const type = types[extname(actual)];
      if (!type) throw new HttpFailure(404, "Unknown asset");
      response.setHeader("content-security-policy", "object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
      response.writeHead(200, { "content-type": type });
      response.end(await readFile(actual)); return;
    }
    if (url.pathname === "/api/kernel/admin-context" && method === "POST") {
      if (!options.nativeToolToken || !administrator) throw new HttpFailure(404, "管理员上下文不可用");
      authenticate(request, options.nativeToolToken);
      const input = await body(request);
      json(response, 200, await administrator.promptContext({agentId:string(input.agentId,"agentId"),sessionKey:string(input.sessionKey,"sessionKey"),runId:string(input.runId,"runId")})); return;
    }
    if (method === "POST" && url.pathname === "/api/kernel/admin") {
      if (!options.nativeToolToken || !administrator) throw new HttpFailure(404, "管理员工具不可用");
      authenticate(request, options.nativeToolToken);
      const input = await body(request);
      const authority = { agentId: string(input.agentId, "agentId"), sessionKey: string(input.sessionKey, "sessionKey"), runId: string(input.runId, "runId") };
      json(response, 200, await administrator.invoke({ ...input, ...authority })); return;
    }
    if (method === "POST" && url.pathname === "/api/kernel/calls") {
      if (!options.nativeToolToken) throw new HttpFailure(404, "Native tools are unavailable");
      authenticate(request, options.nativeToolToken);
      const input = await body(request);
      json(response, 200, calls.tool({
        operation: string(input.operation, "operation"), toolCallId: string(input.toolCallId, "toolCallId"),
        agentId: string(input.agentId, "agentId"), sessionKey: string(input.sessionKey, "sessionKey"),
        runId: string(input.runId, "runId"),
        ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
        ...(typeof input.opening === "string" ? { opening: input.opening } : {}),
        ...(typeof input.title === "string" ? { title: input.title } : {}),
        ...(typeof input.farewell === "string" ? { farewell: input.farewell } : {}),
      })); return;
    }
    if (method === "POST" && url.pathname === "/api/kernel/model-usage") {
      if (!options.nativeToolToken) throw new HttpFailure(404, "Native tools are unavailable");
      authenticate(request, options.nativeToolToken);
      const input = await body(request);
      recordModelRequestUsage(options.service.store, {
        agentId: string(input.agentId, "agentId"), sessionKey: string(input.sessionKey, "sessionKey"),
        runId: string(input.runId, "runId"), callId: string(input.callId, "callId"),
        durationMs: input.durationMs, outcome: input.outcome,
        ...(input.timeToFirstByteMs === undefined ? {} : { timeToFirstByteMs: input.timeToFirstByteMs }),
      });
      json(response, 200, { recorded: true }); return;
    }
    if (method === "POST" && url.pathname === "/api/kernel/scheduled-run") {
      if (!options.nativeToolToken) throw new HttpFailure(404, "Native tools are unavailable");
      authenticate(request, options.nativeToolToken);
      const input = await body(request);
      if (input.trigger !== "cron") throw new HttpFailure(400, "Invalid scheduled run trigger");
      const task = await options.service.adoptScheduledRun({
        trigger: "cron", jobId: string(input.jobId, "jobId"), runId: string(input.runId, "runId"),
        sessionId: string(input.sessionId, "sessionId"), agentId: string(input.agentId, "agentId"),
        sessionKey: string(input.sessionKey, "sessionKey"),
      });
      json(response, 200, { adopted: !!task, ...(task ? { taskId: task.id } : {}) });
      return;
    }
    if (method === "POST" && url.pathname === "/api/kernel/calls") {
      if (!options.nativeToolToken) throw new HttpFailure(404, "Native tools are unavailable");
      authenticate(request, options.nativeToolToken);
      const input = await body(request);
      json(response, 200, calls.tool({
        agentId: string(input.agentId, "agentId"), sessionKey: string(input.sessionKey, "sessionKey"),
        runId: string(input.runId, "runId"), toolCallId: string(input.toolCallId, "toolCallId"),
        operation: string(input.operation, "operation"),
        ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
        ...(typeof input.opening === "string" ? { opening: input.opening } : {}),
        ...(typeof input.title === "string" ? { title: input.title } : {}),
        ...(typeof input.farewell === "string" ? { farewell: input.farewell } : {}),
      })); return;
    }
    if (method === "POST" && url.pathname === "/api/kernel/conversation-context") {
      if (!options.nativeToolToken) throw new HttpFailure(404, "Native tools are unavailable");
      authenticate(request, options.nativeToolToken);
      const input = await body(request);
      if (input.operation !== "list" && input.operation !== "read") throw new HttpFailure(400, "Invalid context operation");
      json(response, 200, options.service.context.invoke({
        agentId: string(input.agentId, "agentId"), sessionKey: string(input.sessionKey, "sessionKey"),
        runId: string(input.runId, "runId"), operation: input.operation,
        ...(input.conversationId !== undefined ? { conversationId: string(input.conversationId, "conversationId") } : {}),
        ...(input.before !== undefined ? { before: string(input.before, "before") } : {}),
        ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
      }));
      return;
    }
    if (method === "POST" && url.pathname === "/api/kernel/files") {
      if (!options.nativeToolToken || !options.service.files) throw new HttpFailure(404, "Native files are unavailable");
      authenticate(request, options.nativeToolToken);
      const input = await body(request);
      const artifact = await options.service.files.deliver({
        agentId: string(input.agentId, "agentId"), sessionKey: string(input.sessionKey, "sessionKey"),
        runId: string(input.runId, "runId"), toolCallId: string(input.toolCallId, "toolCallId"),
        relativePath: string(input.relativePath, "relativePath"),
        ...(input.name !== undefined ? { name: string(input.name, "name") } : {}),
        ...(input.mediaType !== undefined ? { mediaType: string(input.mediaType, "mediaType") } : {}),
      });
      json(response, 200, { id: artifact.id, name: artifact.name, bytes: artifact.bytes, digest: artifact.digest });
      return;
    }
    if (method === "POST" && url.pathname === "/api/kernel/revise") {
      if (!options.nativeToolToken || !options.service.files) throw new HttpFailure(404, "Native documents are unavailable");
      authenticate(request, options.nativeToolToken);
      const input = await body(request);
      const result = await options.service.files.revise({
        agentId: string(input.agentId, "agentId"), sessionKey: string(input.sessionKey, "sessionKey"),
        runId: string(input.runId, "runId"), toolCallId: string(input.toolCallId, "toolCallId"),
        relativePath: string(input.relativePath, "relativePath"),
        anchor: string(input.anchor, "anchor"),
        replacement: typeof input.replacement === "string" ? input.replacement : string(input.replacement, "replacement"),
        ...(input.expectedDigest !== undefined ? { expectedDigest: string(input.expectedDigest, "expectedDigest") } : {}),
        ...(input.name !== undefined ? { name: string(input.name, "name") } : {}),
      });
      json(response, 200, {
        id: result.artifact.id, name: result.artifact.name, bytes: result.artifact.bytes,
        digest: result.artifact.digest,
        passage: {
          start: result.passage.start, end: result.passage.end,
          before: result.passage.before, after: result.passage.after,
          removed: result.passage.removed, inserted: result.passage.inserted,
        },
        source: result.source,
      });
      return;
    }
    if (method === "POST" && url.pathname === "/api/kernel/private-report") {
      if (!options.nativeToolToken) throw new HttpFailure(404, "Native tools are unavailable");
      authenticate(request, options.nativeToolToken);
      const input = await body(request);
      json(response, 200, options.service.reportPrivately({
        agentId: string(input.agentId, "agentId"), sessionKey: string(input.sessionKey, "sessionKey"),
        runId: string(input.runId, "runId"),
      }));
      return;
    }
    if (method === "POST" && url.pathname === "/api/kernel/group-assignments") {
      if (!options.nativeToolToken) throw new HttpFailure(404, "Native tools are unavailable");
      authenticate(request, options.nativeToolToken);
      const input = await body(request);
      if (!Array.isArray(input.assignments) || !input.assignments.every((item) =>
        item && typeof item === "object" && typeof item.botId === "string" && typeof item.message === "string")) {
        throw new HttpFailure(400, "Expected group assignments");
      }
      const receipt = await options.service.assignGroup({
        agentId: string(input.agentId, "agentId"), sessionKey: string(input.sessionKey, "sessionKey"),
        runId: string(input.runId, "runId"), toolCallId: string(input.toolCallId, "toolCallId"),
        assignments: input.assignments as GroupAssignment[],
      });
      json(response, 202, { outcomes: receipt.outcomes.map((outcome) => ({
        botId: outcome.botId, taskId: outcome.task.id, status: outcome.task.status,
        accepted: outcome.accepted, ...(outcome.error ? { error: outcome.error } : {}),
      })) });
      return;
    }
    authenticate(request, options.token);
    if (method === "POST" && url.pathname === "/api/file-batches") {
      const input = await body(request);
      if (!Array.isArray(input.attachmentIds) || !input.attachmentIds.every((id) => typeof id === "string")) {
        throw new HttpFailure(400, "Select attachments");
      }
      json(response, 202, await options.service.submitFileBatch({
        id: string(input.id, "id"), botId: string(input.botId, "botId"),
        conversationId: string(input.conversationId, "conversationId"),
        instruction: string(input.instruction, "instruction"), attachmentIds: input.attachmentIds as string[],
      }));
      return;
    }
    const retryBatch = /^\/api\/file-batches\/([^/]+)\/retry$/.exec(url.pathname);
    if (method === "POST" && retryBatch) {
      const input = await body(request);
      json(response, 202, await options.service.retryFileBatch(decodeURIComponent(retryBatch[1]), string(input.retryId, "retryId")));
      return;
    }
    if (url.pathname === "/api/context-shares") {
      if (method === "GET") {
        const source = string(url.searchParams.get("sourceConversationId"), "sourceConversationId");
        if (!options.service.store.get("conversations", source)) throw new HttpFailure(404, "Unknown conversation");
        json(response, 200, { shares: options.service.store.list<ContextShare>("contextShares")
          .filter((share) => share.sourceConversationId === source && !share.revokedAt) });
        return;
      }
      if (method === "POST") {
        const input = await body(request);
        if (!Array.isArray(input.messageIds) || !input.messageIds.every((id) => typeof id === "string")) {
          throw new HttpFailure(400, "Select messages to share");
        }
        const destination = options.service.store.get<Conversation>("conversations", string(input.destinationConversationId, "destinationConversationId"));
        if (destination?.kind !== "group") throw new HttpFailure(400, "Select a group");
        json(response, 201, options.service.context.share({
          id: string(input.id, "id"), sourceConversationId: string(input.sourceConversationId, "sourceConversationId"),
          destinationConversationId: destination.id, messageIds: input.messageIds as string[],
        }));
        return;
      }
    }
    const revokeShare = /^\/api\/context-shares\/([^/]+)\/revoke$/.exec(url.pathname);
    if (method === "POST" && revokeShare) {
      json(response, 200, options.service.context.revoke(decodeURIComponent(revokeShare[1]))); return;
    }
    if (url.pathname === "/api/routines" && (method === "GET" || method === "POST")) {
      if (!options.service.routines) throw new HttpFailure(503, "Scheduling is unavailable");
      if (method === "GET") {
        json(response, 200, { routines: options.service.routines.list() }); return;
      }
      const input = await body(request);
      json(response, 201, await options.service.routines.create({
        id: string(input.id, "id"), botId: string(input.botId, "botId"),
        conversationId: string(input.conversationId, "conversationId"), name: string(input.name, "name"),
        message: string(input.message, "message"), schedule: routineSchedule(input.schedule),
      }));
      return;
    }
    const routine = /^\/api\/routines\/([^/]+)\/(access|history|refresh|update|run|remove)$/.exec(url.pathname);
    if (routine) {
      if (!options.service.routines) throw new HttpFailure(503, "Scheduling is unavailable");
      const managedAudit = systemSettings.read().routineId;
      const managedExclusive = options.service.store.list<{id: string; routineId?: string}>("settings", -1).filter(x=>x.id.startsWith("exclusive-capability-audit:")).some(x=>x.routineId === decodeURIComponent(routine[1]!));
      if (method === "POST" && (decodeURIComponent(routine[1]!) === managedAudit || managedExclusive) && ["access", "update", "remove"].includes(routine[2]!)) {
        throw new HttpFailure(400, "请在对应高级设置中调整审计；审计指令不可修改");
      }
      const id = decodeURIComponent(routine[1]);
      if (method === "POST" && routine[2] === "update") {
        const input = await body(request);
        json(response, 200, await options.service.routines.update(id, string(input.revision, "revision"), {
          name: string(input.name, "name"), message: string(input.message, "message"),
          schedule: routineSchedule(input.schedule),
        }));
        return;
      }
      if (method === "GET" && routine[2] === "history") {
        const store = options.service.store;
        const tasks = store.list<Task>("tasks", -1);
        const entries = options.service.routines.receipts(id).map((entry) => {
          // cron.run's request id differs from the agent run id. Reuse the
          // scheduled task's exact native occurrence binding to locate its reply.
          const owners = tasks.filter((task) =>
            task.routine?.id === entry.routineId && task.routine.jobId === entry.jobId &&
            task.botId === entry.botId && task.reportConversationId === entry.conversationId &&
            (task.routine.runId === entry.runId || entry.startedAt !== undefined &&
              task.routine.occurrenceId === routineExecutionId(entry.jobId, entry.startedAt)) &&
            (entry.sessionId === undefined || task.routine.sessionId === entry.sessionId));
          const task = owners.length === 1 ? owners[0] : undefined;
          const message = task && entry.status === "ok" && entry.completion === "succeeded"
            ? store.messages(entry.conversationId).find((message) =>
                message.taskId === task.id && message.runId === task.routine!.runId &&
                message.botId === entry.botId && message.role === "assistant" && message.final)
            : undefined;
          return { ...entry, messageId: message?.id ?? null };
        });
        json(response, 200, { entries }); return;
      }
      if (method === "POST" && routine[2] === "refresh") {
        await options.service.routines.refresh(id);
        json(response, 200, options.service.routines.get(id)); return;
      }
      if (method === "POST" && routine[2] === "access") {
        const input = await body(request);
        if (typeof input.enabled !== "boolean") throw new HttpFailure(400, "Expected enabled state");
        json(response, 200, await options.service.routines.setEnabled(id, input.enabled, string(input.revision, "revision")));
        return;
      }
      if (method === "POST" && routine[2] === "run") {
        const input = await body(request);
        json(response, 200, await options.service.routines.testRun(id, string(input.revision, "revision")));
        return;
      }
      if (method === "POST" && routine[2] === "remove") {
        const input = await body(request);
        json(response, 200, await options.service.routines.remove(id, string(input.revision, "revision")));
        return;
      }
    }
    if (method === "GET" && url.pathname === "/api/migrations") {
      if (!options.migrations) throw new HttpFailure(503, "Migration is unavailable");
      json(response, 200, { migrations: options.migrations.list() }); return;
    }
    if (method === "POST" && url.pathname === "/api/migrations/preview") {
      if (!options.migrations) throw new HttpFailure(503, "Migration is unavailable");
      const input = await body(request);
      json(response, 201, await options.migrations.preview({
        source: string(input.source, "source"), name: string(input.name, "name"),
        ...(input.description !== undefined ? { description: string(input.description, "description") } : {}),
        ...(input.identity !== undefined ? { identity: string(input.identity, "identity") } : {}),
      }));
      return;
    }
    if (method === "POST" && url.pathname === "/api/migrations/bundle-preview") {
      if (!options.migrations) throw new HttpFailure(503, "Migration is unavailable");
      const input = await body(request);
      json(response, 201, { migrations: await options.migrations.previewBundle(string(input.path, "path")) });
      return;
    }
    const migration = /^\/api\/migrations\/([^/]+)(\/apply)?$/.exec(url.pathname);
    if (migration && (method === "GET" && !migration[2] || method === "POST" && migration[2])) {
      if (!options.migrations) throw new HttpFailure(503, "Migration is unavailable");
      if (!migration[2]) { json(response, 200, options.migrations.get(migration[1])); return; }
      const input = await body(request);
      if (input.acknowledgeExclusions !== undefined && typeof input.acknowledgeExclusions !== "boolean") {
        throw new HttpFailure(400, "Expected exclusion acknowledgment");
      }
      json(response, 200, await options.migrations.apply(migration[1], input.acknowledgeExclusions === true));
      return;
    }
    if (method === "POST" && url.pathname === "/api/marketplace/preview") {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      const input = await body(request);
      json(response, 201, await options.marketplace.preview({
        repository: string(input.repository, "repository"),
        ...(input.ref !== undefined ? { ref: string(input.ref, "ref") } : {}),
        ...(input.path !== undefined ? { path: string(input.path, "path") } : {}),
      })); return;
    }
    const packagePreview = /^\/api\/marketplace\/previews\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && packagePreview) {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      json(response, 200, options.marketplace.get(packagePreview[1])); return;
    }
    if (method === "POST" && url.pathname === "/api/marketplace/export") {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      json(response, 200, options.marketplace.export(await body(request))); return;
    }
    if (method === "POST" && url.pathname === "/api/marketplace/share/files") {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      const input = await body(request);
      json(response, 200, await options.marketplace.shareableMethods(string(input.botId, "botId"))); return;
    }
    if (method === "POST" && url.pathname === "/api/marketplace/share/preview") {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      const input = await body(request);
      if (!Array.isArray(input.paths) || input.paths.some((path) => typeof path !== "string")) {
        throw new HttpFailure(400, "Select method files");
      }
      json(response, 201, await options.marketplace.prepareShare({
        botId: string(input.botId, "botId"), metadata: input.metadata, paths: input.paths as string[],
        ...(input.identity !== undefined ? { identity: string(input.identity, "identity") } : {}),
      })); return;
    }
    if (method === "POST" && url.pathname === "/api/marketplace/share/export") {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      const input = await body(request);
      json(response, 200, options.marketplace.exportShare(string(input.id, "id"), string(input.digest, "digest"))); return;
    }
    if (method === "POST" && url.pathname === "/api/marketplace/share/upload") {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      const input = await body(request);
      json(response, 200, options.marketplace.prepareUpload({
        id: string(input.id, "id"), digest: string(input.digest, "digest"),
        repository: string(input.repository, "repository"), ref: string(input.ref, "ref"),
      })); return;
    }
    const packageShare = /^\/api\/marketplace\/shares\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && packageShare) {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      json(response, 200, options.marketplace.share(packageShare[1])); return;
    }
    if (method === "GET" && url.pathname === "/api/marketplace/catalogs") {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      json(response, 200, options.marketplace.catalogs()); return;
    }
    if (method === "POST" && url.pathname === "/api/marketplace/catalog/preview") {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      const input = await body(request);
      json(response, 201, await options.marketplace.readCatalog({
        repository: string(input.repository, "repository"),
        ...(input.ref !== undefined ? { ref: string(input.ref, "ref") } : {}),
        ...(input.path !== undefined ? { path: string(input.path, "path") } : {}),
      })); return;
    }
    if (method === "POST" && url.pathname === "/api/marketplace/catalog/entry") {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      const input = await body(request);
      json(response, 201, await options.marketplace.previewCatalogEntry(
        string(input.catalogId, "catalogId"), string(input.entryId, "entryId"),
      )); return;
    }
    if (method === "POST" && url.pathname === "/api/marketplace/catalog/submission") {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      const input = await body(request);
      json(response, 201, options.marketplace.prepareSubmission({
        catalogId: string(input.catalogId, "catalogId"), previewId: string(input.previewId, "previewId"),
        digest: string(input.digest, "digest"), tags: input.tags,
      })); return;
    }
    if (method === "GET" && url.pathname === "/api/marketplace/submissions") {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      json(response, 200, options.marketplace.submissions()); return;
    }
    if (method === "GET" && url.pathname === "/api/marketplace/installations") {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      json(response, 200, options.marketplace.installations()); return;
    }
    if (method === "POST" && url.pathname === "/api/marketplace/access") {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      const input = await body(request);
      if (typeof input.enabled !== "boolean") throw new HttpFailure(400, "Expected package access state");
      json(response, 200, await options.marketplace.setEnabled(string(input.id, "id"), input.enabled)); return;
    }
    if (method === "GET" && url.pathname === "/api/marketplace/updates") {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      json(response, 200, options.marketplace.updates()); return;
    }
    if (method === "POST" && url.pathname === "/api/marketplace/update") {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      const input = await body(request);
      if (typeof input.replaceIdentity !== "boolean") throw new HttpFailure(400, "Choose whether to update public identity");
      json(response, 200, await options.marketplace.update({
        id: string(input.id, "id"), expectedDigest: string(input.expectedDigest, "expectedDigest"),
        previewId: string(input.previewId, "previewId"), digest: string(input.digest, "digest"),
        replaceIdentity: input.replaceIdentity,
      })); return;
    }
    if (method === "POST" && url.pathname === "/api/marketplace/install") {
      if (!options.marketplace) throw new HttpFailure(503, "Marketplace is unavailable");
      const input = await body(request);
      json(response, 200, await options.marketplace.install({
        previewId: string(input.previewId, "previewId"), digest: string(input.digest, "digest"),
        ...(input.botId !== undefined ? { botId: string(input.botId, "botId") } : {}),
      })); return;
    }
    const store = options.service.store;
    const notification = /^\/api\/notifications\/([^/]+)\/read$/.exec(url.pathname);
    const voiceOperation = /^\/api\/voice\/rpc\/([a-zA-Z]+)$/.exec(url.pathname);
    const callOperation = /^\/api\/calls\/(endCall|answerCall|declineCall)$/.exec(url.pathname);
    if (method === "POST" && callOperation) {
      json(response, 200, await calls.rpc(callOperation[1], await body(request))); return;
    }
    if (method === "POST" && voiceOperation) {
      json(response, 200, await voice.rpc(voiceOperation[1], await body(request))); return;
    }
    if (method === "POST" && url.pathname === "/api/voice/speak-stream") {
      json(response, 409, { error: "Use complete audio clips" }); return;
    }
    if (method === "POST" && url.pathname === "/api/voice/speak") {
      const clip = await voice.synthesize({ ...await body(request), spaceId: request.headers["x-livingbot-space-id"] ?? "local" });
      response.writeHead(200, { "content-type": clip.mimeType, "content-length": clip.bytes.length });
      response.end(Buffer.from(clip.bytes)); return;
    }
    if (method === "POST" && url.pathname === "/api/voice/transcribe") {
      json(response, 200, await voice.transcribe({ ...await body(request, 12 * 1024 * 1024),
        spaceId: request.headers["x-livingbot-space-id"] ?? "local" })); return;
    }
    if (method === "POST" && notification) {
      json(response, 200, store.readNotification(decodeURIComponent(notification[1]))); return;
    }
    const upload = /^\/api\/conversations\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname);
    if (method === "POST" && upload) {
      if (!options.service.files) throw new HttpFailure(503, "File storage is unavailable");
      const botId = string(url.searchParams.get("botId"), "botId");
      store.engineSessionKey(upload[1], botId);
      const artifact = await options.service.files.attach({
        id: upload[2], botId, conversationId: upload[1],
        name: string(url.searchParams.get("name"), "name"),
        mediaType: url.searchParams.get("mediaType") || "application/octet-stream",
        bytes: await fileBody(request),
      });
      const { path: _path, ...visible } = artifact;
      json(response, 201, visible); return;
    }
    // ---- Daily-experience endpoints (read state, reactions, search, usage, preferences) ----
    const readState = /^\/api\/conversations\/([^/]+)\/read-state$/.exec(url.pathname);
    if (readState && (method === "GET" || method === "POST")) {
      const conversationId = decodeURIComponent(readState[1]!);
      if (!store.get("conversations", conversationId)) throw new HttpFailure(404, "Unknown conversation");
      if (method === "GET") {
        json(response, 200, store.readState(conversationId)); return;
      }
      const input = await body(request);
      // Public callers acknowledge a read at the conversation's current boundary; the
      // stored boundary is never allowed to run ahead of the messages that exist.
      if (input.unread === true) {
        store.markUnread(conversationId, typeof input.messageId === "string" ? input.messageId : undefined);
        json(response, 200, { ok: true, ...store.readState(conversationId) }); return;
      }
      const result = store.markRead(conversationId);
      json(response, 200, { ok: true, ...result, ...store.readState(conversationId) }); return;
    }
    const reactions = /^\/api\/messages\/([^/]+)\/reactions$/.exec(url.pathname);
    if (reactions && method === "POST") {
      const messageId = decodeURIComponent(reactions[1]!);
      const input = await body(request);
      const reaction = string(input.reaction ?? input.emoji, "reaction").slice(0, 16);
      const message = store.get<Message>("messages", messageId);
      if (!message) throw new HttpFailure(404, "Unknown message");
      const clientNonce = typeof input.clientNonce === "string" ? input.clientNonce : randomUUID();
      const id = `reaction:${createHash("sha256")
        .update(JSON.stringify([message.conversationId, messageId, clientNonce])).digest("hex").slice(0, 32)}`;
      if (store.get<{ id: string }>("reactions", id)) {
        json(response, 200, { ok: true, messageId, reaction }); return;
      }
      // The product shows a reaction as an emoji reply under its target, so the row
      // and the transcript message are written together; a retry finds the row above.
      const now = Date.now();
      store.put("reactions", {
        id, conversationId: message.conversationId, messageId, reaction,
        clientNonce, createdAt: now,
      });
      store.put("messages", {
        id: `reaction-message:${id.slice("reaction:".length)}`,
        conversationId: message.conversationId,
        ...(message.botId ? { botId: message.botId } : {}),
        role: "user" as const,
        blocks: [{ id: `${id}:text`, kind: "text" as const, text: reaction }],
        final: true, createdAt: now, updatedAt: now, replyToMessageId: messageId,
      });
      json(response, 200, { ok: true, messageId, reaction });
      return;
    }
    if (method === "GET" && url.pathname === "/api/search") {
      const query = (url.searchParams.get("q") ?? "").trim();
      const conversationId = url.searchParams.get("conversationId");
      const before = Number(url.searchParams.get("before") ?? Number.NaN);
      if (!query) { json(response, 200, { hits: [] }); return; }
      // Search the whole journal in message order, then page backwards from `before`.
      const conversations = store.list<Conversation>("conversations", -1);
      const bots = new Map(store.list<Bot>("bots", -1).map((bot) => [bot.id, bot]));
      const rows = store.list<Message>("messages", -1)
        .filter((message) => !conversationId || message.conversationId === conversationId)
        .filter((message) => message.blocks?.some((block) => block.kind === "text" && (block.text ?? "").includes(query)))
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
      const ordered = rows.flatMap((message) => {
        const conversation = conversations.find((entry) => entry.id === message.conversationId);
        if (!conversation) return [];
        const history = store.messages(message.conversationId);
        return [{
          messageId: message.id, conversationId: message.conversationId, kind: conversation.kind,
          role: message.role, createdAt: message.createdAt, seq: history.findIndex((item) => item.id === message.id),
          botId: conversation.kind === "private" ? conversation.botIds[0] : undefined,
          botName: conversation.kind === "private" ? bots.get(conversation.botIds[0] ?? "")?.name : undefined,
          groupId: conversation.kind === "group" ? conversation.id : undefined,
          groupName: conversation.kind === "group" ? conversation.title : undefined,
          title: conversation.kind === "group" ? conversation.title : (bots.get(conversation.botIds[0] ?? "")?.name ?? conversation.title),
          text: message.blocks.flatMap((block) => (block.kind === "text" ? [block.text] : []))
            .join("\n").slice(0, 400),
        }];
      });
      const page = Number.isFinite(before) ? ordered.filter((hit) => hit.seq < before) : ordered;
      // The product caps a search page at 25 hits.
      json(response, 200, { hits: page.slice(0, 25), nextBefore: page.length > 25 ? page[24]!.seq : null });
      return;
    }
    if (url.pathname === "/api/memory-settings" && (method === "GET" || method === "POST")) {
      json(response, 200, method === "GET" ? await memorySettings.read() : await memorySettings.save(await body(request) as unknown as MemoryPreferencesInput)); return;
    }
    const exclusiveAudit = /^\/api\/bots\/([^/]+)\/capability-audit$/.exec(url.pathname);
    if (exclusiveAudit && (method === "GET" || method === "POST")) {
      const id = decodeURIComponent(exclusiveAudit[1]!);
      json(response, 200, method === "GET" ? systemSettings.read(id) : await systemSettings.save(await body(request) as unknown as AuditSettingsInput, id)); return;
    }
    if (url.pathname === "/api/abilities/addition" && method === "POST") {
      json(response, 200, await systemSettings.startAddition()); return;
    }
    const exclusiveSkills = /^\/api\/bots\/([^/]+)\/skills(?:\/document)?$/.exec(url.pathname);
    if (exclusiveSkills && method === "GET") {
      const bot = store.get<Bot>("bots", decodeURIComponent(exclusiveSkills[1]!));
      if (!bot || bot.archivedAt) throw new HttpFailure(404, "Bot 不可用");
      json(response, 200, url.pathname.endsWith("/document") ? await skillDocuments.read(bot.agentId, string(url.searchParams.get("key"), "key"), url.searchParams.get("path") ?? "SKILL.md") : await skillDocuments.list(bot.agentId)); return;
    }
    const configureAbility = /^\/api\/abilities\/([^/]+)\/configure$/.exec(url.pathname);
    if (configureAbility && method === "POST") {
      json(response, 200, await systemSettings.startConfiguration(decodeURIComponent(configureAbility[1]!))); return;
    }
    const abilityDocument = /^\/api\/abilities\/([^/]+)\/document$/.exec(url.pathname);
    if (abilityDocument && method === "GET") {
      if (!options.service.abilities) throw new HttpFailure(503, "能力服务不可用");
      const item = (await options.service.abilities.listShared()).find(x => x.id === decodeURIComponent(abilityDocument[1]!));
      const native = item?.configuration?.native as { nativeKind?: string; nativeSource?: string; skillKey?: string; nativeName?: string } | undefined;
      if (!item || native?.nativeKind !== "skill") { json(response, 200, null); return; }
      const cfg = await options.service.kernel.request<{config: { agents?: { defaults?: { systemAgent?: {agentId?: string} } } } }>("config.get", {});
      const agentId = cfg.config.agents?.defaults?.systemAgent?.agentId ?? store.list<Bot>("bots", -1).find(x=>!x.archivedAt)?.agentId;
      if (!agentId) throw new HttpFailure(503, "没有可用 Bot");
      json(response, 200, await skillDocuments.read(agentId, `${native.nativeSource}:${native.skillKey || native.nativeName}`, url.searchParams.get("path") ?? "SKILL.md", true)); return;
    }
    if (url.pathname === "/api/system/advanced" && (method === "GET" || method === "POST")) {
      json(response, 200, method === "GET" ? systemSettings.read() : await systemSettings.save(await body(request) as unknown as AuditSettingsInput)); return;
    }
    if (url.pathname === "/api/system/administrator" && method === "POST") {
      json(response, 200, await systemSettings.ensureAdmin()); return;
    }
    if (method === "GET" && url.pathname === "/api/preferences") {
      json(response, 200, store.get<Record<string, unknown>>("settings", "preferences") ?? { id: "preferences" });
      return;
    }
    if (method === "POST" && url.pathname === "/api/preferences") {
      const input = await body(request);
      const current = store.get<Record<string, unknown>>("settings", "preferences") ?? { id: "preferences" };
      json(response, 200, store.put("settings", { ...current, ...input, id: "preferences" }));
      return;
    }
    if (url.pathname === "/api/approval-settings" || url.pathname.startsWith("/api/approval-rules")) {
      const scope = url.searchParams.get("scope");
      if (scope !== null && scope !== "account" && scope !== "space") {
        throw new HttpFailure(400, "审批设置范围无效");
      }
      if (scope === "space") {
        throw new HttpFailure(400, "本机审批统一管理，请在账户设置中修改");
      }
      if (method === "GET" && url.pathname === "/api/approval-settings") {
        json(response, 200, await approvalSettings.read()); return;
      }
      if (method === "GET" && url.pathname === "/api/approval-rules") {
        json(response, 200, await approvalSettings.listRules()); return;
      }
      if (method === "POST" && url.pathname === "/api/approval-settings") {
        const input = await body(request);
        if (input.scope !== undefined && input.scope !== "account") {
          throw new HttpFailure(400, "本机审批统一管理，请在账户设置中修改");
        }
        const mode = input.mode ?? (input.skipApprovals === true ? "never"
          : input.enabled === true ? "auto"
          : input.enabled === false || input.skipApprovals === false ? "ask" : undefined);
        if (mode !== "never" && mode !== "ask" && mode !== "auto") throw new HttpFailure(400, "审批模式无效");
        if (store.hasUnfinishedWork()) {
          throw new HttpFailure(409, "请等待当前工作结束后修改审批模式；等待审批的操作仍可在对话中允许或拒绝");
        }
        json(response, 200, await approvalSettings.setMode(mode)); return;
      }
      if (method === "POST" && url.pathname === "/api/approval-rules/remove") {
        const input = await body(request);
        if (input.scope !== undefined && input.scope !== "account") throw new HttpFailure(400, "审批设置范围无效");
        json(response, 200, await approvalSettings.removeRule(string(input.id, "id"))); return;
      }
      throw new HttpFailure(400, "原生授权可在此撤销，新增授权请通过执行时的审批卡片确认");
    }
    if (method === "GET" && url.pathname === "/api/usage") {
      const botId = url.searchParams.get("botId") ?? "";
      const conversationId = url.searchParams.get("conversationId") ?? undefined;
      const spaceId = url.searchParams.get("spaceId");
      if (!options.service.kernel) throw new HttpFailure(503, "Kernel unavailable");
      if (spaceId !== null) {
        if (botId || conversationId) throw new HttpFailure(400, "Choose a workspace or a conversation");
        if (!store.listSpaces().some((space) => space.id === spaceId))
          throw new HttpFailure(404, "Workspace not found");
        const conversations = store.list<Conversation>("conversations", -1)
          .filter((entry) => (entry.spaceId ?? "local") === spaceId);
        const conversationIds = new Set(conversations.map((entry) => entry.id));
        const tasks = new Map(store.list<Task>("tasks", -1)
          .filter((task) => conversationIds.has(task.conversationId)).map((task) => [task.id, task]));
        const runs = store.list<Run>("runs", -1).filter((run) => tasks.has(run.taskId));
        // Archived Bots retain their recorded session keys; the active-key helper
        // intentionally refuses to start work for them.
        const keys = new Set(runs.map((run) => run.sessionKey));
        for (const entry of conversations) for (const id of entry.botIds) {
          const owner = store.get<Bot>("bots", id);
          if (owner && owner.archivedAt === undefined) keys.add(store.engineSessionKey(entry.id, id));
        }
        const report = keys.size
          ? await options.service.kernel.request<{ sessions: { key?: string }[] }>("sessions.usage", {})
          : { sessions: [] };
        json(response, 200, {
          sessions: report.sessions.filter((session) => session.key !== undefined && keys.has(session.key)),
          runs: runs.length,
        });
        return;
      }
      if (conversationId && !botId) throw new HttpFailure(400, "botId is required");
      const conversation = conversationId ? store.get<Conversation>("conversations", conversationId) : undefined;
      const memberIds = conversation?.kind === "group" ? conversation.botIds : [botId];
      const keys = conversationId ? memberIds.map((id) => store.engineSessionKey(conversationId, id)) : [];
      // The detail projection (no `projection` param) reports each session's tokens,
      // calls and latency; `overview` only totals them and cannot show the last run.
      const reports = await Promise.all((keys.length ? keys : [undefined]).map((key) =>
        options.service.kernel.request<{ sessions: unknown[] }>("sessions.usage", key ? { key } : {})));
      // Like the 1.0 footer, "Latest" describes the latest reported reading.
      // A newly running turn must not erase the preceding turn's usage.
      const runs = conversationId ? conversationUsageRuns(store, conversationId) : [];
      let latestRun = runs[0] ?? null;
      const latestCalls: Record<string, unknown>[] = [];
      type UsageHistory = {
        messages: { role: string; timestamp: number; usage?: Record<string, unknown> }[];
        olderCursor?: string;
      };
      const pages = new Map<string, UsageHistory>();
      for (const run of runs) {
        const sessionKey = run.sessionKey;
        // chat.history retains raw per-call usage; timeseries combines old calls
        // into at most 200 buckets, which cannot attribute one task accurately.
        let cursor: string | undefined;
        do {
          const pageKey = JSON.stringify([sessionKey, cursor]);
          let history = pages.get(pageKey);
          if (!history) {
            history = await options.service.kernel.request<UsageHistory>(
              "chat.history", { sessionKey, ...(cursor ? { cursor } : {}) });
            pages.set(pageKey, history);
          }
          for (const message of history.messages) {
            const usage = message.usage;
            const report = usage?.usageReport;
            const available = report && typeof report === "object" &&
              "state" in report && report.state === "available";
            const placeholder = usage && !available &&
              ["input", "output", "totalTokens", "cacheRead", "cacheWrite"]
                .every((field) => usage[field] === 0);
            if (message.role === "assistant" && message.usage &&
                !placeholder &&
                message.timestamp >= run.startedAt &&
                (run.completedAt === null || message.timestamp <= run.completedAt)) {
              latestCalls.push(message.usage);
            }
          }
          cursor = history.olderCursor;
          if (!history.messages.length || history.messages[0]!.timestamp < run.startedAt) break;
        } while (cursor);
        if (latestCalls.length) {
          latestRun = run;
          break;
        }
      }
      json(response, 200, {
        sessions: reports.flatMap((report) => report.sessions), latestCalls, latestRun,
        latestModelRequestDurationMs: latestRun ? modelRequestDuration(store, latestRun.id) : null,
      });
      return;
    }
    const taskRead = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && taskRead) {
      const id = decodeURIComponent(taskRead[1]!);
      const task = store.get<Task>("tasks", id);
      if (!task) throw new HttpFailure(404, "Task not found");
      // The native run identity lives with the run record, not the product task.
      const run = store.find<Run>("runs", "taskId", id).at(-1) ?? null;
      json(response, 200, { task, run }); return;
    }
    if (method === "POST" && url.pathname === "/api/bots") {
      if (!options.botWorkspaces || !options.agentRegistration) throw new HttpFailure(503, "Bot registration is unavailable");
      const input = await body(request);
      const name = string(input.name, "name").trim();
      if (!name || name.length > 80) throw new HttpFailure(400, "请输入 1–80 字的 Bot 名称");
      const spaceId = typeof input.spaceId === "string" ? input.spaceId : "local";
      const existing = typeof input.spawnKey === "string"
        ? store.list<Bot>("bots", -1).find((bot) => bot.spawnKey === input.spawnKey &&
          (bot.spaceId ?? "local") === spaceId) : undefined;
      if (existing) { await startBotIntro(existing); json(response, 200, existing); return; }
      const id = typeof input.id === "string" && /^[a-zA-Z0-9-]{16,80}$/.test(input.id) ? input.id : randomUUID();
      if (store.get<Bot>("bots", id)) throw new HttpFailure(409, "Bot identity already exists");
      const agentId = `bot-${id.replaceAll("-", "").toLowerCase()}`;
      const identity = typeof input.identity === "string" ? input.identity : "";
      if (identity.length > 20_000) throw new HttpFailure(400, "Bot instructions exceed the limit");
      const workspace = await options.botWorkspaces.initialize(agentId);
      await options.agentRegistration.ensure({ agentId, workspace });
      if (identity) await options.service.kernel.request("agents.files.set", { agentId, name: "SOUL.md", content: identity });
      const created = store.createBot({
        id, agentId, name, identity,
        spaceId,
        description: typeof input.description === "string" ? input.description : "",
        color: typeof input.color === "string" ? input.color : "teal",
        ...(typeof input.avatarSet === "string" ? { avatarSet: input.avatarSet } : {}),
        ...(typeof input.spawnKey === "string" ? { spawnKey: input.spawnKey } : {}),
        notifyOnFinish: input.notifyOnFinish !== false,
      });
      await startBotIntro(created);
      json(response, 201, created);
      return;
    }
    const botRemove = /^\/api\/bots\/([^/]+)\/remove$/.exec(url.pathname);
    if (method === "POST" && botRemove) {
      const input = await body(request);
      if (typeof input.deleteMemories !== "boolean") throw new HttpFailure(400, "请选择是否删除记忆");
      json(response, 200, await botRemoval.remove(decodeURIComponent(botRemove[1]), input.deleteMemories)); return;
    }
    const botArchive = /^\/api\/bots\/([^/]+)\/(archive|restore)$/.exec(url.pathname);
    if (method === "POST" && botArchive) {
      const id = decodeURIComponent(botArchive[1]);
      if (store.get<{completed?: boolean}>("settings", `bot-removal:${id}`)?.completed === false) throw new HttpFailure(409, "Bot 删除尚未完成，请重试删除");
      if (store.get<Bot>("bots", id)?.removedAt) throw new HttpFailure(409, "Bot 已删除，恢复清单位于废纸篓");
      if (botArchive[2] === "archive") {
        for (const task of store.list<Task>("tasks", -1).filter((task) => task.botId === id &&
          !["completed", "failed", "cancelled"].includes(task.status))) await options.service.cancel(task.id);
      }
      json(response, 200, store.updateBot(id, { archivedAt: botArchive[2] === "archive" ? Date.now() : null }));
      return;
    }
    const botMeta = /^\/api\/bots\/([^/]+)$/.exec(url.pathname);
    if (botMeta && (method === "PATCH" || method === "GET")) {
      const id = decodeURIComponent(botMeta[1]!);
      if (method === "GET") {
        const bot = store.get<Bot>("bots", id);
        if (!bot) throw new HttpFailure(404, "Bot not found");
        json(response, 200, bot); return;
      }
      const patch = await body(request);
      const current = store.get<Bot>("bots", id);
      if (!current || current.removedAt) throw new HttpFailure(404, "Bot not found");
      if (patch.modelProvider != null || patch.modelId != null || patch.thinkingLevel != null)
        throw new HttpFailure(400, "本机模型由全局设置统一管理");
      if (patch.autoSpeak !== undefined && typeof patch.autoSpeak !== "boolean")
        throw new HttpFailure(400, "autoSpeak must be a boolean");
      if (typeof patch.identity === "string" && patch.identity !== current.identity) {
        if (typeof patch.expectedInstructions === "string" && patch.expectedInstructions !== current.identity)
          throw new HttpFailure(409, "Bot 指令已变化，请重新载入");
        if (patch.identity.length > 20_000) throw new HttpFailure(400, "Bot instructions exceed the limit");
        await options.service.kernel.request("agents.files.set", { agentId: current.agentId, name: "SOUL.md", content: patch.identity });
      }
      json(response, 200, store.updateBot(id, {
        ...(typeof patch.name === "string" ? { name: patch.name } : {}),
        ...(typeof patch.description === "string" ? { description: patch.description } : {}),
        ...(typeof patch.identity === "string" ? { identity: patch.identity } : {}),
        ...(typeof patch.color === "string" ? { color: patch.color } : {}),
        ...(typeof patch.avatarSet === "string" ? { avatarSet: patch.avatarSet }
          : patch.avatarSet === null ? { avatarSet: null } : {}),
        ...(typeof patch.pinned === "boolean" ? { pinned: patch.pinned } : {}),
        ...(typeof patch.notifyOnFinish === "boolean" ? { notifyOnFinish: patch.notifyOnFinish } : {}),
        ...(typeof patch.autoSpeak === "boolean" ? { autoSpeak: patch.autoSpeak } : {}),
        ...(typeof patch.voiceId === "string" && patch.voiceId.length <= 120 ? { voiceId: patch.voiceId }
          : patch.voiceId === null ? { voiceId: null } : {}),
        ...(typeof patch.sectionId === "string" ? { sectionId: patch.sectionId }
          : patch.sectionId === null ? { sectionId: null } : {}),
      })); return;
    }
    if (method === "POST" && url.pathname === "/api/bots/reorder") {
      const input = await body(request);
      const ids = Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === "string") : [];
      if (ids.length !== (input.ids as unknown[] | undefined)?.length) throw new HttpFailure(400, "The order must list Bot identifiers");
      json(response, 200, { bots: store.reorderBots(ids, typeof input.spaceId === "string" ? input.spaceId : undefined) }); return;
    }
    const sectionRoute = /^\/api\/bot-sections(?:\/([^/]+))?$/.exec(url.pathname);
    if (sectionRoute) {
      const id = sectionRoute[1] ? decodeURIComponent(sectionRoute[1]) : undefined;
      if (method === "GET" && !id) {
        const spaceId = url.searchParams.get("spaceId") ?? "local";
        json(response, 200, { sections: store.list<BotSection>("botSections")
          .filter((section) => section.position >= 0 && (section.spaceId ?? "local") === spaceId)
          .sort((left, right) => left.position - right.position) }); return;
      }
      if (method === "POST" && !id) {
        const input = await body(request);
        json(response, 201, store.createSpaceBotSection(
          typeof input.spaceId === "string" ? input.spaceId : "local",
          string(input.name, "name"),
        )); return;
      }
      if (method === "PATCH" && id) {
        const input = await body(request);
        json(response, 200, store.updateBotSection(id, {
          ...(typeof input.name === "string" ? { name: input.name } : {}),
          ...(typeof input.position === "number" ? { position: input.position } : {}),
        })); return;
      }
      if (method === "DELETE" && id) {
        store.deleteBotSection(id);
        json(response, 200, { removed: id }); return;
      }
    }
    const botFiles = /^\/api\/bots\/([^/]+)\/files$/.exec(url.pathname);
    if (method === "GET" && botFiles) {
      if (!options.service.files) throw new HttpFailure(503, "File storage is unavailable");
      json(response, 200, options.service.files.list(decodeURIComponent(botFiles[1]), url.searchParams.get("before") ?? undefined));
      return;
    }
    const workspaceFiles = /^\/api\/bots\/([^/]+)\/workspace-files$/.exec(url.pathname);
    if (method === "GET" && workspaceFiles) {
      if (!options.botWorkspaces) throw new HttpFailure(503, "Workspace files are unavailable");
      const bot = store.get<Bot>("bots", decodeURIComponent(workspaceFiles[1]!));
      if (!bot) throw new HttpFailure(404, "Bot not found");
      json(response, 200, await options.botWorkspaces.listDirectory(
        bot.agentId, url.searchParams.get("path") ?? "",
      ));
      return;
    }
    const loadedContext = /^\/api\/bots\/([^/]+)\/loaded-context$/.exec(url.pathname);
    if (method === "GET" && loadedContext) {
      if (!options.nativeContextPreview) throw new HttpFailure(503, "OpenClaw context preview is unavailable");
      const bot = store.get<Bot>("bots", decodeURIComponent(loadedContext[1]!));
      if (!bot || bot.archivedAt !== undefined) throw new HttpFailure(404, "Bot not found");
      const [nativeContext, scratchpad] = await Promise.all([
        options.nativeContextPreview(bot.agentId),
        Promise.resolve(store.listScratchpad(bot.id).map((item) =>
          [item.title, item.notes].filter(Boolean).join("\n")).join("\n\n")),
      ]);
      json(response, 200, { nativeContext, scratchpad });
      return;
    }
    const workspaceFileAction = /^\/api\/bots\/([^/]+)\/workspace-files\/action$/.exec(url.pathname);
    if (method === "POST" && workspaceFileAction) {
      if (!options.botWorkspaces || !options.service.files) throw new HttpFailure(503, "Workspace files are unavailable");
      const bot = store.get<Bot>("bots", decodeURIComponent(workspaceFileAction[1]!));
      if (!bot) throw new HttpFailure(404, "Bot not found");
      const input = await body(request);
      if (input.action !== "open" && input.action !== "reveal") throw new HttpFailure(400, "Invalid file action");
      await options.service.files.workspaceAction(bot.agentId, string(input.path, "path"), input.action);
      json(response, 200, { ok: true });
      return;
    }
    if (method === "GET" && url.pathname === "/api/files") {
      if (!options.service.files) throw new HttpFailure(503, "File storage is unavailable");
      json(response, 200, options.service.files.listSpace({
        botId: url.searchParams.get("botId") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
      }));
      return;
    }
    const fileAction = /^\/api\/files\/([^/]+)\/(action|trash)$/.exec(url.pathname);
    if (method === "POST" && fileAction) {
      if (!options.service.files) throw new HttpFailure(503, "File storage is unavailable");
      const id = decodeURIComponent(fileAction[1]);
      if (fileAction[2] === "trash") {
        json(response, 200, { ok: true, ...await options.service.files.trash(id) });
      } else {
        const input = await body(request);
        if (input.action !== "open" && input.action !== "reveal") throw new HttpFailure(400, "Invalid file action");
        await options.service.files.action(id, input.action);
        json(response, 200, { ok: true });
      }
      return;
    }
    const download = /^\/api\/files\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && download) {
      if (!options.service.files) throw new HttpFailure(503, "File storage is unavailable");
      if (url.searchParams.get("metadata") === "1") {
        const artifact = store.get<Artifact>("artifacts", decodeURIComponent(download[1]));
        if (!artifact) throw new HttpFailure(404, "File not found");
        const { path: _path, ...metadata } = artifact;
        json(response, 200, metadata); return;
      }
      const { artifact, bytes } = await options.service.files.read(download[1]);
      response.writeHead(200, {
        "content-type": artifact.mediaType, "content-length": bytes.byteLength,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name).replaceAll("'", "%27")}`,
        "content-security-policy": "default-src 'none'; sandbox",
      });
      response.end(bytes); return;
    }
    if (method === "GET" && url.pathname === "/api/snapshot") {
      json(response, 200, { ...store.snapshot(), runs: store.list<Run>("runs", -1), kernel: { phase: options.service.kernel.phase } }); return;
    }
    if (url.pathname === "/api/spaces") {
      if (method === "GET") {
        const spaces = store.listSpaces().map((space) => {
          const bots = store.list<Bot>("bots", -1).filter((bot) => (bot.spaceId ?? "local") === space.id);
          const groups = store.list<Conversation>("conversations", -1)
            .filter((conversation) => conversation.kind === "group" && (conversation.spaceId ?? "local") === space.id);
          return {
            ...space, isDefault: space.id === "local", hasContent: bots.length > 0 || groups.length > 0,
            canRename: space.id !== "local", canDelete: space.id !== "local", botCount: bots.length,
            bots, groups, externalConversations: [],
            botSections: store.list<BotSection>("botSections")
              .filter((section) => section.position >= 0 && (section.spaceId ?? "local") === space.id)
              .sort((a, b) => a.position - b.position),
          };
        });
        json(response, 200, { spaces }); return;
      }
      if (method === "POST") {
        const input = await body(request);
        json(response, 201, store.createSpace(string(input.name, "name"))); return;
      }
    }
    const spaceRoute = /^\/api\/spaces\/([^/]+)$/.exec(url.pathname);
    if (spaceRoute && method === "PATCH") {
      const input = await body(request);
      const updated = store.renameSpace(decodeURIComponent(spaceRoute[1]!), string(input.name, "name"));
      json(response, 200, { id: updated.id, name: updated.name }); return;
    }
    if (spaceRoute && method === "DELETE") {
      const id = decodeURIComponent(spaceRoute[1]!);
      store.removeSpace(id);
      json(response, 200, { ok: true, activeSpaceId: "local" }); return;
    }
    if (url.pathname === "/api/scratchpad" && method === "GET") {
      json(response, 200, store.listScratchpad(url.searchParams.get("botId") ?? "", url.searchParams.get("includeDone") === "1"));
      return;
    }
    if (url.pathname === "/api/scratchpad" && method === "POST") {
      const input = await body(request);
      const title = string(input.title, "title").trim();
      if (!title || title.length > 200) throw new HttpFailure(400, "Invalid to-do title");
      const status = input.status ?? "open";
      if (!["open", "parked", "done"].includes(String(status))) throw new HttpFailure(400, "Invalid to-do status");
      const now = new Date().toISOString();
      const item: ScratchpadItem = {
        id: randomUUID(), botId: string(input.botId, "botId"), title,
        status: status as ScratchpadItem["status"],
        notes: typeof input.notes === "string" ? input.notes.trim().slice(0, 4000) : "",
        createdAt: now, updatedAt: now,
      };
      json(response, 201, store.saveScratchpad(item)); return;
    }
    const scratchpad = /^\/api\/scratchpad\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (scratchpad && method === "PATCH") {
      const input = await body(request);
      const itemId = decodeURIComponent(scratchpad[1]!);
      const current = store.get<ScratchpadItem>("scratchpad", itemId);
      if (!current || current.removedAt) throw new HttpFailure(404, "To-do not found");
      const changes: Partial<Pick<ScratchpadItem, "title" | "status" | "notes">> = {};
      if (input.title !== undefined) {
        const title = string(input.title, "title").trim();
        if (!title || title.length > 200) throw new HttpFailure(400, "Invalid to-do title");
        changes.title = title;
      }
      if (input.status !== undefined) {
        if (!["open", "parked", "done"].includes(String(input.status))) throw new HttpFailure(400, "Invalid to-do status");
        changes.status = input.status as ScratchpadItem["status"];
      }
      if (input.notes !== undefined) {
        if (typeof input.notes !== "string" || input.notes.length > 4000) throw new HttpFailure(400, "Invalid to-do notes");
        changes.notes = input.notes.trim();
      }
      json(response, 200, store.updateScratchpad(current.botId, itemId, changes)); return;
    }
    if (scratchpad && method === "DELETE") {
      const itemId = decodeURIComponent(scratchpad[1]!);
      const current = store.get<ScratchpadItem>("scratchpad", itemId);
      if (!current || current.removedAt) throw new HttpFailure(404, "To-do not found");
      store.removeScratchpad(current.botId, itemId);
      json(response, 200, { ok: true }); return;
    }
    if (url.pathname === "/api/model-settings/discover" && method === "POST") {
      if (!options.modelSettings?.discover) throw new HttpFailure(503, "Model discovery is unavailable");
      if (store.hasUnfinishedWork()) throw new HttpFailure(409, "请等待当前工作结束后刷新模型能力");
      json(response, 200, await options.modelSettings.discover());
      return;
    }
    if (url.pathname === "/api/model-settings" && (method === "GET" || method === "POST")) {
      if (!options.modelSettings) throw new HttpFailure(503, "Model settings are unavailable");
      if (method === "POST" && store.hasUnfinishedWork()) throw new HttpFailure(409, "请等待当前工作结束后切换模型");
      json(response, 200, method === "GET"
        ? await options.modelSettings.read() : await options.modelSettings.save(await body(request)));
      return;
    }
    if (method === "GET" && url.pathname === "/api/events") {
      const cursor = Number(request.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0");
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > store.cursor()) {
        throw new HttpFailure(400, "Invalid event cursor");
      }
      response.writeHead(200, { "content-type": "text/event-stream", "x-accel-buffering": "no" });
      streams.add(response);
      let last = cursor;
      // Transport liveness only; no state reads or native status polling.
      const heartbeat = setInterval(() => {
        if (!response.destroyed && !response.writableEnded) response.write(": heartbeat\n\n");
      }, 15_000);
      const detach = () => { clearInterval(heartbeat); store.off("event", send); streams.delete(response); };
      const send = (event: ProductEvent) => {
        if (event.cursor <= last || response.destroyed || response.writableEnded) return;
        last = event.cursor;
        if (!response.write(`id: ${event.cursor}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`)) {
          // Slow consumers reconnect from their last received cursor.
          // Detach synchronously: another event in this transaction can arrive
          // before Node emits the response's close event.
          detach();
          response.end();
        }
      };
      store.on("event", send);
      response.on("close", detach);
      response.on("error", detach);
      // Subscribe before replay: synchronous transactions cannot fall into a
      // replay/subscription gap, and cursor deduplication handles overlap.
      for (;;) {
        const page = store.eventsAfter(last);
        for (const event of page) { send(event); if (response.writableEnded) return; }
        if (page.length < 500) break;
      }
      response.write(": connected\n\n");
      return;
    }
    if (method === "POST" && url.pathname === "/api/conversations") {
      const input = await body(request);
      if (!Array.isArray(input.botIds) || !input.botIds.every((id) => typeof id === "string")) {
        throw new HttpFailure(400, "Expected Bot members");
      }
      // A client nonce pins the new session: a retried acceptance reuses the same
      // conversation instead of opening a second one for the same draft.
      const id = typeof input.clientNonce === "string" && input.clientNonce.length <= 200
        ? sessionIdFor(input.botIds as string[], input.clientNonce)
        : undefined;
      const conversation = store.createConversation(
        string(input.kind, "kind") as Conversation["kind"], input.botIds, string(input.title, "title"), id,
      );
      json(response, 201, conversation); return;
    }
    const clearConversation = /^\/api\/conversations\/([^/]+)\/clear$/.exec(url.pathname);
    if (method === "POST" && clearConversation) {
      const id = decodeURIComponent(clearConversation[1]!);
      const conversation = store.get<Conversation>("conversations", id);
      if (!conversation) throw new HttpFailure(404, "Unknown conversation");
      if (store.list<Task>("tasks").some((task) => task.conversationId === id &&
        ["queued", "running", "waiting", "stopping"].includes(task.status))) {
        throw new HttpFailure(409, "请先停止这个会话中的任务再清空");
      }
      if (!options.service.kernel) throw new HttpFailure(503, "Kernel unavailable");
      // The native reset writes a context boundary while retaining the transcript.
      // Hiding product messages alone would leave the previous prompt active.
      for (const botId of conversation.botIds) {
        await options.service.kernel.request("sessions.reset", {
          key: store.engineSessionKey(id, botId), reason: "reset",
        });
      }
      store.clearConversation(id);
      json(response, 200, { ok: true }); return;
    }
    const conversationRoute = /^\/api\/conversations\/([^/]+)$/.exec(url.pathname);
    if (conversationRoute && (method === "PATCH" || method === "DELETE")) {
      const id = decodeURIComponent(conversationRoute[1]!);
      const conversation = store.get<Conversation>("conversations", id);
      if (!conversation) throw new HttpFailure(404, "Conversation not found");
      // A private conversation is one task session: it owns a title and an archived
      // mark, while its members are fixed by the Bot it belongs to.
      if (conversation.kind === "private" && (method === "PATCH" || method === "DELETE")) {
        const patch = method === "PATCH" ? await body(request) : { archived: true };
        if (patch.title !== undefined && (typeof patch.title !== "string" || !patch.title.trim() || patch.title.length > 100)) {
          throw new HttpFailure(400, "Invalid conversation title");
        }
        if (patch.botIds !== undefined) throw new HttpFailure(400, "A private conversation keeps its Bot");
        // The owning Bot must still exist: a rename never transfers a session to another member.
        if (!store.get<Bot>("bots", conversation.botIds[0] ?? "")) throw new HttpFailure(404, "Unknown Bot");
        // A Bot's own conversation is its home thread, not a task session: it cannot be
        // archived away. Task sessions are the ones the session list can delete.
        const main = store.privateConversation(conversation.botIds[0] ?? "");
        if (main.id === conversation.id && (method === "DELETE" || patch.archived === true)) {
          throw new HttpFailure(404, "主会话不可归档");
        }
        if (patch.archived === true && conversation.archivedAt === undefined) {
          // Archiving a session that is still working would hide a task that keeps running.
          if (store.list<Task>("tasks").some((task) => task.conversationId === conversation.id &&
            ["queued", "running", "waiting", "stopping"].includes(task.status))) {
            throw new HttpFailure(409, "请先停止这个会话中的任务再归档");
          }
        }
        json(response, 200, store.put("conversations", {
          ...conversation,
          ...(typeof patch.title === "string" ? { title: patch.title.trim() } : {}),
          ...(patch.archived === true ? { archivedAt: Date.now() } : {}),
          ...(patch.archived === false ? { archivedAt: undefined } : {}),
          updatedAt: Date.now(),
        })); return;
      }
      if (conversation?.kind !== "group") throw new HttpFailure(404, "Group not found");
      const input = method === "PATCH" ? await body(request) : {};
      if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || input.title.length > 80)) {
        throw new HttpFailure(400, "Invalid group name");
      }
      if (input.botIds !== undefined && (!Array.isArray(input.botIds) ||
        input.botIds.length < 2 || input.botIds.length > 10 ||
        new Set(input.botIds).size !== input.botIds.length ||
        !input.botIds.every((botId) => typeof botId === "string" && store.get<Bot>("bots", botId)) ||
        new Set((input.botIds as string[]).map((botId) => store.spaceIdForBot(botId))).size !== 1)) {
        throw new HttpFailure(400, "Invalid group members");
      }
      if (input.expectedBotIds !== undefined && (!Array.isArray(input.expectedBotIds) ||
        input.expectedBotIds.length !== conversation.botIds.length ||
        !conversation.botIds.every((id) => (input.expectedBotIds as unknown[]).includes(id)))) {
        throw new HttpFailure(409, "Group members changed; reload before editing");
      }
      if (input.pinned !== undefined && typeof input.pinned !== "boolean") throw new HttpFailure(400, "Invalid pinned state");
      if (input.archived !== undefined && typeof input.archived !== "boolean") throw new HttpFailure(400, "Invalid archive state");
      if (input.sectionId !== undefined && input.sectionId !== null &&
        (typeof input.sectionId !== "string" ||
          (store.get<BotSection>("botSections", input.sectionId)?.spaceId ?? "local") !== (conversation.spaceId ?? "local"))) {
        throw new HttpFailure(400, "Unknown section");
      }
      const members = input.botIds as string[] | undefined;
      const archive = method === "DELETE" || input.archived === true;
      // Reuse the existing cancellation path before removing a member: native
      // abort still needs its current conversation membership/session identity.
      const removed = new Set(archive ? conversation.botIds : conversation.botIds.filter((id) => members && !members.includes(id)));
      await Promise.all(store.find<Task>("tasks", "conversationId", id)
        .filter((task) => removed.has(task.botId) && ["queued", "running", "waiting", "stopping"].includes(task.status))
        .map((task) => options.service.cancel(task.id)));
      json(response, 200, store.put("conversations", {
        ...conversation,
        ...(typeof input.title === "string" ? { title: input.title.trim() } : {}),
        ...(members ? { botIds: members } : {}),
        ...(typeof input.pinned === "boolean" ? { pinned: input.pinned } : {}),
        ...(input.sectionId !== undefined ? { sectionId: typeof input.sectionId === "string" ? input.sectionId : undefined } : {}),
        ...(archive ? { archivedAt: Date.now() } : input.archived === false ? { archivedAt: undefined } : {}),
        updatedAt: Date.now(),
      })); return;
    }
    const privateConversation = /^\/api\/bots\/([^/]+)\/private-conversation$/.exec(url.pathname);
    if (method === "POST" && privateConversation) {
      json(response, 200, store.privateConversation(privateConversation[1])); return;
    }
    const memory = /^\/api\/bots\/([^/]+)\/memory(?:\/(search|source|forget-preview|forget-backup|forget-apply|forget-restore|recoveries))?$/.exec(url.pathname);
    if (memory && (method === "GET" && (!memory[2] || memory[2] === "recoveries") || method === "POST" && memory[2] && memory[2] !== "recoveries")) {
      const memories = options.service.memories;
      if (!memories) throw new HttpFailure(503, "Memory management is unavailable");
      if (!memory[2]) { json(response, 200, await memories.health(memory[1])); return; }
      if (memory[2] === "recoveries") { json(response, 200, memories.recoveries(memory[1])); return; }
      const input = await body(request);
      if (memory[2] === "search") {
        json(response, 200, await memories.search(memory[1], {
          query: string(input.query, "query"),
          ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
          ...(input.cursor !== undefined ? { cursor: string(input.cursor, "cursor") } : {}),
          ...(input.sources !== undefined ? { sources: input.sources as MemoryQuery["sources"] } : {}),
        }));
      } else if (memory[2] === "forget-preview") {
        if (input.allowKernelPause !== true) throw new HttpFailure(400, "Memory preview requires explicit kernel pause");
        json(response, 200, await memories.previewForget(memory[1], input.conversationIds as string[]));
      } else if (memory[2] === "forget-backup") {
        if (input.allowKernelPause !== true) throw new HttpFailure(400, "Memory recovery preparation requires explicit kernel pause");
        json(response, 200, await memories.prepareForget(memory[1], string(input.previewId, "previewId"), string(input.digest, "digest")));
      } else if (memory[2] === "forget-apply") {
        if (input.allowKernelPause !== true || input.confirmForget !== true) throw new HttpFailure(400, "Forgetting requires explicit confirmation and kernel pause");
        json(response, 200, await memories.applyForget(memory[1], string(input.previewId, "previewId"), string(input.digest, "digest")));
      } else if (memory[2] === "forget-restore") {
        if (input.confirmRestore !== true) throw new HttpFailure(400, "Restoring a recovery copy requires explicit confirmation");
        json(response, 200, await memories.restoreForget(memory[1], string(input.previewId, "previewId")));
      } else {
        json(response, 200, await memories.get(memory[1], memoryReference(input.reference), input.from as number | undefined));
      }
      return;
    }
    if (method === "GET" && url.pathname === "/api/authorizations") {
      if (!options.authorizations) throw new HttpFailure(503, "Account sign-in is unavailable");
      json(response, 200, await options.authorizations.read()); return;
    }
    const authorizationStart = /^\/api\/authorizations\/([^/]+)\/start$/.exec(url.pathname);
    if (method === "POST" && authorizationStart) {
      if (!options.authorizations) throw new HttpFailure(503, "Account sign-in is unavailable");
      json(response, 201, await options.authorizations.start(decodeURIComponent(authorizationStart[1]))); return;
    }
    const authorizationCode = /^\/api\/authorizations\/([^/]+)\/code$/.exec(url.pathname);
    if (method === "POST" && authorizationCode) {
      if (!options.authorizations) throw new HttpFailure(503, "Account sign-in is unavailable");
      const input = await body(request);
      json(response, 200, await options.authorizations.complete(
        decodeURIComponent(authorizationCode[1]), string(input.code, "code"),
        input.issuer === undefined ? undefined : string(input.issuer, "issuer"),
      )); return;
    }
    const authorizationRevoke = /^\/api\/authorizations\/([^/]+)\/revoke$/.exec(url.pathname);
    if (method === "POST" && authorizationRevoke) {
      if (!options.authorizations) throw new HttpFailure(503, "Account sign-in is unavailable");
      const input = await body(request);
      if (input.confirmed !== true) throw new HttpFailure(400, "Confirm credential removal");
      json(response, 200, await options.authorizations.revoke(decodeURIComponent(authorizationRevoke[1]))); return;
    }
    // Cancelling is its own path, as the recipe and the workbench client spell it.
    const authorizationAttempt = /^\/api\/authorizations\/attempts\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (authorizationAttempt) {
      if (!options.authorizations) throw new HttpFailure(503, "Account sign-in is unavailable");
      const id = decodeURIComponent(authorizationAttempt[1]);
      const suffix = authorizationAttempt[2];
      if (method === "POST" && (suffix === "/cancel" || !suffix)) {
        await options.authorizations.cancel(id);
        const cancelled = options.authorizations.attempt(id);
        if (!cancelled) throw new HttpFailure(404, "Unknown sign-in attempt");
        json(response, 200, cancelled); return;
      }
      if (method !== "GET" || suffix) throw new HttpFailure(404, "Unknown endpoint");
      const requested = Number(url.searchParams.get("timeoutMs") ?? "60000");
      if (!Number.isFinite(requested) || requested < 0) throw new HttpFailure(400, "Invalid sign-in wait");
      const settled = await options.authorizations.wait(id, requested);
      if (!settled) throw new HttpFailure(404, "Unknown sign-in attempt");
      json(response, 200, settled); return;
    }
    if (url.pathname === "/api/connections" && (method === "GET" || method === "POST")) {
      if (!options.connections) throw new HttpFailure(503, "Connection management is unavailable");
      if (method === "POST") {
        await options.connections.add(await body(request) as ServiceConnectionInput);
      }
      json(response, method === "POST" ? 201 : 200, await options.connections.list()); return;
    }
    const connectionAccess = /^\/api\/connections\/([^/]+)\/access$/.exec(url.pathname);
    if (method === "POST" && connectionAccess) {
      if (!options.connections) throw new HttpFailure(503, "Connection management is unavailable");
      const input = await body(request);
      if (typeof input.enabled !== "boolean") throw new HttpFailure(400, "Expected enabled boolean");
      await options.connections.setEnabled(decodeURIComponent(connectionAccess[1]), input.enabled);
      json(response, 200, await options.connections.list()); return;
    }
    const connectionEdit = /^\/api\/connections\/([^/]+)\/(update|remove)$/.exec(url.pathname);
    if (method === "POST" && connectionEdit) {
      if (!options.connections) throw new HttpFailure(503, "Connection management is unavailable");
      const input = await body(request);
      const name = decodeURIComponent(connectionEdit[1]);
      if (connectionEdit[2] === "remove") {
        if (input.confirmed !== true) throw new HttpFailure(400, "Confirm connection removal");
        await options.connections.remove(name);
      } else await options.connections.update(name, input as ServiceConnectionUpdate);
      json(response, 200, await options.connections.list()); return;
    }
    if ((url.pathname === "/api/abilities" && (method === "GET" || method === "POST")) ||
        (url.pathname === "/api/abilities/refresh" && method === "POST")) {
      if (!options.service.abilities) throw new HttpFailure(503, "Capability management is unavailable");
      json(response, 200, await (method === "GET"
        ? options.service.abilities.listShared() : options.service.abilities.refreshShared()));
      return;
    }
    const sharedCapabilityAccess = /^\/api\/abilities\/([^/]+)\/access$/.exec(url.pathname);
    if (method === "POST" && sharedCapabilityAccess) {
      if (!options.service.abilities) throw new HttpFailure(503, "Capability management is unavailable");
      const input = await body(request);
      if (typeof input.enabled !== "boolean") throw new HttpFailure(400, "Expected enabled state");
      json(response, 200, await options.service.abilities.setSharedEnabled(
        decodeURIComponent(sharedCapabilityAccess[1]), input.enabled,
      ));
      return;
    }
    const capabilityRefresh = /^\/api\/bots\/([^/]+)\/abilities\/refresh$/.exec(url.pathname);
    if (method === "POST" && capabilityRefresh) {
      if (!options.service.abilities) throw new HttpFailure(503, "Capability management is unavailable");
      json(response, 200, await options.service.abilities.refresh(capabilityRefresh[1])); return;
    }
    const capabilityAccess = /^\/api\/bots\/([^/]+)\/abilities\/([^/]+)\/access$/.exec(url.pathname);
    if (method === "POST" && capabilityAccess) {
      if (!options.service.abilities) throw new HttpFailure(503, "Capability management is unavailable");
      const input = await body(request);
      if (typeof input.enabled !== "boolean") throw new HttpFailure(400, "Expected enabled state");
      json(response, 200, await options.service.abilities.setEnabled(
        decodeURIComponent(capabilityAccess[2]), capabilityAccess[1], input.enabled,
      ));
      return;
    }
    const widget = /^\/api\/messages\/([^/]+)\/widgets\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && widget) {
      const message = store.get<Message>("messages", decodeURIComponent(widget[1]));
      const block = message?.blocks.find((item) => item.id === decodeURIComponent(widget[2]) && item.kind === "widget");
      if (!message || !store.get("conversations", message.conversationId) || block?.kind !== "widget") {
        throw new HttpFailure(404, "Unknown preview");
      }
      const document = await options.service.kernel.request<{ html: string }>("canvas.document.view", {
        docId: block.docId, sessionKey: block.sessionKey,
      });
      if (typeof document.html !== "string") throw new HttpFailure(502, "Preview is unavailable");
      json(response, 200, { html: document.html }); return;
    }
    const messages = /^\/api\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
    if (method === "GET" && messages) {
      if (!store.get("conversations", messages[1])) throw new HttpFailure(404, "Unknown conversation");
      const history = store.visibleMessages(messages[1]);
      const fileIds = new Set(history.flatMap((message) =>
        message.blocks.flatMap((block) => block.kind === "file" ? [block.artifactId] : [])));
      const artifacts = [...fileIds].flatMap((id) => {
        const file = store.get<Artifact>("artifacts", id);
        return file ? [file] : [];
      });
      json(response, 200, { messages: history, artifacts, cursor: store.cursor() }); return;
    }
    if (method === "POST" && url.pathname === "/api/submissions") {
      const input = await body(request);
      if (input.voicePlayback !== undefined && (!input.voicePlayback || typeof input.voicePlayback !== "object" ||
        typeof (input.voicePlayback as Record<string, unknown>).messageId !== "string" ||
        typeof (input.voicePlayback as Record<string, unknown>).heardText !== "string"))
        throw new HttpFailure(400, "Invalid voice playback receipt");
      if (input.queueMode !== undefined && input.queueMode !== "followup" && input.queueMode !== "steer") throw new HttpFailure(400, "Invalid input mode");
      if (input.attachmentIds !== undefined && (!Array.isArray(input.attachmentIds) ||
        !input.attachmentIds.every((id) => typeof id === "string"))) throw new HttpFailure(400, "Invalid attachment identities");
      const task = await options.service.submit({
        submissionId: string(input.submissionId, "submissionId"),
        conversationId: string(input.conversationId, "conversationId"),
        botId: string(input.botId, "botId"), message: typeof input.message === "string" ? input.message : string(input.message, "message"),
        ...(input.voicePlayback ? { voicePlayback: input.voicePlayback as { messageId: string; heardText: string } } : {}),
        ...(input.queueMode ? { queueMode: input.queueMode as "followup" | "steer" } : {}),
        ...(input.attachmentIds ? { attachmentIds: input.attachmentIds as string[] } : {}),
        ...(input.reportConversationId !== undefined
          ? { reportConversationId: string(input.reportConversationId, "reportConversationId") } : {}),
      });
      json(response, 202, task); return;
    }
    if (method === "POST" && url.pathname === "/api/group-submissions") {
      const input = await body(request);
      if (input.queueMode !== undefined && input.queueMode !== "followup" && input.queueMode !== "steer") throw new HttpFailure(400, "Invalid input mode");
      if (!Array.isArray(input.botIds) || !input.botIds.every((id) => typeof id === "string")) {
        throw new HttpFailure(400, "Expected group recipients");
      }
      if (input.attachmentIds !== undefined && (!Array.isArray(input.attachmentIds) ||
        !input.attachmentIds.every((id) => typeof id === "string"))) throw new HttpFailure(400, "Invalid attachment identities");
      json(response, 202, await options.service.submitGroup({
        submissionId: string(input.submissionId, "submissionId"),
        conversationId: string(input.conversationId, "conversationId"), botIds: input.botIds,
        ...(input.queueMode ? { queueMode: input.queueMode as "followup" | "steer" } : {}),
        message: typeof input.message === "string" ? input.message : string(input.message, "message"),
        ...(input.attachmentIds ? { attachmentIds: input.attachmentIds as string[] } : {}),
      }));
      return;
    }
    const cancel = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(url.pathname);
    if (method === "POST" && cancel) {
      json(response, 202, await options.service.cancel(decodeURIComponent(cancel[1]))); return;
    }
    const continuation = /^\/api\/tasks\/([^/]+)\/continue$/.exec(url.pathname);
    if (method === "POST" && continuation) {
      const input = await body(request);
      json(response, 202, await options.service.continueTask(decodeURIComponent(continuation[1]), string(input.submissionId, "submissionId")));
      return;
    }
    const resolveInteraction = /^\/api\/tasks\/([^/]+)\/interactions\/([^/]+)\/resolve$/.exec(url.pathname);
    if (method === "POST" && resolveInteraction) {
      const input = await body(request);
      const resolutionId = string(input.resolutionId, "resolutionId");
      let answer: InteractionAnswer;
      if (input.cancel === true) answer = { resolutionId, cancel: true };
      else if (input.decision === "allow-once" || input.decision === "allow-always" || input.decision === "deny") {
        answer = { resolutionId, decision: input.decision };
      } else {
        if (!input.answers || typeof input.answers !== "object" || Array.isArray(input.answers)) {
          throw new HttpFailure(400, "Expected question answers");
        }
        answer = { resolutionId, answers: input.answers as Record<string, string[]> };
      }
      json(response, 200, await options.service.interactions.resolve(
        decodeURIComponent(resolveInteraction[2]), decodeURIComponent(resolveInteraction[1]), answer,
      ));
      return;
    }
    throw new HttpFailure(404, "Unknown endpoint");
  }

  return {
    server,
    async listen(port = 0): Promise<string> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    async close(): Promise<void> {
      for (const stream of streams) stream.end();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}
