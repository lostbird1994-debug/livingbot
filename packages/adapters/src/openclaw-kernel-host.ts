import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterContext, MemoryStore } from "@livingbot/adapter-kit";
import type { PrismaClient } from "@livingbot/db";
import { moveNativePathToTrash } from "./desktop-workspace-cleanup.js";
import { connectOpenClawKernelSdk, NativeRunJournal } from "./openclaw-gateway.js";
import { OpenClawAgentRuntime } from "./openclaw-kernel.js";
import { OpenClawKernelRegistry } from "./openclaw-kernel-registry.js";
import { OpenClawKernelProvisioner } from "./openclaw-kernel-provision.js";
import type { NativeBootstrapPreview } from "./openclaw-workspace-context.js";
import { OpenClawWorkspaceMemoryStore } from "./openclaw-workspace-memory.js";
import { OpenClawWorkspaceProfiles } from "./openclaw-workspace-profile.js";
import { readNativeWorkspaceBytes } from "./openclaw-workspace-attachments.js";

/** Only instantiated by a composition root explicitly configured to use the native engine. */
export function createOpenClawKernelHost(options: {
  dataDir: string;
  encryptionKey: string;
  prisma: PrismaClient;
  mirror: MemoryStore;
  notify(threadId: string, seq: number): Promise<void>;
}) {
  const registryFile = join(options.dataDir, "openclaw", "agents.json");
  const withLock = <T>(key: string, work: () => Promise<T>): Promise<T> =>
    options.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
      return work();
    }, { timeout: 30_000, maxWait: 30_000 });
  const provisioner = new OpenClawKernelProvisioner({
    prisma: options.prisma, dataDir: options.dataDir, registryFile, withLock,
  });
  const registry = new OpenClawKernelRegistry({
    manifestFile: registryFile, provisionBot: provisioner.provisionBot,
    prepareModel: provisioner.prepareModel,
  });
  const memory = new OpenClawWorkspaceMemoryStore({
    mirror: options.mirror, resolve: registry.resolveMemoryWorkspace, withLock, trash: moveNativePathToTrash,
  });
  const botWorkspace = new OpenClawWorkspaceProfiles({
    prisma: options.prisma, registry, withLock, notify: options.notify,
  });
  const store = new NativeRunJournal(join(options.dataDir, "openclaw", "runs"), options.encryptionKey);
  const runtime = new OpenClawAgentRuntime({
    store,
    resolveAgent: registry.resolveAgent,
  });
  const connect = async (run: { botId: string; spaceId: string; userId: string }) => {
    await registry.entry(run.botId, run);
    const config = JSON.parse(await readFile(join(homedir(), ".openclaw", "openclaw.json"), "utf8"));
    const port = config.gateway?.port;
    const token = config.gateway?.auth?.token;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== "string" || !token)
      throw new Error("Native engine connection is not configured");
    return connectOpenClawKernelSdk(`ws://127.0.0.1:${port}`, token, () => {});
  };
  let capabilities: { at: number; available: Promise<boolean> } | undefined;
  const independentTasksAvailable = async () => {
    if (capabilities && Date.now() - capabilities.at < 5000) return capabilities.available;
    const available = (async () => {
      const config = JSON.parse(await readFile(join(homedir(), ".openclaw", "openclaw.json"), "utf8"));
      if (config.agents?.defaults?.skipBootstrap !== true || !Number.isInteger(config.gateway?.port) || typeof config.gateway?.auth?.token !== "string") return false;
      const peer = await connectOpenClawKernelSdk(`ws://127.0.0.1:${config.gateway.port}`, config.gateway.auth.token, () => {});
      try {
        const result = await peer.request<{ managedSessions?: boolean; hostFileTools?: boolean; version?: number }>("rakazo.task.capabilities", {}, { timeoutMs: 3000 });
        return result.version === 1 && result.managedSessions === true && result.hostFileTools === true;
      } finally { peer.stop(); }
    })().catch(() => false);
    capabilities = { at: Date.now(), available };
    return available;
  };
  const nativeContextPreview = async (
    actor: Pick<AdapterContext, "spaceId" | "userId">, botId: string,
  ): Promise<NativeBootstrapPreview> => {
    const connection = await connect({ ...actor, botId });
    try {
      return await connection.request("rakazo.context.preview", { ...actor, botId });
    } finally { connection.stop(); }
  };
  const readWorkspaceFile = async (
    botId: string, filePath: string, maxBytes: number, actor: AdapterContext,
  ) => readNativeWorkspaceBytes((await registry.entry(botId, actor)).workspace, filePath, maxBytes);
  // No orphan sweep: every run owns its session, so a stop never has to confirm that
  // some earlier turn in a shared session has ended before the thread can be released.
  return { runtime, memory, botWorkspace, nativeContextPreview, independentTasksAvailable, registry, readWorkspaceFile,
    recovery: { store, connect } };
}
