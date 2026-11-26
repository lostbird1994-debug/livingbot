import { constants } from "node:fs";
import { access, lstat, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { buildKernelConfig, newGatewayToken } from "../../../packages/kernel-runtime/src/config.ts";
import { discoverLocalEmbeddings, stopLocalEmbeddings, warmLocalEmbeddings } from "./local-embeddings.ts";
import type { ModelConnection } from "../../../packages/kernel-runtime/src/config.ts";
import { runtimePaths, preparePaths } from "../../../packages/kernel-runtime/src/paths.ts";
import { KernelRuntime } from "../../../packages/kernel-runtime/src/runtime.ts";
import { createOpenClawPeer } from "../../../packages/kernel-runtime/src/sdk-peer.ts";
import { OpenClawCapabilities } from "../../../packages/kernel-runtime/src/capabilities.ts";
import { OpenClawConnections } from "../../../packages/kernel-runtime/src/connections.ts";
import { OpenClawAuthorizationCommands, OpenClawMcpAuthorizations } from "../../../packages/kernel-runtime/src/authorizations.ts";
import { OpenClawModelSettings } from "../../../packages/kernel-runtime/src/model-settings.ts";
import { OpenClawRoutines } from "../../../packages/kernel-runtime/src/routines.ts";
import { OpenClawMemory } from "../../../packages/kernel-runtime/src/memory.ts";
import { OpenClawMemoryForgetPreview } from "../../../packages/kernel-runtime/src/memory-forget.ts";
import { OpenClawAgents } from "../../../packages/kernel-runtime/src/agents.ts";
import { GitHubPackages, Marketplace } from "../../../packages/workbench/src/marketplace.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import { WorkbenchService } from "../../../packages/workbench/src/service.ts";
import { ServiceAuthorizations } from "../../../packages/workbench/src/service-authorizations.ts";
import { Workspaces } from "../../../packages/workbench/src/workspaces.ts";
import { Files } from "../../../packages/workbench/src/files.ts";
import { createWorkbenchApi } from "./http.ts";
import { previewOpenClawContext } from "../../../packages/kernel-runtime/src/context-preview.ts";
import { SUPER_ADMIN_AGENT_ID } from "../../../packages/workbench/src/system-policy.ts";
import { SystemSettings } from "./system-settings.ts";

export async function freeLoopbackPort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => { reservation.off("error", reject); resolve(); });
  });
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function existingJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Configuration must be a regular file");
    if ((metadata.mode & 0o077) !== 0) throw new Error("Private configuration must have mode 0600");
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Operator-supplied, file-based executor wiring. There is no configuration UI. */
export type AcpExecutors = {
  plugin: string;
  agents: Record<string, { command: string; args?: string[] }>;
  allowed: string[];
};

/** Validates the operator file; the vendor CLI keeps its own login and account. */
export function acpExecutors(value: unknown): AcpExecutors {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!input || Object.keys(input).some((key) => !["plugin", "agents", "allowed"].includes(key))) {
    throw new Error("Executor configuration must name a plugin, agents and allowed executors");
  }
  if (typeof input.plugin !== "string" || !isAbsolute(input.plugin)) {
    throw new Error("Executor configuration needs an absolute plugin path");
  }
  const agents = input.agents && typeof input.agents === "object" && !Array.isArray(input.agents)
    ? input.agents as Record<string, unknown> : {};
  const entries = Object.entries(agents);
  if (!entries.length || entries.length > 8) throw new Error("Configure 1–8 executors");
  const resolved: AcpExecutors["agents"] = {};
  for (const [id, raw] of entries) {
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) throw new Error("Executor names must be simple lowercase identifiers");
    const agent = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    if (Object.keys(agent).some((key) => !["command", "args"].includes(key))) throw new Error("An executor takes a command and arguments only");
    if (typeof agent.command !== "string" || !agent.command.trim() || agent.command.length > 1024) {
      throw new Error("Each executor needs a command");
    }
    const args = agent.args === undefined ? [] : agent.args;
    if (!Array.isArray(args) || args.length > 32 ||
      args.some((item) => typeof item !== "string" || item.length > 2048 || item.includes("\0"))) {
      throw new Error("Executor arguments must be plain strings");
    }
    resolved[id] = { command: agent.command, ...(args.length ? { args: args as string[] } : {}) };
  }
  if (!Array.isArray(input.allowed) || !input.allowed.length || input.allowed.length > entries.length ||
    input.allowed.some((id) => typeof id !== "string" || !Object.hasOwn(resolved, id)) ||
    new Set(input.allowed).size !== input.allowed.length) {
    throw new Error("Allowed executors must be a subset of the configured ones");
  }
  return { plugin: input.plugin, agents: resolved, allowed: input.allowed as string[] };
}

