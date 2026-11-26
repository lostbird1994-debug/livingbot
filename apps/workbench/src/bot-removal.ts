import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import type { Artifact, Bot, Task } from "../../../packages/workbench/src/contracts.ts";
import type { WorkbenchService } from "../../../packages/workbench/src/service.ts";
import type { Workspaces } from "../../../packages/workbench/src/workspaces.ts";
import { SUPER_ADMIN_AGENT_ID } from "../../../packages/workbench/src/system-policy.ts";

const inside = (root: string, path: string) => {
  const rel = relative(root, resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
};
async function exists(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
}
async function safeDirectory(path: string) {
  const info = await exists(path);
  if (info && (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path))
    throw new Error("Bot 目录归属不明确，未执行清理");
}
async function files(path: string): Promise<string[]> {
  const info = await exists(path);
  if (!info) return [];
  if (info.isSymbolicLink()) throw new Error("记忆中包含符号链接，未执行删除");
  if (info.isFile()) return [path];
  if (!info.isDirectory()) throw new Error("记忆文件类型不受支持");
  return (await Promise.all((await readdir(path)).map(name => files(join(path, name))))).flat();
}
const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
type Deletion = { id: string; botId: string; agentId: string; deleteMemories: boolean; workspace: string; state: string; nativeRetired?: boolean; completed?: boolean; memoryPath?: string; recoveryPaths?: { original: string; recovery: string }[] };

/** Reuses 1.0 destroyBot's order and memory choice through native lifecycle/storage adapters. */
export class BotRemoval {
  private readonly service: WorkbenchService;
  private readonly workspaces?: Workspaces;
  private readonly changing = new Set<string>();
  constructor(service: WorkbenchService, workspaces?: Workspaces) {
    this.service = service;
    this.workspaces = workspaces;
  }
  async remove(id: string, deleteMemories = false) {
    if (typeof deleteMemories !== "boolean") throw new Error("请选择是否删除记忆");
    if (!this.workspaces) throw new Error("本机工作区不可用");
    const { store, kernel } = this.service;
    const key = `bot-deletion:${id}`;
    const prior = store.get<Deletion>("settings", key);
    if (prior && prior.deleteMemories !== deleteMemories) throw new Error("删除已开始，请沿用原来的记忆选择");
    if (prior?.completed) return { ok: true as const };
    const bot = store.get<Bot>("bots", id);
    if (!bot) throw new Error("Bot 不存在");
    if (bot.agentId === SUPER_ADMIN_AGENT_ID) throw new Error("超级管理员不能删除");
    if (this.changing.has(id)) throw new Error("正在删除此 Bot，请稍后再试");
    this.changing.add(id);
    try {
      const config = await kernel.request<{ hash: string; config: any }>("config.get", {});
      if (config.config.agents?.defaults?.systemAgent?.agentId === bot.agentId)
        throw new Error("此 Bot 是原生内核的系统执行者，不能删除");
      if (config.config.agents?.defaults?.authInheritance?.agentId === bot.agentId)
        throw new Error("此 Bot 仍是授权继承来源，请先转交授权职责");
      const root = dirname(this.workspaces.root);
      const workspace = join(this.workspaces.root, bot.agentId);
      const state = join(root, "kernel-state", "agents", bot.agentId);
      const entry = config.config.agents?.entries?.[bot.agentId];
      if (!prior?.nativeRetired && entry?.workspace !== workspace) throw new Error("Bot 原生工作区与产品归属不一致");
      if (entry?.agentDir && !inside(state, entry.agentDir)) throw new Error("Bot 原生数据目录不在管理范围内");
      for (const [agentId, other] of Object.entries(config.config.agents?.entries ?? {}) as [string, any][])
        if (agentId !== bot.agentId && [other.workspace, other.agentDir].some(path => typeof path === "string" && (inside(workspace, path) || inside(state, path) || inside(path, workspace) || inside(path, state))))
          throw new Error("Bot 目录仍被其他 Bot 使用，未执行删除");
      await safeDirectory(workspace); await safeDirectory(state);
      const artifacts = store.list<Artifact>("artifacts", -1);
      if (artifacts.some(file => file.botId !== id && (inside(workspace, file.path) || inside(state, file.path))))
        throw new Error("其他 Bot 仍引用此目录中的文件，未执行删除");
      if (artifacts.some(file => file.botId === id && !inside(workspace, file.path) && !file.trashedAt))
        throw new Error("交付文件不在该 Bot 的管理目录中，请先核对归属");
      // Preflight retained memory before retiring native ownership.
      const listMemory = async () => deleteMemories ? [] : (await Promise.all(["memory", "MEMORY.md", "DREAMS.md"].map(name => files(join(workspace, name))))).flat();
      await listMemory();
      let saved: Deletion = prior ?? { id: key, botId: id, agentId: bot.agentId, deleteMemories, workspace, state };
      if (!saved.recoveryPaths) {
        const trash = join(homedir(), ".Trash");
        await safeDirectory(trash);
        if (!(await exists(trash))) throw new Error("废纸篓不可用，未执行删除");
        const recoveryRoot = await mkdtemp(join(trash, "LivingBot-bot-"));
        saved = { ...saved, recoveryPaths: [
          { original: workspace, recovery: join(recoveryRoot, "workspace") },
          { original: state, recovery: join(recoveryRoot, "native-state") },
        ] };
      }
      store.put("settings", saved);
      store.updateBot(id, { archivedAt: bot.archivedAt ?? Date.now() });
      for (const task of store.list<Task>("tasks", -1).filter(task => task.botId === id && ["queued", "running", "waiting"].includes(task.status)))
        await this.service.cancel(task.id);
      if (!saved.nativeRetired) {
        // Native deletion drains runs, removes cron/approvals/bindings and purges native session rows.
        // Keep filesystem cleanup here so all original files can be recovered from Trash.
        const result = await kernel.request<{ok?: boolean; purgeFailed?: boolean; failed?: unknown[]}>("agents.delete", { agentId: bot.agentId, deleteFiles: false }, { timeoutMs: 120000 });
        if (!result.ok || result.purgeFailed || result.failed?.length) throw new Error("原生 Bot 清理尚未完成，请重试");
        saved = { ...saved, nativeRetired: true }; store.put("settings", saved);
      }
      // Runs may have saved memory while draining. Read the final stable inventory.
      const memoryFiles = await listMemory();
      if (!deleteMemories && memoryFiles.length) {
        const sharedRoot = join(root, "shared-memory");
        const target = join(sharedRoot, "deleted-bots", id);
        await mkdir(sharedRoot, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if(error.code!=="EEXIST")throw error; });
        await safeDirectory(sharedRoot);
        await mkdir(dirname(target), { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if(error.code!=="EEXIST")throw error; });
        await safeDirectory(dirname(target));
        await mkdir(target, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if(error.code!=="EEXIST")throw error; });
        await safeDirectory(target);
        for (const source of memoryFiles) {
          const destination = join(target, relative(workspace, source));
          let parent=target;
          for(const part of relative(target,dirname(destination)).split("/").filter(Boolean)) {
            parent=join(parent,part);await mkdir(parent,{mode:0o700}).catch((error:NodeJS.ErrnoException)=>{if(error.code!=="EEXIST")throw error;});await safeDirectory(parent);
          }
          const priorFile=await exists(destination);
          if(priorFile) {
            if(!priorFile.isFile()||priorFile.isSymbolicLink()||await digest(source)!==await digest(destination)) throw new Error("共享记忆目标已变化，未覆盖");
          } else await copyFile(source, destination);
          if (await digest(source) !== await digest(destination)) throw new Error("共享记忆副本校验失败");
        }
        const current = await kernel.request<{hash: string; config: any}>("config.get", {});
        const extraPaths = current.config.memory?.search?.extraPaths ?? [];
        if (!extraPaths.some((path: unknown) => path === sharedRoot)) {
          await kernel.request("config.patch", {baseHash: current.hash, response:"summary", raw:JSON.stringify({memory:{search:{extraPaths:[...extraPaths,sharedRoot]}}})});
          const confirmed=await kernel.request<typeof current>("config.get",{});
          if (!confirmed.config.memory?.search?.extraPaths?.includes(sharedRoot)) throw new Error("共享记忆索引配置尚未确认");
        }
        saved={...saved,memoryPath:target}; store.put("settings",saved);
      }
      // The journal reserves destinations before native retirement so a retry
      // resumes partial moves instead of losing the original recovery locations.
      for (const entry of saved.recoveryPaths!) {
        if (![workspace, state].includes(entry.original) ||
          dirname(dirname(entry.recovery)) !== join(homedir(), ".Trash") ||
          !dirname(entry.recovery).startsWith(join(homedir(), ".Trash", "LivingBot-bot-")))
          throw new Error("Bot 废纸篓恢复路径不在应用管理范围内");
        await safeDirectory(dirname(entry.recovery));
        await safeDirectory(entry.original);
        const source = await exists(entry.original);
        const target = await exists(entry.recovery);
        if (source && target) throw new Error("废纸篓目标已存在，未覆盖");
        if (source) await rename(entry.original, entry.recovery);
        else if (target) await safeDirectory(entry.recovery);
      }
      for (const file of artifacts.filter(file => file.botId === id && file.trashedAt && file.recoveryPath)) {
        const path=file.recoveryPath!;
        const trash = join(homedir(), ".Trash");
        if (!inside(trash, path) || !relative(trash, path).startsWith("LivingBot-file-") || dirname(path) === trash)
          throw new Error("废纸篓文件不在应用管理范围内");
        await safeDirectory(dirname(path));
        if (artifacts.some(other=>other.botId!==id&&(other.path===path||other.recoveryPath===path))) continue;
        const info=await exists(path);
        if(info) { if(!info.isFile()||info.isSymbolicLink()||await digest(path)!==file.digest) throw new Error("废纸篓文件归属校验失败"); }
      }
      store.purgeBotData(id);
      store.put("settings",{...saved,completed:true});
      return {ok:true as const};
    } finally { this.changing.delete(id); }
  }
}
