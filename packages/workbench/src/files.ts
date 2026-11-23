import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, relative } from "node:path";
import { promisify } from "node:util";
import type { Artifact, Bot, Conversation, FilePage, Message, Task } from "./contracts.ts";
import { fileLimits } from "./contracts.ts";
import type { NativeAuthority } from "./authority.ts";
import { nativeTask } from "./authority.ts";
import type { WorkbenchStore } from "./store.ts";
import type { Workspaces } from "./workspaces.ts";
import { applyAnchoredRevision, assertRevisionBase } from "./revision.ts";
import type { RevisionReceipt } from "./revision.ts";

export const maxFileBytes = fileLimits.bytes;
export const maxAttachments = fileLimits.attachments;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const textMediaTypes: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain",
  ".csv": "text/csv", ".json": "application/json", ".html": "text/html", ".xml": "application/xml",
};

/** The revised passage, its immutable new version, and the exact base it came from. */
export type RevisionResult = {
  artifact: Artifact;
  passage: RevisionReceipt;
  source: { relativePath: string; digest: string; bytes: number };
};

export class Files {
  private readonly store: WorkbenchStore;
  private readonly workspaces: Workspaces;
  private readonly writes = new Map<string, Promise<Artifact>>();

  constructor(store: WorkbenchStore, workspaces: Workspaces) {
    this.store = store; this.workspaces = workspaces;
  }

  async attach(input: {
    id: string; botId: string; conversationId: string; name: string; mediaType: string; bytes: Uint8Array;
  }): Promise<Artifact> {
    this.store.engineSessionKey(input.conversationId, input.botId);
    return this.persist({ ...input, origin: "attachment" });
  }

  list(botId: string, before?: string): FilePage {
    const page = this.store.artifactPage(botId, before);
    return { ...page, files: page.files.map(({ path: _path, ...file }) => file) };
  }

