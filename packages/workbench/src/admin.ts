import { sharedCapabilitySnapshot, administratorCapabilityContext } from "./admin-capabilities.ts";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { memoryReference } from "../../kernel-runtime/src/memory.ts";
import type { NativeAuthority } from "./authority.ts";
import { nativeTask } from "./authority.ts";
import type { Bot, Task } from "./contracts.ts";
import type { WorkbenchService } from "./service.ts";
import { CONNECTION_CREDENTIAL_INSTRUCTIONS, SUPER_ADMIN_AGENT_ID } from "./system-policy.ts";
import type { Workspaces } from "./workspaces.ts";

const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
function text(input: unknown, limit = 4096): string {
  if (typeof input !== "string" || !input.trim() || input.length > limit)
    throw new Error("请检查管理员操作参数");
  return input;
}
export async function adminPath(root: string, name: string, create = false): Promise<string> {
  if (!name || isAbsolute(name) || name.includes("\\") || name.includes("\0"))
    throw new Error("只允许 Bot 工作区内的相对路径");
  const base = await realpath(root);
  const path = resolve(base, name);
  const rel = relative(base, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("路径越过 Bot 工作区");
  const parts = rel.split(sep);
  let current = base;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (create && i === parts.length - 1 && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error("管理员文件操作不跟随符号链接");
    if (i < parts.length - 1 && !info?.isDirectory()) throw new Error("目录不可用");
  }
  return path;
}
/** A host-authorized administrative surface, never granted by a model-supplied role. */
export class SuperAdministrator {
  private readonly writing = new Set<string>();
  private readonly service: WorkbenchService;
  private readonly workspaces: Workspaces;
  private readonly recoveryRoot: string;
  private readonly trashRoot: string;
  constructor(
    service: WorkbenchService,
    workspaces: Workspaces,
    recoveryRoot = join(dirname(workspaces.root), "admin-revisions"),
    trashRoot = join(homedir(), ".Trash"),
  ) {
    this.service = service;
    this.workspaces = workspaces;
    this.recoveryRoot = recoveryRoot;
    this.trashRoot = trashRoot;
  }
  async promptContext(input: NativeAuthority) {
    // Prompt construction can precede the product run mirror. This read-only
    // shared catalog is requested only by the authenticated native plugin.
    const bot = this.service.store.list<Bot>("bots", -1).find(item => item.agentId === input.agentId);
    if (!bot || bot.agentId !== SUPER_ADMIN_AGENT_ID || bot.archivedAt ||
        !input.runId || !input.sessionKey.startsWith(`agent:${SUPER_ADMIN_AGENT_ID}:`))
      throw new Error("只有超级管理员可以读取管理上下文");
    if (!this.service.abilities) throw new Error("共享能力清单不可用");
    const snapshot = sharedCapabilitySnapshot(await this.service.abilities.listShared());
    return { context: `${administratorCapabilityContext(snapshot)}\n${CONNECTION_CREDENTIAL_INSTRUCTIONS}`, revision: snapshot.revision };
  }
  async invoke(input: NativeAuthority & Record<string, unknown>) {
    const { bot: actor, task: parentTask } = nativeTask(this.service.store, input);
    if (actor.agentId !== SUPER_ADMIN_AGENT_ID || actor.archivedAt)
      throw new Error("只有超级管理员可以执行此操作");
    const operation = text(input.operation, 64);
    if (operation === "list_bots")
      return this.service.store.list<Bot>("bots", -1).map((bot) => ({
        id: bot.id,
        name: bot.name,
        agentId: bot.agentId,
        spaceId: bot.spaceId,
        archived: Boolean(bot.archivedAt),
        workspace: join(this.workspaces.root, bot.agentId),
      }));
    if (operation === "abilities") {
      if (!this.service.abilities) throw new Error("能力清单不可用");
      return sharedCapabilitySnapshot(await this.service.abilities.listShared());
    }
    if (operation === "skill_files" || operation === "read_skill") {
      const skills = await this.service.kernel.request<{
        skills: { skillKey: string; name: string; baseDir: string }[];
      }>("skills.status", { agentId: actor.agentId });
      const skill = skills.skills?.find(
        (item) => item.skillKey === input.skillKey || item.name === input.skillKey,
      );
      if (!skill?.baseDir || !isAbsolute(skill.baseDir)) throw new Error("未知能力来源");
      if (operation === "skill_files") return this.listDirectory(skill.baseDir, input.path);
      return this.read(
        await adminPath(skill.baseDir, typeof input.path === "string" ? input.path : "SKILL.md"),
      );
    }
    const target = this.service.store.get<Bot>("bots", text(input.botId));
    if (!target) throw new Error("未知 Bot");
    if (operation === "list_tasks")
      return this.service.store
        .list<Task>("tasks", -1)
        .filter((task) => task.botId === target.id)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 20)
        .map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          updatedAt: task.updatedAt,
          parentTaskId: task.parentTaskId,
        }));
    if (operation === "memory_search") {
      if (!this.service.memories) throw new Error("记忆服务不可用");
      return this.service.memories.search(target.id, { query: text(input.query), limit: 20 });
    }
    if (operation === "memory_get") {
      if (!this.service.memories) throw new Error("记忆服务不可用");
      return this.service.memories.get(target.id, memoryReference(input.reference));
    }
    if (
      parentTask.routine?.id.startsWith("capability-audit:") &&
      (operation === "delegate" ||
        operation === "trash_file" ||
        (operation === "write_file" &&
          (target.id !== actor.id ||
            typeof input.path !== "string" ||
            !input.path.startsWith("tasks/capability-audit/") ||
            input.path.split("/").includes(".."))))
    ) {
      throw new Error("能力审计只能读取资料和保存自己的审计报告");
    }
    if (operation === "delegate") {
      if (target.archivedAt) throw new Error("请先恢复归档 Bot 再分派任务");
      if (target.id === actor.id) throw new Error("不能向自己递归分派任务");
      return this.service.submit({
        submissionId: `admin-delegation:${actor.id}:${text(input.toolCallId)}`,
        botId: target.id,
        conversationId: this.service.store.privateConversation(target.id).id,
        message: `由超级管理员分派：

${text(input.message, 16000)}`,
        parentTaskId: parentTask.id,
        hiddenInput: true,
        queueMode: "followup",
      });
    }
    if (operation === "task_result") {
      const task = this.service.store.get<Task>("tasks", text(input.taskId));
      if (!task || task.botId !== target.id) throw new Error("任务不属于目标 Bot");
      return {
        task,
        messages: this.service.store
          .messages(task.conversationId)
          .filter((message) => message.taskId === task.id && message.final)
          .slice(-10),
      };
    }
    const base = join(this.workspaces.root, target.agentId);
    if (operation === "list_files") return this.listDirectory(base, input.path);
    const path = await adminPath(base, text(input.path), operation === "write_file");
    if (operation === "read_file") return this.read(path);
    if (operation === "file_info") return this.info(path);
    if (!["write_file", "trash_file"].includes(operation)) throw new Error("未知管理员操作");
    if (/\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm|journal))?$/i.test(path))
      throw new Error("资料库不能通过文件管理操作修改或移除");
    if (this.writing.has(path)) throw new Error("此文件正在修改，请重新读取后重试");
    this.writing.add(path);
    try {
      const current = await (operation === "trash_file" ? this.info(path) : this.read(path)).catch(
        (error: NodeJS.ErrnoException) => {
          if (
            operation === "write_file" &&
            error.code === "ENOENT" &&
            input.expectedDigest === null
          )
            return undefined;
          throw error;
        },
      );
      if ((current?.digest ?? null) !== input.expectedDigest)
        throw new Error("文件已变化，请重新读取后重试");
      if (operation === "trash_file") {
        const container = await mkdtemp(join(this.trashRoot, "LivingBot-admin-"));
        const recovery = join(container, path.split(sep).at(-1)!);
        await rename(path, recovery); // Failure never falls back to permanent removal.
        this.service.store.recordEvent("admin.file-trashed", actor.id, {
          targetBotId: target.id,
          original: path,
          recovery,
        });
        return { original: path, recovery };
      }
      if (typeof input.content !== "string" || Buffer.byteLength(input.content) > 1_000_000)
        throw new Error("文件内容超过限制");
      let recovery: string | undefined;
      if (current) {
        await mkdir(this.recoveryRoot, { recursive: true, mode: 0o700 });
        recovery = join(this.recoveryRoot, randomUUID());
        await copyFile(path, recovery, constants.COPYFILE_EXCL);
        if ((await this.read(recovery)).digest !== current.digest)
          throw new Error("修改前备份校验失败");
      }
      const file = await open(
        path,
        constants.O_WRONLY |
          constants.O_NOFOLLOW |
          (current ? 0 : constants.O_CREAT | constants.O_EXCL),
        0o600,
      );
      try {
        if (current) {
          const now = await this.read(path);
          if (now.digest !== current.digest) throw new Error("文件已变化，请重新读取");
        }
        const bytes = Buffer.from(input.content);
        await file.write(bytes, 0, bytes.length, 0);
        await file.truncate(bytes.length);
        await file.sync();
      } finally {
        await file.close();
      }
      this.service.store.recordEvent("admin.file-written", actor.id, {
        targetBotId: target.id,
        path,
        recovery,
      });
      return { path, digest: digest(Buffer.from(input.content)), recovery };
    } finally {
      this.writing.delete(path);
    }
  }
  private async info(path: string) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile()) throw new Error("只允许普通文件");
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < before.size) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - offset),
          offset,
        );
        if (!bytesRead) throw new Error("文件已变化，请重新读取");
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await file.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
        throw new Error("文件已变化，请重新读取");
      return { path, digest: hash.digest("hex"), bytes: before.size };
    } finally {
      await file.close();
    }
  }
  private async read(path: string) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 1_000_000)
        throw new Error("只支持不超过 1MB 的普通文本文件");
      const data = await file.readFile();
      if (data.includes(0)) throw new Error("不支持读取二进制文件");
      return { path, content: data.toString("utf8"), digest: digest(data) };
    } finally {
      await file.close();
    }
  }
  private async listDirectory(root: string, input: unknown) {
    const directory =
      typeof input === "string" && input ? await adminPath(root, input) : await realpath(root);
    const items = await readdir(directory, { withFileTypes: true });
    if (items.length > 1000) throw new Error("目录过大，请选择更具体的目录");
    return items.map((item) => ({
      name: item.name,
      kind: item.isSymbolicLink() ? "link" : item.isDirectory() ? "directory" : "file",
    }));
  }
}
