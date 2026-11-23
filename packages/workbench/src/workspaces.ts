import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Artifact } from "./contracts.ts";

const areas = ["profile", "memory", "skills", "projects", "tasks", "shared", "inbox", "archive"] as const;
export type WorkspaceArea = typeof areas[number];
export type WorkspaceFile = { path: string; bytes: number; kind: "file" | "link" | "other" };

export const workspaceInstructions = `# LivingBot workspace

Keep work on this local computer and use these locations consistently:
- profile/: durable identity references and working preferences.
- memory/: durable notes with sources; keep private information scoped to its Bot.
- skills/: reusable methods and their reference files.
- projects/<project>/: ongoing project sources and materials.
- tasks/<task>/: current task work, intermediate files and completed deliverables.
- inbox/: original user attachments; preserve them unchanged.
- shared/: material explicitly shared for the current audience.
- archive/: retained completed work, moved only when the user asks.

OpenClaw's root AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md and MEMORY.md
are native identity and memory files; preserve their supported locations.
Avoid creating loose output files at the workspace root. Use a short descriptive
project or task folder and stable filenames; preserve existing files on conflict.
Deliver completed files with livingbot_deliver_file so the user receives a real
preview/download card. A path in a message alone does not establish delivery.
Use livingbot_conversations to recall permitted conversation sources; never
infer access to another Bot's private conversations.

Never permanently delete user files, outputs, libraries, caches or fixtures.
When deletion is requested, move the exact selected item to macOS Trash and
report its original and recovery paths. If Trash is unavailable, stop and
explain. Never automatically migrate, replace, move or clean a production
database or another Bot's workspace.

用简体中文和用户交流，你自己的思考过程也必须用简体中文。
每次调用工具时，用一句简短的中文动宾短语说明你在做什么，例如「查看目录结构」「统计文件数量」。
这一句会直接显示在界面上，不要写英文，不要贴命令原文或 JSON。
`;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export class Workspaces {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async initialize(agentId: string): Promise<string> {
    const base = await this.prepare(agentId);
    try {
      const file = await open(join(base, "AGENTS.md"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(workspaceInstructions); } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await lstat(join(base, "AGENTS.md"));
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("Workspace instructions must be a regular file");
    }
    return base;
  }

  async prepare(agentId: string): Promise<string> {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(agentId)) throw new Error("Invalid agent identifier");
    const base = join(this.root, agentId);
    await mkdir(base, { recursive: true, mode: 0o700 });
    if ((await lstat(base)).isSymbolicLink()) throw new Error("Bot workspace is a symbolic link");
    const canonicalRoot = await realpath(this.root);
    if (!inside(canonicalRoot, await realpath(base))) throw new Error("Workspace escapes its root");
    for (const area of areas) {
      const dir = join(base, area);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if ((await lstat(dir)).isSymbolicLink()) throw new Error("Workspace area is a symbolic link");
      if (!inside(await realpath(base), await realpath(dir))) throw new Error("Workspace area escapes its root");
    }
    return base;
  }

  async resolve(agentId: string, area: WorkspaceArea, name: string): Promise<string> {
    if (!areas.includes(area)) throw new Error("Unknown workspace area");
    if (!name || isAbsolute(name) || name.includes("\0") || name.includes("\\")) throw new Error("Invalid workspace path");
    const base = await this.prepare(agentId);
    const areaRoot = join(base, area);
    const path = resolve(areaRoot, name);
    if (!inside(areaRoot, path) || path === areaRoot) throw new Error("Path escapes its workspace area");
    // Parents are created one level at a time, verifying each existing component
    // before descent rather than mkdir-recursing through a user-controlled link.
    const components = relative(areaRoot, dirname(path)).split(sep).filter(Boolean);
    let parent = areaRoot;
    for (const component of components) {
      parent = join(parent, component);
      await mkdir(parent, { mode: 0o700 }).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        if (!(await lstat(parent)).isDirectory()) throw new Error("Workspace parent is not a directory");
      });
      if (!inside(areaRoot, await realpath(parent))) throw new Error("Workspace parent is outside its area");
    }
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (existing?.isSymbolicLink()) throw new Error("Workspace file is a symbolic link");
    return path;
  }

  async write(agentId: string, area: WorkspaceArea, name: string, content: string | Uint8Array): Promise<string> {
    const path = await this.resolve(agentId, area, name);
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(content); } finally { await file.close(); }
    return path;
  }

  async artifact(input: {
    agentId: string; botId: string; conversationId: string; taskId?: string;
    name: string; content: Uint8Array; mediaType: string;
  }): Promise<Artifact> {
    if (input.content.byteLength > 100 * 1024 * 1024) throw new Error("File exceeds the delivery limit");
    const id = randomUUID();
    const name = basename(input.name);
    if (!name || name === "." || name === "..") throw new Error("Invalid file name");
    const path = await this.write(input.agentId, "tasks", `${input.taskId ?? "deliveries"}/${id}/${name}`, input.content);
    return {
      id, botId: input.botId, conversationId: input.conversationId, taskId: input.taskId,
      name, path, mediaType: input.mediaType, bytes: input.content.byteLength,
      digest: createHash("sha256").update(input.content).digest("hex"), createdAt: Date.now(),
    };
  }

  async copyInto(agentId: string, area: WorkspaceArea, name: string, source: string): Promise<string> {
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Only regular files can be imported");
    const target = await this.resolve(agentId, area, name);
    await copyFile(source, target, constants.COPYFILE_EXCL);
    if ((await stat(target)).size !== metadata.size) throw new Error("Imported file size mismatch");
    return target;
  }

  async read(agentId: string, name: string, maxBytes: number): Promise<Buffer> {
    if (!name || isAbsolute(name) || name.includes("\\") || name.includes("\0")) throw new Error("Invalid workspace path");
    const base = await this.prepare(agentId);
    const path = resolve(base, name);
    if (!inside(base, path) || path === base) throw new Error("Path escapes its workspace");
    let parent = base;
    for (const component of relative(base, path).split(sep)) {
      parent = join(parent, component);
      if ((await lstat(parent)).isSymbolicLink()) throw new Error("Workspace read follows a symbolic link");
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > maxBytes) throw new Error("File is not regular or exceeds the size limit");
      const buffer = Buffer.alloc(Math.min(metadata.size + 1, maxBytes + 1));
      let size = 0;
      for (;;) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > maxBytes || size === buffer.length) throw new Error("File changed or exceeds the size limit");
      }
      return buffer.subarray(0, size);
    } finally { await file.close(); }
  }

  /** Metadata only, without initializing a workspace or following directory links. */
  async listFiles(agentId: string, area: WorkspaceArea): Promise<WorkspaceFile[]> {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(agentId) || !areas.includes(area)) throw new Error("Invalid workspace scope");
    const base = join(this.root, agentId);
    const root = join(base, area);
    try {
      if ((await lstat(base)).isSymbolicLink() || (await lstat(root)).isSymbolicLink()) throw new Error("Workspace inventory follows a symbolic link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (!inside(await realpath(this.root), await realpath(base))) throw new Error("Workspace escapes its root");
    const files: WorkspaceFile[] = [];
    let entries = 0;
    const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
      if (depth > 12) throw new Error("Workspace inventory exceeds the directory depth limit");
      if ((await lstat(directory)).isSymbolicLink() || !inside(root, await realpath(directory))) {
        throw new Error("Workspace inventory follows a symbolic link");
      }
      for (const entry of (await readdir(directory)).sort()) {
        if (++entries > 1000) throw new Error("Workspace inventory exceeds the entry limit");
        const path = prefix ? `${prefix}/${entry}` : entry;
        const metadata = await lstat(join(directory, entry));
        if (metadata.isDirectory()) await visit(join(directory, entry), path, depth + 1);
        else files.push({
          path: `${area}/${path}`, bytes: metadata.size,
          kind: metadata.isSymbolicLink() ? "link" : metadata.isFile() ? "file" : "other",
        });
      }
    };
    await visit(root, "", 0);
    return files;
  }

  /** One directory in a Bot workspace, without following links or creating paths. */
  async listDirectory(agentId: string, directory = ""): Promise<{
    path: string; kind: "file" | "dir"; size: number;
  }[]> {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(agentId) ||
      directory.includes("\\") || directory.includes("\0") || isAbsolute(directory) ||
      directory.split("/").some((part) => part === "." || part === "..")) {
      throw new Error("Invalid workspace directory");
    }
    const base = join(this.root, agentId);
    const canonicalRoot = await realpath(this.root);
    const canonicalBase = await realpath(base).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!canonicalBase) return [];
    if (!inside(canonicalRoot, canonicalBase)) throw new Error("Workspace escapes its root");
    let current = canonicalBase;
    for (const part of directory.split("/").filter(Boolean)) {
      current = join(current, part);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("Invalid workspace directory");
      if (!inside(canonicalBase, await realpath(current))) throw new Error("Workspace escapes its root");
    }
    const result: { path: string; kind: "file" | "dir"; size: number }[] = [];
    const names = await readdir(current);
    if (names.length > 1000) throw new Error("Workspace directory exceeds the entry limit");
    for (const entry of names) {
      if (entry.startsWith(".")) continue;
      const metadata = await lstat(join(current, entry));
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) continue;
      result.push({
        path: directory ? `${directory}/${entry}` : entry,
        kind: metadata.isDirectory() ? "dir" : "file",
        size: metadata.isFile() ? metadata.size : 0,
      });
    }
    return result;
  }

  async workspaceFile(agentId: string, filePath: string): Promise<string> {
    if (filePath.includes("\\") || filePath.includes("\0") || isAbsolute(filePath) ||
      filePath.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Invalid workspace file");
    }
    const base = await this.prepare(agentId);
    const path = resolve(base, filePath);
    if (!inside(base, path) || path === base) throw new Error("Invalid workspace file");
    let parent = base;
    for (const component of relative(base, path).split(sep)) {
      parent = join(parent, component);
      if ((await lstat(parent)).isSymbolicLink()) throw new Error("Workspace file is a symbolic link");
    }
    const metadata = await lstat(path);
    if (!metadata.isFile()) throw new Error("Workspace item is not a regular file");
    return path;
  }
}
