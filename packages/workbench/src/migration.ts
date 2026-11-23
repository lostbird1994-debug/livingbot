import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentRegistration } from "../../kernel-runtime/src/agents.ts";
import type { Bot } from "./contracts.ts";
import type { MigrationInventory } from "./migration-inventory.ts";
import { inspectMigrationWorkspace } from "./migration-inventory.ts";
import { createMigrationBackup, readMigrationBackupFile, verifyMigrationBackup } from "./migration-backup.ts";
import type { WorkbenchStore } from "./store.ts";
import { Workspaces, workspaceInstructions } from "./workspaces.ts";

export type MigrationPreview = {
  id: string; name: string; description: string; identity: string; agentId: string; botId: string;
  source: string; createdAt: number; inventory: MigrationInventory;
  state: "preview" | "backing-up" | "copying" | "registering" | "ready" | "failed";
  backup?: string; workspace?: string; error?: string; copied?: number;
  projections?: { source: string; target: string; format: "markdown" | "structured" }[];
  color?: string;
  sourceIdentity?: string;
  sourceExclusions?: { path: string; reason: string }[];
};

export type MigrationBundle = {
  format: "livingbot-migration-v1";
  bots: {
    sourceIdentity: string; source: string; name: string; description?: string; identity?: string; color?: string;
    sourceExclusions?: { path: string; reason: string }[];
  }[];
};

function key(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid migration identity");
  return `migration:${id}`;
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

async function copyVerified(workspace: string, path: string, bytes: Buffer): Promise<void> {
  const target = resolve(workspace, path);
  if (!within(workspace, target) || target === workspace) throw new Error("Import file escaped workspace");
  let parent = workspace;
  for (const component of relative(workspace, dirname(target)).split(sep).filter(Boolean)) {
    parent = join(parent, component);
    await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Import parent is not a regular directory");
  }
  let file;
  try {
    file = await open(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    file = await open(target, constants.O_RDWR | constants.O_NOFOLLOW);
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > bytes.length) {
      throw new Error("Imported file differs from its verified backup; existing content retained");
    }
    const prefix = await file.readFile();
    if (prefix.length !== metadata.size || !bytes.subarray(0, prefix.length).equals(prefix)) {
      throw new Error("Imported file differs from its verified backup; existing content retained");
    }
    // The operation owns this new workspace. After a crash, extend only an
    // exact verified prefix, never overwrite or truncate existing bytes.
    let offset = prefix.length;
    while (offset < bytes.length) {
      const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, offset);
      if (!bytesWritten) throw new Error("Import write made no progress; partial file retained");
      offset += bytesWritten;
    }
    await file.sync();
    const verified = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await verified.stat();
      if (current.ino !== metadata.ino || current.dev !== metadata.dev || current.size !== bytes.length ||
        current.nlink !== 1 || digest(await verified.readFile()) !== digest(bytes)) {
        throw new Error("Import copy verification failed; existing content retained");
      }
    } finally { await verified.close(); }
  } finally { await file.close(); }
}

/** Explicit user workflow. Preparation and retries never change the old workspace. */
export class Migrations {
  private readonly store: WorkbenchStore;
  private readonly workspaces: Workspaces;
  private readonly backupRoot: string;
  private readonly registration: AgentRegistration;
  private readonly applying = new Map<string, Promise<MigrationPreview>>();

  constructor(input: { store: WorkbenchStore; workspaces: Workspaces; backupRoot: string; registration: AgentRegistration }) {
    this.store = input.store; this.workspaces = input.workspaces;
    this.backupRoot = input.backupRoot; this.registration = input.registration;
    if (!isAbsolute(input.backupRoot) || !isAbsolute(input.workspaces.root)) throw new Error("Migration paths must be absolute");
  }

