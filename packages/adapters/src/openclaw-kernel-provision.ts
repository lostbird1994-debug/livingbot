import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AdapterContext, AgentRunRequest } from "@livingbot/adapter-kit";
import { botRoleCard } from "@livingbot/contracts";
import { WORKSPACE_CHIEF_SPAWN_KEY } from "@livingbot/core";
import type { PrismaClient } from "@livingbot/db";
import { connectOpenClawSdk } from "./openclaw-gateway.js";
import { NATIVE_KERNEL_TOOL_ALLOWLIST } from "./native-collaboration.js";
import type { KernelAgentEntry } from "./openclaw-kernel-registry.js";
import { loadKernelManifest, nativeKernelModel, nativeKernelProtocol } from "./openclaw-kernel-registry.js";
import {
  assertAllowedOpenAiCompatibleUrl, assertHttpsForKeyedOpenAiCompatibleUrl,
} from "./openai-compatible-url.js";
import { nativeBotAgentId, planBotWorkspace } from "./openclaw-workspace.js";
import { readNativeWorkspaceFile, writeNativeWorkspaceFile } from "./openclaw-workspace-files.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const safeId = (id: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Unsafe native ownership ID");
  return id;
};
type Actor = Pick<AdapterContext, "spaceId" | "userId">;
export class OpenClawKernelProvisioner {
  private readonly configRoot: string;
  constructor(private options: {
    prisma: PrismaClient; dataDir: string; registryFile: string;
    withLock<T>(key: string, work: () => Promise<T>): Promise<T>;
    configRoot?: string;
    waitReady?: (agentId?: string, modelId?: string) => Promise<void>;
  }) { this.configRoot = options.configRoot ?? join(homedir(), ".openclaw"); }