  /** The original product's space listing, backed by immutable native deliveries. */
  listSpace(input: { botId?: string; cursor?: string; limit?: number } = {}): {
    files: Omit<Artifact, "path">[]; next?: string;
  } {
    const limit = input.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 60) throw new Error("Invalid file page size");
    const files = this.store.list<Artifact>("artifacts", -1)
      .filter((file) => !file.trashedAt && (!input.botId || file.botId === input.botId))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    const start = input.cursor ? files.findIndex((file) => file.id === input.cursor) + 1 : 0;
    if (input.cursor && start === 0) throw new Error("Invalid file cursor");
    const page = files.slice(start, start + limit);
    return {
      files: page.map(({ path: _path, recoveryPath: _recovery, ...file }) => file),
      ...(start + limit < files.length ? { next: page.at(-1)!.id } : {}),
    };
  }

  /** Reuse the 1.0 open/reveal behavior, restricted to a verified owned file. */
  async action(id: string, action: "open" | "reveal"): Promise<void> {
    if (process.platform !== "darwin") throw new Error("请下载文件后在本机打开");
    const { artifact } = await this.read(id);
    await promisify(execFile)("/usr/bin/open", action === "reveal" ? ["-R", artifact.path] : [artifact.path]);
  }

  async workspaceAction(agentId: string, filePath: string, action: "open" | "reveal"): Promise<void> {
    if (process.platform !== "darwin") throw new Error("请下载文件后在本机打开");
    const path = await this.workspaces.workspaceFile(agentId, filePath);
    await promisify(execFile)("/usr/bin/open", action === "reveal" ? ["-R", path] : [path]);
  }

  /** User-initiated removal keeps the immutable bytes in macOS Trash. */
  async trash(id: string): Promise<{ original: string; recovery: string }> {
    const prior = this.store.get<Artifact>("artifacts", id);
    if (prior?.trashedAt && prior.recoveryPath) return { original: prior.path, recovery: prior.recoveryPath };
    if (process.platform !== "darwin") throw new Error("无法使用 macOS 废纸篓，文件保持原位");
    const { artifact } = await this.read(id);
    const trash = join(homedir(), ".Trash");
    await mkdir(trash, { recursive: true, mode: 0o700 });
    const folder = await mkdtemp(join(trash, "LivingBot-file-"));
    const recovery = join(folder, artifact.name);
    await rename(artifact.path, recovery);
    this.store.put("artifacts", { ...artifact, trashedAt: Date.now(), recoveryPath: recovery });
    return { original: artifact.path, recovery };
  }

  private async persist(input: {
    id: string; botId: string; conversationId: string; taskId?: string;
    name: string; mediaType: string; bytes: Uint8Array; origin: "attachment" | "delivery";
    sourcePath?: string; supersedesId?: string;
    assertCurrent?: () => void;
  }): Promise<Artifact> {
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.id)) throw new Error("Invalid file identity");
    if (!input.name || input.name !== basename(input.name) || /[\\/\u0000-\u001f]/.test(input.name) ||
      input.name === "." || input.name === ".." || input.name.length > 240) throw new Error("Invalid file name");
    if (input.bytes.byteLength > maxFileBytes) throw new Error("File exceeds 25 MB");
    if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(input.mediaType)) throw new Error("Invalid file media type");
    const hash = digest(input.bytes);
    const prior = this.writes.get(input.id);
    if (prior) await prior;
    const existing = this.store.get<Artifact>("artifacts", input.id);
    if (existing) {
      if (existing.digest !== hash || existing.botId !== input.botId ||
        existing.conversationId !== input.conversationId || existing.name !== input.name ||
        existing.mediaType !== input.mediaType || existing.origin !== input.origin ||
        existing.taskId !== input.taskId) throw new Error("File identity conflicts with existing content");
      await this.read(existing.id);
      return existing;
    }
    const bot = this.store.get<Bot>("bots", input.botId);
    if (!bot) throw new Error("Unknown Bot");
    const operation = (async () => {
      const area = input.origin === "attachment" ? "inbox" : "tasks";
      const name = `${input.origin === "delivery" ? `${input.taskId}/deliveries/` : ""}${input.id}/${input.name}`;
      let path: string;
      try { path = await this.workspaces.write(bot.agentId, area, name, input.bytes); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        path = await this.workspaces.resolve(bot.agentId, area, name);
        if (digest(await this.workspaces.read(bot.agentId, `${area}/${name}`, maxFileBytes)) !== hash) {
          throw new Error("Existing file differs; it has been preserved");
        }
      }
      input.assertCurrent?.();
      this.store.engineSessionKey(input.conversationId, input.botId);
      return this.store.put<Artifact>("artifacts", {
        id: input.id, botId: bot.id, conversationId: input.conversationId, taskId: input.taskId,
        name: input.name, mediaType: input.mediaType, path, bytes: input.bytes.byteLength,
        digest: hash, origin: input.origin, createdAt: Date.now(),
        ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
        ...(input.supersedesId ? { supersedesId: input.supersedesId } : {}),
      });
    })();
    this.writes.set(input.id, operation);
    try { return await operation; }
    finally { if (this.writes.get(input.id) === operation) this.writes.delete(input.id); }
  }

  async read(id: string): Promise<{ artifact: Artifact; bytes: Buffer }> {
    const artifact = this.store.get<Artifact>("artifacts", id);
    const bot = artifact && this.store.get<Bot>("bots", artifact.botId);
    if (!artifact || !bot) throw new Error("Unknown file");
    if (artifact.trashedAt) throw new Error(`文件已移入废纸篓：${artifact.recoveryPath}`);
    const root = await this.workspaces.prepare(bot.agentId);
    const bytes = await this.workspaces.read(bot.agentId, relative(root, artifact.path), maxFileBytes);
    if (bytes.byteLength !== artifact.bytes || digest(bytes) !== artifact.digest) throw new Error("File integrity check failed");
    return { artifact, bytes };
  }

  validateAttachments(ids: string[], botId: string, conversationId: string): Artifact[] {
    if (ids.length > maxAttachments || new Set(ids).size !== ids.length) throw new Error("Select up to 10 distinct files");
    const files = ids.map((id) => {
      return this.store.attachment(id, botId, conversationId);
    });
    if (files.reduce((total, file) => total + file.bytes, 0) > maxFileBytes) throw new Error("Files exceed 25 MB per message");
    return files;
  }

  async deliver(input: NativeAuthority & { toolCallId: string; relativePath: string; name?: string; mediaType?: string }): Promise<Artifact> {
    const { bot, task } = nativeTask(this.store, input);
    if (!/^(tasks|projects)\//.test(input.relativePath) ||
      input.relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Deliver files from tasks/ or projects/");
    }
    const bytes = await this.workspaces.read(bot.agentId, input.relativePath, maxFileBytes);
    nativeTask(this.store, input);
    const id = createHash("sha256").update(`${input.runId}:${input.toolCallId}`).digest("hex");
    const artifact = await this.persist({
      id, botId: bot.id, taskId: task.id, conversationId: task.conversationId,
      name: input.name ?? basename(input.relativePath), mediaType: input.mediaType ?? "application/octet-stream",
      bytes, origin: "delivery", ...await this.deliverySource(bot, task, input.relativePath),
      assertCurrent: () => { nativeTask(this.store, input); },
    });
    nativeTask(this.store, input);
    this.announce(bot, task, artifact, input.runId);
    return artifact;
  }

  /**
   * Revise exactly one located passage of a UTF-8 document and keep the source
   * as it was: the revision lands in a new immutable delivered version, so no
   * user original is overwritten and unrelated bytes cannot drift.
   */
  async revise(input: NativeAuthority & {
    toolCallId: string; relativePath: string; anchor: string; replacement: string;
    expectedDigest?: string; name?: string;
  }): Promise<RevisionResult> {
    const { bot, task } = nativeTask(this.store, input);
    if (!/^(tasks|projects)\//.test(input.relativePath) ||
      input.relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Revise documents under tasks/ or projects/");
    }
    const bytes = await this.workspaces.read(bot.agentId, input.relativePath, maxFileBytes);
    const source = bytes.toString("utf8");
    // Lossless decode is what makes "unrelated bytes survive" a checked fact.
    if (!Buffer.from(source, "utf8").equals(bytes)) throw new Error("Revise a UTF-8 text document");
    const sourceDigest = digest(bytes);
    if (input.expectedDigest !== undefined) {
      assertRevisionBase(source, input.expectedDigest, (text) => digest(Buffer.from(text, "utf8")));
    }
    nativeTask(this.store, input);
    const { text, receipt } = applyAnchoredRevision(source, input.anchor, input.replacement);
    const name = input.name ?? basename(input.relativePath);
    const id = createHash("sha256").update(`revise:${input.runId}:${input.toolCallId}`).digest("hex");
    const artifact = await this.persist({
      id, botId: bot.id, taskId: task.id, conversationId: task.conversationId, name,
      mediaType: textMediaTypes[extname(name).toLowerCase()] ?? "text/plain",
      bytes: Buffer.from(text, "utf8"), origin: "delivery", ...await this.deliverySource(bot, task, input.relativePath),
      assertCurrent: () => { nativeTask(this.store, input); },
    });
    nativeTask(this.store, input);
    this.announce(bot, task, artifact, input.runId);
    return {
      artifact, passage: receipt,
      source: { relativePath: input.relativePath, digest: sourceDigest, bytes: bytes.byteLength },
    };
  }

  private async deliverySource(bot: Bot, task: Task, sourcePath: string) {
    const absolute = join(await this.workspaces.prepare(bot.agentId), sourcePath);
    const previous = this.store.list<Artifact>("artifacts", -1).findLast((file) => file.botId === bot.id &&
      file.taskId === task.id && file.origin === "delivery" && (file.sourcePath === sourcePath || file.path === absolute));
    return { sourcePath, ...(previous ? { supersedesId: previous.id } : {}) };
  }

  /** Final deliverables belong to the same reply, even when the file arrives first. */
  private announce(bot: Bot, task: Task, artifact: Artifact, runId: string): void {
    this.store.transaction(() => {
      for (const conversationId of new Set([task.conversationId, task.reportConversationId])) {
        const destination = this.store.get<Conversation>("conversations", conversationId);
        if (!destination?.botIds.includes(bot.id)) throw new Error("Invalid delivery destination");
        const messageId = conversationId === task.conversationId ? `engine:${runId}` : `report:${task.id}`;
        const existing = this.store.get<Message>("messages", messageId);
        if (existing && (existing.runId !== runId || existing.botId !== bot.id)) throw new Error("Delivery reply ownership changed");
        const blocks = existing?.blocks.filter((block) => block.kind !== "file" ||
          (block.artifactId !== artifact.id && block.artifactId !== artifact.supersedesId)) ?? [];
        this.store.put<Message>("messages", {
          ...existing, id: messageId, conversationId, botId: bot.id, taskId: task.id, runId,
          role: "assistant", final: existing?.final ?? false,
          createdAt: existing?.createdAt ?? artifact.createdAt, updatedAt: Date.now(),
          blocks: [...blocks, { id: artifact.id, kind: "file", artifactId: artifact.id, name: artifact.name, mediaType: artifact.mediaType }],
        });
      }
    });
  }
}
