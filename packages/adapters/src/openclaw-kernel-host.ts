import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterContext, MemoryStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { moveNativePathToTrash } from "./desktop-workspace-cleanup.js";
import { connectOpenClawKernelSdk, NativeRunJournal } from "./openclaw-gateway.js";
import { nativeKernelScope, OpenClawAgentRuntime } from "./openclaw-kernel.js";
import { nativeSessionKey } from "./openclaw-native-driver.js";
import { stopOrphanedNativeSession } from "./openclaw-reconciler.js";
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
  const stopNativeOrphans = async (
    actor: Pick<AdapterContext, "spaceId" | "userId">, botId: string, threadId: string, before: number,
  ) => {
    const owner = { spaceId: actor.spaceId, userId: actor.userId };
    const entry = await registry.entry(botId, owner);
    const routines = await options.prisma.routine.findMany({ where: { botId, ...owner }, select: { id: true } });
    const sessions = [undefined, ...routines.map(routine => routine.id)].map(routineId =>
      nativeSessionKey(nativeKernelScope({ botId, threadId, routineId }, owner), entry.agentId));
    const pending: string[] = [];
    for (const session of sessions) {
      const owner = await store.read(`session-owner:${session}`);
      if (owner && owner.startedAt <= before && !["done", "failed", "cancelled"].includes(owner.status)) pending.push(session);
    }
    if (!pending.length) return;
    const peer = await connect({ ...owner, botId });
    try {
      for (const sessionKey of pending) {
        const status = await stopOrphanedNativeSession({ sessionKey, before, store, peer });
        if (status === "unconfirmed") throw new Error("Native cancellation remains unconfirmed");
      }
    } finally { peer.stop(); }
  };
  return { runtime, memory, botWorkspace, nativeContextPreview, registry, readWorkspaceFile,
    stopNativeOrphans, recovery: { store, connect } };
}
