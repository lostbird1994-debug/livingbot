import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AdapterContext, AgentRunRequest, MemoryReadRequest } from "@livingbot/adapter-kit";
import type { OpenClawKernelOptions } from "./openclaw-kernel.js";

export interface KernelAgentEntry {
  botId: string;
  spaceId: string;
  userId: string;
  agentId: string;
  workspace: string;
  sharedWorkspace: string;
  chief?: boolean;
  documentAliases?: Record<string, string>;
}
export async function loadKernelManifest(file: string): Promise<{
  version: 1; bots: KernelAgentEntry[];
  sharedWorkspaces?: Array<{ spaceId: string; userId: string; workspace: string; documentAliases?: Record<string, string> }>;
}> {
  const value = JSON.parse(await readFile(file, "utf8"));
  if (
    value.version !== 1 || !Array.isArray(value.bots) ||
    value.bots.some((entry: KernelAgentEntry) => !entry.botId || !entry.userId || !entry.spaceId ||
      !/^[a-zA-Z0-9_-]+$/.test(entry.agentId) || !entry.workspace?.startsWith("/") ||
      !entry.sharedWorkspace?.startsWith("/")) ||
    new Set(value.bots.map((entry: KernelAgentEntry) => entry.botId)).size !== value.bots.length ||
    new Set(value.bots.map((entry: KernelAgentEntry) => entry.agentId)).size !== value.bots.length ||
    new Set(value.bots.map((entry: KernelAgentEntry) => resolve(entry.workspace))).size !== value.bots.length ||
    value.bots.some((entry: KernelAgentEntry) => value.bots.some((other: KernelAgentEntry) =>
      resolve(entry.workspace) === resolve(other.sharedWorkspace)))
  ) throw new Error("Invalid native agent registry");
  return value;
}
export interface KernelEngineConfig {
  gateway?: { port?: number; auth?: { token?: string } };
  agents?: { defaults?: { workspace?: string; skipBootstrap?: boolean }; list?: Array<{ id: string; workspace?: string }> };
  models?: { providers?: Record<string, {
    baseUrl?: string; apiKey?: string; headers?: Record<string, string>; api?: string;
    models?: Array<{ id: string }>;
  }> };
}
const endpoint = (value: string | undefined) => value?.replace(/\/+$/, "");
const headers = (value: Record<string, string> | undefined) =>
  JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
export function nativeKernelProtocol(request: AgentRunRequest): string {
  return request.model.apiProtocol === "responses" ? "openai-responses"
    : request.model.apiProtocol === "anthropic-messages" ? "anthropic-messages" : "openai-completions";
}

/** Provider and credential must both match; a same-named model is not enough. */
export function nativeKernelModel(request: AgentRunRequest, config: KernelEngineConfig): string | undefined {
  if (request.model.provider === "openai-compatible" && /^openclaw\/[a-zA-Z0-9_-]+$/.test(request.model.id))
    return undefined;
  for (const [provider, settings] of Object.entries(config.models?.providers ?? {})) {
    if (
      settings.apiKey !== request.model.apiKey ||
      endpoint(settings.baseUrl) !== endpoint(request.model.baseUrl) ||
      (settings.api ?? "openai-completions") !== nativeKernelProtocol(request) ||
      headers(settings.headers) !== headers(request.model.headers)
    ) continue;
    if (settings.models?.some(model => model.id === request.model.id))
      return `${provider}/${request.model.id}`;
  }
  throw new Error("The selected model connection has not been registered with the native engine");
}

export function resolveKernelAgent(
  entry: KernelAgentEntry,
  request: AgentRunRequest,
  context: Partial<AdapterContext>,
  config: KernelEngineConfig,
) {
  if (
    entry.botId !== request.botId || entry.spaceId !== context.spaceId || entry.userId !== context.userId ||
    !/^[a-zA-Z0-9_-]+$/.test(entry.agentId)
  ) throw new Error("Native agent tenant ownership does not match");
  const registered = config.agents?.list?.find(agent => agent.id === entry.agentId);
  const workspace = registered?.workspace ?? config.agents?.defaults?.workspace;
  if (!registered || !workspace || resolve(workspace) !== resolve(entry.workspace))
    throw new Error("Native agent workspace mapping is not confirmed");
  const port = config.gateway?.port ?? 18789;
  const token = config.gateway?.auth?.token;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== "string" || !token)
    throw new Error("Native engine connection is not configured");
  return {
    agentId: entry.agentId, modelId: nativeKernelModel(request, config),
    url: `ws://127.0.0.1:${port}`, token,
  };
}