  get(id: string): MigrationPreview {
    const record = this.store.get<MigrationPreview & { id: string }>("settings", key(id));
    if (!record) throw new Error("Unknown migration preview");
    return { ...record, id };
  }
  list(): MigrationPreview[] {
    return this.store.list<MigrationPreview>("settings")
      .filter((record) => /^migration:[a-f0-9-]{36}$/.test(record.id))
      .map((record) => ({ ...record, id: record.id.slice("migration:".length) }))
      .sort((left, right) => right.createdAt - left.createdAt);
  }
  private save(plan: MigrationPreview): MigrationPreview {
    return this.store.transaction(() => {
      this.store.put("settings", { ...plan, id: key(plan.id) });
      this.store.recordEvent("migration.changed", plan.id, plan);
      return plan;
    });
  }
  async previewBundle(path: string): Promise<MigrationPreview[]> {
    if (!isAbsolute(path)) throw new Error("请选择迁移清单文件的完整路径");
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024 * 1024) {
      throw new Error("迁移清单必须是有效的 JSON 文件");
    }
    const bundle = JSON.parse(await readFile(path, "utf8")) as MigrationBundle;
    if (bundle.format !== "livingbot-migration-v1" || !Array.isArray(bundle.bots) ||
        !bundle.bots.length || bundle.bots.length > 64) throw new Error("迁移清单格式不正确");
    const root = await realpath(dirname(path));
    const sources = new Set<string>();
    const selected = [];
    // Resolve the complete selection before persisting previews. No Bot is imported here.
    for (const bot of bundle.bots) {
      if (!bot || typeof bot.sourceIdentity !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(bot.sourceIdentity) || sources.has(bot.sourceIdentity) ||
          typeof bot.source !== "string" || bot.source.includes("\\") ||
          bot.source.split("/").some((part) => !part || part === "." || part === "..") || isAbsolute(bot.source)) {
        throw new Error("迁移清单中的伙伴或工作区无效");
      }
      const source = await realpath(resolve(root, bot.source));
      if (!within(root, source) || source === root) throw new Error("迁移工作区必须位于清单文件夹内");
      sources.add(bot.sourceIdentity);
      selected.push({ ...bot, source });
    }
    const previews = [];
    for (const bot of selected) previews.push(await this.preview(bot));
    return previews;
  }

  async preview(input: { source: string; name: string; description?: string; identity?: string; color?: string; sourceIdentity?: string; sourceExclusions?: { path: string; reason: string }[] }): Promise<MigrationPreview> {
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80) throw new Error("Enter a Bot name");
    if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 4000) ||
        input.identity !== undefined && (typeof input.identity !== "string" || input.identity.length > 32_000)) {
      throw new Error("Bot profile is invalid or too large");
    }
    if (input.color !== undefined && !["blue", "teal", "purple", "coral", "amber", "rose"].includes(input.color)) {
      throw new Error("Invalid Bot identity color");
    }
    if (input.sourceExclusions !== undefined && (!Array.isArray(input.sourceExclusions) ||
        input.sourceExclusions.length > 50_000 || input.sourceExclusions.some((item) =>
          !item || typeof item.path !== "string" || typeof item.reason !== "string" ||
          item.path.length > 4096 || item.reason.length > 4096))) throw new Error("Invalid excluded source inventory");
    if (input.sourceIdentity !== undefined) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.sourceIdentity)) throw new Error("Invalid migration source identity");
      const existing = this.list().find((plan) => plan.sourceIdentity === input.sourceIdentity);
      if (existing) {
        if (existing.source !== await realpath(input.source)) throw new Error("这个伙伴已有另一份迁移来源，请先查看导入记录");
        return existing;
      }
    }
    if (!isAbsolute(input.source)) throw new Error("Select an absolute source workspace");
    const source = await realpath(input.source);
    const target = await realpath(this.workspaces.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return resolve(this.workspaces.root);
    });
    if (within(source, target) || within(target, source)) throw new Error("Migration source must be outside managed workspaces");
    const inventory = await inspectMigrationWorkspace(source);
    const id = randomUUID();
    return this.save({
      id, botId: randomUUID(), agentId: `import-${id.replaceAll("-", "")}`,
      name: input.name.trim(), description: input.description ?? "", identity: input.identity ?? "",
      source, inventory, state: "preview", createdAt: Date.now(),
      ...(input.color ? { color: input.color } : {}),
      ...(input.sourceIdentity ? { sourceIdentity: input.sourceIdentity } : {}),
      ...(input.sourceExclusions?.length ? { sourceExclusions: input.sourceExclusions } : {}),
      projections: inventory.files.filter((file) => file.kind === "memory" && file.status === "verified").flatMap<NonNullable<MigrationPreview["projections"]>[number]>((file) => {
        if (file.path.startsWith(".rakazo/memory-archive/") && file.path.endsWith(".md")) return [{
          source: file.path, target: `memory/imported-${id}/archive/${file.path.slice(".rakazo/memory-archive/".length)}`, format: "markdown" as const,
        }];
        if (/\.(json|jsonl)$/.test(file.path)) return [{
          source: file.path, target: `memory/imported-${id}/structured/${file.path}.md`, format: "structured" as const,
        }];
        return [];
      }),
    });
  }

  apply(id: string, acknowledgeExclusions = false): Promise<MigrationPreview> {
    const existing = this.applying.get(id);
    if (existing) return existing;
    const plan = this.get(id);
    if (plan.state === "ready") return Promise.resolve(plan);
    const excluded = plan.inventory.files.some((file) => file.status === "symlink" || file.kind === "other") ||
      plan.inventory.omitted.length > 0 || Boolean(plan.sourceExclusions?.length);
    if (excluded && !acknowledgeExclusions) throw new Error("Review excluded sources before importing");
    const promise = this.perform(plan).finally(() => this.applying.delete(id));
    this.applying.set(id, promise);
    return promise;
  }

  private async perform(initial: MigrationPreview): Promise<MigrationPreview> {
    let plan = initial;
    try {
      if (!plan.backup) {
        plan = this.save({ ...plan, state: "backing-up", error: undefined });
        const backup = await createMigrationBackup(plan.inventory, this.backupRoot);
        plan = this.save({ ...plan, backup });
      }
      const manifest = await verifyMigrationBackup(plan.backup!);
      if (manifest.source !== plan.source) throw new Error("Backup source differs from preview");
      const workspace = join(this.workspaces.root, plan.agentId);
      if (this.store.list<Bot>("bots").some((bot) => bot.agentId === plan.agentId || bot.id === plan.botId)) {
        throw new Error("Import target already belongs to a Bot");
      }
      await mkdir(this.workspaces.root, { recursive: true, mode: 0o700 });
      const root = await realpath(this.workspaces.root);
      if (within(plan.source, root) || within(root, plan.source)) throw new Error("Import root overlaps its source");
      plan = this.save({ ...plan, workspace, state: "copying", error: undefined });
      const marker = join(workspace, ".livingbot-import.json");
      try {
        await mkdir(workspace, { mode: 0o700 });
        await writeFile(marker, JSON.stringify({ id: plan.id, backup: plan.backup }), { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await lstat(workspace)).isSymbolicLink() || !within(root, await realpath(workspace))) {
          throw new Error("Import workspace escaped its managed root");
        }
        const info = await lstat(marker);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Import ownership record is invalid");
        const owner = JSON.parse(await readFile(marker, "utf8"));
        if (owner.id !== plan.id || owner.backup !== plan.backup) throw new Error("Import workspace belongs to another operation");
      }
      for (const [index, entry] of manifest.files.entries()) {
        const original = await readMigrationBackupFile(plan.backup!, entry);
        const bytes = entry.path === "AGENTS.md"
          ? Buffer.concat([original, Buffer.from(
            `${plan.identity ? `\n\n# Imported Bot instructions\n\n${plan.identity}` : ""}\n\n${workspaceInstructions}`,
          )]) : original;
        await copyVerified(workspace, entry.path, bytes);
        for (const projection of plan.projections?.filter((item) => item.source === entry.path) ?? []) {
          const projected = projection.format === "markdown" ? original : Buffer.concat([
            Buffer.from(`# Imported structured memory\n\nSource: ${entry.path}\nSHA256: ${entry.sha256}\n\n`), original,
          ]);
          await copyVerified(workspace, projection.target, projected);
        }
        plan = this.save({ ...plan, copied: index + 1 });
      }
      if (plan.identity && !manifest.files.some((entry) => entry.path === "AGENTS.md")) {
        await copyVerified(workspace, "AGENTS.md", Buffer.from(
          `# Imported Bot instructions\n\n${plan.identity}\n\n${workspaceInstructions}`,
        ));
      }
      await this.workspaces.initialize(plan.agentId);
      plan = this.save({ ...plan, state: "registering" });
      await this.registration.ensure({ agentId: plan.agentId, workspace });
      return this.store.transaction(() => {
        this.store.createBot({
          id: plan.botId, agentId: plan.agentId, name: plan.name, description: plan.description, identity: plan.identity,
          ...(plan.color ? { color: plan.color } : {}),
        });
        this.store.privateConversation(plan.botId);
        return this.save({ ...plan, state: "ready", error: undefined });
      });
    } catch (error) {
      this.save({ ...plan, state: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}