export async function launchWorkbench(options: {
  root?: string;
  protectedRoots?: string[];
  nodeExecutable: string;
  kernelEntry: string;
  connection?: ModelConnection;
  port?: number;
  webRoot?: string;
  acp?: AcpExecutors;
  // Tests and operators can keep the product text-only even when assets exist.
  localEmbeddings?: boolean;
}) {
  if (!isAbsolute(options.nodeExecutable) || !isAbsolute(options.kernelEntry)) {
    throw new Error("Node and kernel entry paths must be absolute");
  }
  // The official launcher may replay pending lifecycle scripts. Do not trigger
  // package mutations as a side effect of application startup.
  for (const marker of [".openclaw-lifecycle-pending", "dist/openclaw-install-guard"]) {
    const pending = await access(join(dirname(options.kernelEntry), marker), constants.F_OK)
      .then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
    if (pending) throw new Error("OpenClaw installation is incomplete; finish a reviewed installation before launching");
  }
  const paths = runtimePaths(options.root);
  await preparePaths(paths, options.protectedRoots);
  const store = new WorkbenchStore(join(paths.root, "workbench.sqlite"));
  let existingConfig: Record<string, unknown> | undefined;
  try { existingConfig = await existingJson(paths.config); } catch (error) { store.close(); throw error; }
  if (!store.snapshot().bots.length) store.createBot({ name: "Living", agentId: "living" });
  const workspaces = new Workspaces(paths.workspaces);
  const agents = await Promise.all(store.snapshot().bots.map(async (bot) => ({
    id: bot.agentId, workspace: await workspaces.initialize(bot.agentId), rememberAcrossConversations: true,
  })));
  if (!existingConfig) {
    const administrator = {
      id: SUPER_ADMIN_AGENT_ID,
      workspace: await workspaces.initialize(SUPER_ADMIN_AGENT_ID),
      rememberAcrossConversations: true,
    };
    // The native config chooses its first entry as ambient owner on first launch.
    agents.splice(0, agents.length, administrator, ...agents.filter(agent => agent.id !== administrator.id));
  }
  const gateway = existingConfig?.gateway as { port?: number; auth?: { token?: string } } | undefined;
  const port = gateway?.port ?? await freeLoopbackPort();
  const token = gateway?.auth?.token ?? newGatewayToken();
  const authPath = join(paths.root, "client-auth.json");
  const auth = await existingJson(authPath);
  const clientToken = typeof auth?.token === "string" ? auth.token : randomBytes(32).toString("base64url");
  if (!auth) await writeFile(authPath, JSON.stringify({ token: clientToken }), { mode: 0o600, flag: "wx" });
  const kernel = new KernelRuntime({
    nodeExecutable: options.nodeExecutable, entry: options.kernelEntry,
    paths, port, token, peerFactory: createOpenClawPeer, expectedVersion: "2026.11.5",
    initialGeneration: store.get<{ id: string; generation: number }>("settings", "kernel-generation")?.generation,
  });
  const forgetting = new OpenClawMemoryForgetPreview({
    nodeExecutable: options.nodeExecutable, entry: options.kernelEntry, paths,
  });
  const memory = new OpenClawMemory(kernel, {
    preview(agentId, sessions) {
      if (store.hasUnfinishedWork()) throw new Error("Wait for current work to finish before memory preview");
      return kernel.offlineMaintenance(() => forgetting.preview(agentId, sessions));
    },
    prepare(agentId, sessions, digest) {
      if (store.hasUnfinishedWork()) throw new Error("Wait for current work to finish before memory recovery preparation");
      return kernel.offlineMaintenance(() => forgetting.prepare(agentId, sessions, digest));
    },
    outcome: (agentId, sessions, digest, requestId) => forgetting.outcome(agentId, sessions, digest, requestId),
    // Reading a reviewed copy into a new folder needs no kernel pause: it never
    // writes into live state or the workspace.
    restore: (recoveryId: string) => forgetting.restore(recoveryId),
    apply(agentId, sessions, digest, requestId) {
      if (store.hasUnfinishedWork()) throw new Error("Wait for current work to finish before forgetting");
      let restart = true;
      return kernel.offlineMaintenance(async () => {
        const outcome = await forgetting.apply(agentId, sessions, digest, requestId);
        restart = outcome.status === "completed";
        return outcome;
      }, { restartAfter: () => restart });
    },
  });
  const service = new WorkbenchService(store, kernel, new OpenClawCapabilities(kernel), new Files(store, workspaces), memory, new OpenClawRoutines(kernel));
  const nativeToolToken = randomBytes(32).toString("base64url");
  const authorizations = new ServiceAuthorizations(store, new OpenClawMcpAuthorizations({
    commands: new OpenClawAuthorizationCommands({
      nodeExecutable: options.nodeExecutable, entry: options.kernelEntry, paths,
    }),
    pauseKernel: (operation) => kernel.offlineMaintenance(operation),
  }));
  const marketplace = new Marketplace(store, new GitHubPackages(), {
    workspaces, registration: new OpenClawAgents(kernel), capabilities: new OpenClawCapabilities(kernel),
    withChanges: (botId, action) => service.abilities!.withChanges(botId, action),
  });
  const api = createWorkbenchApi({
    service, token: clientToken, nativeToolToken, webRoot: options.webRoot,
    connections: new OpenClawConnections(kernel),
    authorizations,
    modelSettings: new OpenClawModelSettings(kernel),
    marketplace,
    botWorkspaces: workspaces, agentRegistration: new OpenClawAgents(kernel),
    kernelConfigPath: paths.config,
    nativeContextPreview: async (agentId) => previewOpenClawContext({
      kernelEntry: options.kernelEntry,
      config: JSON.parse(await readFile(paths.config, "utf8")) as Record<string, any>,
      agentId,
      workspace: join(paths.workspaces, agentId),
    }),
  });
  // Declared outside the block so the failure path can stop a warmed child too.
  let warmed: Awaited<ReturnType<typeof warmLocalEmbeddings>> | undefined;
  try {
    const url = await api.listen(options.port);
    // A local embedding runtime is optional; without it the product stays text-only.
    let embeddings: Awaited<ReturnType<typeof discoverLocalEmbeddings>>;
    if (options.localEmbeddings !== false && !existingConfig) {
      // Resources shipped with this app are used when the operator has not supplied
      // their own copies under the data directory.
      const bundledRoot = fileURLToPath(new URL("../../../../local-memory/", import.meta.url));
      embeddings = await discoverLocalEmbeddings(paths.state, await freeLoopbackPort(), { bundledRoot });
      if (embeddings) {
        warmed = await warmLocalEmbeddings(embeddings);
        // An unwarmed service would stamp the first index as fts-only, so it is not wired.
        if (!warmed.ready) embeddings = undefined;
      }
    }
    const config = existingConfig ?? buildKernelConfig(paths, port, token, agents, options.connection, embeddings);
    const mcp = config.mcp as { apps?: { enabled?: boolean; sandboxPort?: number } } | undefined;
    config.mcp = {
      ...mcp, apps: {
        ...mcp?.apps, enabled: mcp?.apps?.enabled ?? true,
        sandboxPort: mcp?.apps?.sandboxPort ?? await freeLoopbackPort(),
      },
    };
    const plugins = config.plugins as {
      allow?: string[]; load?: { paths?: string[] }; entries?: Record<string, unknown>;
    } | undefined;
    const pluginRoot = fileURLToPath(new URL("../../../packages/kernel-runtime/native-plugin/", import.meta.url));
    const acp = options.acp;
    config.plugins = {
      ...plugins,
      ...(plugins?.allow ? { allow: [...new Set([...plugins.allow, "livingbot"])] } : {}),
      load: { ...plugins?.load, paths: [...new Set([...(plugins?.load?.paths ?? []), pluginRoot, ...(acp ? [acp.plugin] : [])])] },
      entries: {
        ...plugins?.entries,
        livingbot: {
          enabled: true, hooks: { allowConversationAccess: true },
          config: { endpoint: `${url}/api/kernel/conversation-context`, token: nativeToolToken },
        },
        ...(acp ? { acpx: { enabled: true, config: {
          agents: acp.agents,
          nativeAgents: { opencode: false, qwen: false, pi: false, kilocode: false, copilot: false },
          piSessionCatalog: { enabled: false }, agentProcessEnvAllow: [],
        } } } : {}),
      },
    };
    if (acp) {
      // Only the named executors may be delegated to; each keeps its own login.
      config.acp = { enabled: true, dispatch: { enabled: true }, backend: "acpx", allowedAgents: acp.allowed };
    }
    await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: existingConfig ? "w" : "wx" });
    await service.memories!.reconcileForgetOutcomes();
    await forgetting.assertNoUnfinishedOperations();
    await kernel.start();
    await new SystemSettings(service, workspaces, new OpenClawAgents(kernel)).ensureSystemAgent();
    return {
      paths, store, kernel, service, api, url, authPath,
      async close(): Promise<void> {
        // A pending sign-in holds native state; end it before the kernel stops.
        await authorizations.dispose();
        await api.close();
        await kernel.stop();
        // Only a service this process started is stopped; the kernel owns the rest.
        stopLocalEmbeddings(warmed);
        service.detach();
        store.close();
      },
    };
  } catch (error) {
    await api.close().catch(() => {});
    await kernel.stop().catch(() => {});
    stopLocalEmbeddings(warmed);
    service.detach(); store.close();
    throw error;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    root: { type: "string" }, node: { type: "string" }, "kernel-entry": { type: "string" },
    "connection-file": { type: "string" }, port: { type: "string" },
    "web-root": { type: "string" }, "acp-config": { type: "string" },
  } });
  if (!values["kernel-entry"]) throw new Error("--kernel-entry must identify an initialized official OpenClaw installation");
  const connection = values["connection-file"]
    ? await existingJson(resolve(values["connection-file"])) as ModelConnection | undefined : undefined;
  const acp = values["acp-config"]
    ? acpExecutors(await existingJson(resolve(values["acp-config"])))
    : undefined;
  const app = await launchWorkbench({
    root: values.root, nodeExecutable: values.node ?? process.execPath,
    kernelEntry: resolve(values["kernel-entry"]), connection,
    port: values.port ? Number(values.port) : undefined,
    webRoot: values["web-root"] ? resolve(values["web-root"]) : undefined,
    acp,
  });
  console.log(JSON.stringify({ url: app.url, authenticationFile: app.authPath }));
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void app.close().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