export class OpenClawKernelRegistry {
  constructor(private options: {
    manifestFile: string;
    configFile?: string;
    /** Only the host's authorized new-bot workflow may create missing entries. */
    provisionNewBot?: (request: AgentRunRequest, context: Partial<AdapterContext>) => Promise<void>;
    provisionBot?: (botId: string, context: Pick<AdapterContext, "spaceId" | "userId">) => Promise<void>;
    prepareModel?: (request: AgentRunRequest) => Promise<void>;
  }) {}

  async entry(botId: string, context: Pick<AdapterContext, "spaceId" | "userId">) {
    const find = async () => (await loadKernelManifest(this.options.manifestFile)).bots.find(bot =>
      bot.botId === botId && bot.spaceId === context.spaceId && bot.userId === context.userId);
    let entry = await find();
    if (!entry && this.options.provisionBot) {
      await this.options.provisionBot(botId, context);
      entry = await find();
    }
    if (!entry) throw new Error("Native workspace ownership is not confirmed");
    return entry;
  }

  readonly resolveMemoryWorkspace = async (request: MemoryReadRequest, context: AdapterContext) => {
    if (request.scope === "bot") {
      if (!request.botId) throw new Error("A private native memory read requires a bot");
      const entry = await this.entry(request.botId, context);
      return { root: entry.workspace, aliases: entry.documentAliases };
    }
    const manifest = await loadKernelManifest(this.options.manifestFile);
    const entries = manifest.bots.filter(bot =>
      bot.spaceId === context.spaceId && bot.userId === context.userId);
    if (!entries.length || new Set(entries.map(bot => bot.sharedWorkspace)).size !== 1)
      throw new Error("Shared native workspace ownership is not confirmed");
    const shared = manifest.sharedWorkspaces?.find(item =>
      item.spaceId === context.spaceId && item.userId === context.userId);
    if (shared && shared.workspace !== entries[0]!.sharedWorkspace)
      throw new Error("Shared native workspace mapping changed");
    return { root: entries[0]!.sharedWorkspace, aliases: shared?.documentAliases };
  };

  readonly resolveAgent: OpenClawKernelOptions["resolveAgent"] = async (request, context) => {
    const load = () => loadKernelManifest(this.options.manifestFile);
    let manifest = await load();
    if (manifest.version !== 1 || !Array.isArray(manifest.bots)) throw new Error("Unknown native agent registry");
    let entry = manifest.bots.find(bot => bot.botId === request.botId);
    if (!entry && this.options.provisionNewBot) {
      await this.options.provisionNewBot(request, context);
      manifest = await load();
      entry = manifest.bots.find(bot => bot.botId === request.botId);
    }
    if (!entry && context.spaceId && context.userId)
      entry = await this.entry(request.botId, { spaceId: context.spaceId, userId: context.userId });
    if (!entry) throw new Error("Bot native workspace migration has not been prepared");
    const loadConfig = async (): Promise<KernelEngineConfig> => JSON.parse(await readFile(
      this.options.configFile ?? join(homedir(), ".openclaw", "openclaw.json"), "utf8",
    ));
    let config = await loadConfig();
    // LivingBot already owns profile creation. Engine template bootstrap mutates one
    // shared workspace state file and is unsafe to race across independent sessions.
    if (request.independentTask && config.agents?.defaults?.skipBootstrap !== true)
      throw new Error("Independent tasks require managed workspace bootstrap (agents.defaults.skipBootstrap=true).");
    try { nativeKernelModel(request, config); }
    catch (error) {
      if (!this.options.prepareModel) throw error;
      await this.options.prepareModel(request);
      config = await loadConfig();
    }
    return resolveKernelAgent(entry, request, context, config);
  };
}