  /** Config changes are infrequent, serialize only preparation; running Bots never wait on this lock. */
  private async changeConfig(change: (config: Record<string, any>) => void) {
    return this.options.withLock("native-engine-config", async () => {
      const before = await readNativeWorkspaceFile(this.configRoot, "openclaw.json");
      if (!before) throw new Error("Native engine configuration is missing");
      const config = JSON.parse(before);
      change(config);
      const after = JSON.stringify(config, null, 2) + "\n";
      if (JSON.stringify(JSON.parse(before)) !== JSON.stringify(config))
        await writeNativeWorkspaceFile(this.configRoot, "openclaw.json", after, before);
      return config;
    });
  }
  private async ready(agentId?: string, modelId?: string) {
    if (this.options.waitReady) return this.options.waitReady(agentId, modelId);
    const config = JSON.parse(await readFile(join(this.configRoot, "openclaw.json"), "utf8"));
    const peer = await connectOpenClawSdk(`ws://127.0.0.1:${config.gateway.port}`, config.gateway.auth.token, () => {});
    try {
      for (let attempt = 0; attempt < 40; attempt++) {
        const agents = agentId ? await peer.request<any>("agents.list", {}) : undefined;
        const models = modelId ? await peer.request<any>("models.list", {}) : undefined;
        const foundAgent = !agentId || agents.agents?.some((agent: any) => agent.id === agentId);
        const foundModel = !modelId || models.models?.some((model: any) => `${model.provider}/${model.id}` === modelId);
        if (foundAgent && foundModel) return;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error("Native engine has not confirmed the prepared agent or model");
    } finally { peer.stop(); }
  }

  readonly prepareModel = async (request: AgentRunRequest) => {
    const model = request.model;
    if (model.oauth) throw new Error("This native model requires explicit OAuth credential migration");
    if (!model.baseUrl) throw new Error("The native model needs a configured protocol endpoint");
    const url = assertAllowedOpenAiCompatibleUrl(model.baseUrl, { allowPrivate: model.allowPrivateEndpoint });
    assertHttpsForKeyedOpenAiCompatibleUrl(url, model.apiKey);
    const api = nativeKernelProtocol(request);
    const provider = `rakazo-${hash(JSON.stringify([
      model.baseUrl.replace(/\/+$/, ""), model.apiKey,
      Object.entries(model.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)), api,
    ])).slice(0, 24)}`;
    const config = await this.changeConfig(config => {
      try { nativeKernelModel(request, config); return; } catch { /* Prepare the exact selected connection. */ }
      config.models ??= {}; config.models.providers ??= {};
      const existing = config.models.providers[provider];
      const definition = {
        id: model.id, name: model.id, api,
        reasoning: model.reasoning ?? false, input: model.acceptsImages ? ["text", "image"] : ["text"],
        contextWindow: model.contextWindow ?? 128_000, maxTokens: model.maxTokens ?? 8192,
        // Required engine metadata; LivingBot never presents these unknown prices as a billed cost.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      config.models.providers[provider] = {
        ...existing, baseUrl: model.baseUrl, api,
        ...(model.apiKey ? { apiKey: model.apiKey } : { authHeader: false }),
        ...(model.headers ? { headers: model.headers } : {}),
        models: [...(existing?.models ?? []).filter((item: any) => item.id !== model.id), definition],
      };
      if (config.agents?.defaults?.models)
        config.agents.defaults.models[`${provider}/${model.id}`] ??= {};
    });
    await this.ready(undefined, nativeKernelModel(request, config));
  };

  readonly provisionBot = async (botId: string, actor: Actor) =>
    this.options.withLock("native-agent-registry", async () => {
      const original = await readFile(this.options.registryFile, "utf8");
      const manifest = JSON.parse(original);
      await loadKernelManifest(this.options.registryFile);
      const mapped = manifest.bots.find((entry: KernelAgentEntry) => entry.botId === botId);
      if (mapped) {
        if (mapped.spaceId !== actor.spaceId || mapped.userId !== actor.userId)
          throw new Error("Native bot ownership mismatch");
        return;
      }
      const bot = await this.options.prisma.bot.findFirstOrThrow({
        where: { id: botId, spaceId: actor.spaceId, userId: actor.userId }, include: { computer: true },
      });
      if (!Number.isFinite(Date.parse(manifest.migrationCompletedAt)) ||
        bot.createdAt.getTime() <= Date.parse(manifest.migrationCompletedAt))
        throw new Error("Existing bot needs an explicit, backed-up workspace migration");
      safeId(bot.id); safeId(bot.spaceId); safeId(bot.userId);
      let workspace: string;
      const reference = bot.computer?.providerRef;
      const nativeRoot = process.env.RAKAZO_NATIVE_ROOT ?? dirname(this.options.dataDir);
      let host: { authorized?: boolean; root?: string } | undefined;
      try { host = JSON.parse(await readFile(join(nativeRoot, "native-host.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (bot.computer && host?.authorized === true && typeof host.root === "string") {
        if (reference && !/^host:[a-f0-9]{64}$/.test(reference))
          throw new Error("A remote computer needs an explicit native workspace mapping");
        const home = join(host.root, "desktop-computers", reference ? reference.slice(5) : hash(bot.computer.homeKey));
        workspace = bot.computer.scope === "team" ? join(home, "bots", bot.id) : home;
      } else {
        if (reference) throw new Error("Existing computer workspace must be explicitly mapped");
        workspace = join(this.options.dataDir, "openclaw", "workspaces", bot.id);
      }
      const sharedWorkspace = manifest.bots.find((entry: KernelAgentEntry) =>
        entry.spaceId === actor.spaceId && entry.userId === actor.userId)?.sharedWorkspace ??
        join(this.options.dataDir, "openclaw", "shared", actor.spaceId, actor.userId);
      const agentId = nativeBotAgentId(actor.spaceId, bot.id);
      const plan = planBotWorkspace({ ...bot, roleCard: botRoleCard(bot.roleCard) }, []);
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      await mkdir(sharedWorkspace, { recursive: true, mode: 0o700 });
      for (const [name, content] of Object.entries(plan.files)) {
        const existing = await readNativeWorkspaceFile(workspace, name);
        if (existing !== undefined && existing !== content)
          throw new Error("Existing native file conflicts with new bot setup; explicit adoption required");
        await writeNativeWorkspaceFile(workspace, name, content, existing);
      }
      if (await readNativeWorkspaceFile(sharedWorkspace, "MEMORY.md") === undefined)
        await writeNativeWorkspaceFile(sharedWorkspace, "MEMORY.md", "", undefined);
      await this.changeConfig(config => {
        config.agents ??= {}; config.agents.list ??= [];
        const existing = config.agents.list.find((agent: any) => agent.id === agentId);
        if (existing && existing.workspace !== workspace) throw new Error("Native agent workspace collision");
        if (!existing) config.agents.list.push({
          id: agentId, name: bot.name, workspace, contextTokens: 64_000,
          tools: { allow: [...NATIVE_KERNEL_TOOL_ALLOWLIST], alsoAllow: [] },
        });
      });
      await this.ready(agentId);
      manifest.bots.push({
        botId: bot.id, spaceId: actor.spaceId, userId: actor.userId, agentId, workspace, sharedWorkspace,
        chief: bot.spawnKey === WORKSPACE_CHIEF_SPAWN_KEY,
      });
      await writeNativeWorkspaceFile(dirname(this.options.registryFile), "agents.json",
        JSON.stringify(manifest, null, 2) + "\n", original);
    });
}
