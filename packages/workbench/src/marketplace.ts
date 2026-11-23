import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import { join } from "node:path";
import type { WorkbenchStore } from "./store.ts";
import type { Bot } from "./contracts.ts";
import type { AgentRegistration } from "../../kernel-runtime/src/agents.ts";
import type { CapabilityProvider } from "../../kernel-runtime/src/capabilities.ts";
import type { Workspaces } from "./workspaces.ts";

export type PackageFile = { path: string; text: string };
export type BotPackage = {
  format: "livingbot-package-v1";
  id: string;
  kind: "bot" | "ability";
  name: string;
  description: string;
  version: string;
  license: string;
  author: string;
  permissions: string[];
  files: PackageFile[];
};
export type PackageSource = { repository: string; commit: string; path: string; blob: string };
export type PackagePreview = {
  id: string; digest: string; source: PackageSource; package: BotPackage; createdAt: number;
};
export type PackageInstallation = {
  id: string; previewId: string; digest: string; source: PackageSource; packageId: string;
  name: string; version: string; botId: string; agentId: string; kind: "bot" | "ability";
  state: "installing" | "ready" | "failed" | "revoking" | "revoked" | "restoring";
  skills: string[]; createdAt: number; error?: string;
};
export type PackageUpdate = {
  id: string; installationId: string; previous: PackageInstallation; previewId: string;
  digest: string; replaceIdentity: boolean; state: "applying" | "failed" | "ready";
  createdAt: number; identityBackup?: string; error?: string;
};
export type ShareableMethod = {
  id: string; name: string; files: { path: string; bytes: number }[];
  excluded: { path: string; reason: string }[];
};
export type PackageShare = { id: string; botId: string; package: BotPackage; digest: string; createdAt: number };
export type CatalogEntry = {
  id: string; name: string; description: string; kind: "bot" | "ability";
  repository: string; commit: string; path: string; tags: string[];
};
export type MarketCatalog = {
  id: string; source: PackageSource; name: string; entries: CatalogEntry[]; digest: string; createdAt: number;
};
export type CatalogSubmission = {
  id: string; catalogId: string; previewId: string; digest: string; entry: CatalogEntry;
  filename: string; issueUrl: string; state: "prepared"; createdAt: number;
};
export interface PackageRepository {
  read(input: { repository: string; ref?: string; path?: string }): Promise<{ source: PackageSource; bytes: Uint8Array }>;
}

const maxBytes = 512 * 1024;
export function packageDigest(value: BotPackage): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a package object");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).some((key) => !names.includes(key))) throw new Error("Unknown package field");
}
function text(value: unknown, limit: number, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) throw new Error(`Invalid package ${name}`);
  return value;
}
function packagePath(value: unknown): string {
  const path = text(value, 200, "path");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error("Invalid package path");
  }
  return path;
}
function repositoryName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/.test(value) ||
    [".", ".."].includes(value.split("/")[1]!)) {
    throw new Error("Enter a GitHub owner/repository");
  }
  return value;
}
function catalogIndex(value: unknown): { name: string; entries: CatalogEntry[] } {
  const input = record(value);
  fields(input, ["format", "name", "packages"]);
  if (input.format !== "livingbot-market-v1" || !Array.isArray(input.packages) || input.packages.length > 200) {
    throw new Error("Unsupported marketplace catalog");
  }
  const seen = new Set<string>();
  const entries = input.packages.map((value): CatalogEntry => {
    const entry = record(value);
    fields(entry, ["id", "name", "description", "kind", "repository", "commit", "path", "tags"]);
    const id = text(entry.id, 64, "catalog entry");
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(id) || seen.has(id)) throw new Error("Catalog package identities must be unique");
    seen.add(id);
    if (entry.kind !== "bot" && entry.kind !== "ability") throw new Error("Invalid catalog package kind");
    if (typeof entry.commit !== "string" || !/^[a-f0-9]{40}$/.test(entry.commit)) throw new Error("Catalog packages require a fixed commit");
    const path = packagePath(entry.path);
    if (!path.endsWith(".json")) throw new Error("Catalog entries must point to package JSON");
    if (!Array.isArray(entry.tags) || entry.tags.length > 10 ||
      entry.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 30) ||
      new Set(entry.tags).size !== entry.tags.length) throw new Error("Invalid catalog tags");
    return {
      id, kind: entry.kind, name: text(entry.name, 80, "catalog package name"),
      description: text(entry.description, 4000, "catalog package description"),
      repository: repositoryName(entry.repository), commit: entry.commit, path, tags: entry.tags as string[],
    };
  });
  return { name: text(input.name, 80, "catalog name"), entries };
}
function catalogDigest(index: { name: string; entries: CatalogEntry[] }): string {
  return createHash("sha256").update(JSON.stringify(index)).digest("hex");
}
function methodName(digest: string, original: string): string {
  return `lb-${digest.slice(0,8)}-${original.slice(0,32)}-${createHash("sha256").update(original).digest("hex").slice(0,6)}`;
}
/** Catalog tags stay a bounded, reviewed part of a submission rather than free text. */
function submissionTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) throw new Error("最多 10 个标签");
  const tags = value.map((tag) => {
    if (typeof tag !== "string" || !tag.trim() || tag.length > 30) throw new Error("每个标签需要 1–30 个字");
    return tag.trim();
  });
  if (new Set(tags).size !== tags.length) throw new Error("标签不能重复");
  return tags;
}
function methodDocument(path: string): boolean {
  try { packagePath(path); } catch { return false; }
  return /^skills\/[a-z][a-z0-9-]{1,63}\/(?:SKILL\.md|references\/[a-zA-Z0-9][a-zA-Z0-9._/-]*\.(?:md|txt))$/.test(path);
}

/** Only explicit public identity and selected method text enter this format. */
export function botPackage(value: unknown): BotPackage {
  const input = record(value);
  fields(input, ["format", "id", "kind", "name", "description", "version", "license", "author", "permissions", "files"]);
  if (input.format !== "livingbot-package-v1" || !["bot", "ability"].includes(String(input.kind))) throw new Error("Unsupported package format");
  const id = text(input.id, 64, "id");
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new Error("Invalid package id");
  const version = text(input.version, 80, "version");
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error("Invalid package version");
  if (!Array.isArray(input.permissions) || input.permissions.length > 30 ||
    input.permissions.some((item) => typeof item !== "string" || !item.trim() || item.length > 200) ||
    new Set(input.permissions).size !== input.permissions.length) throw new Error("Invalid package permissions");
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 50) throw new Error("Select 1–50 package files");
  const paths = new Set<string>();
  const files = input.files.map((item): PackageFile => {
    const file = record(item);
    fields(file, ["path", "text"]);
    const path = packagePath(file.path);
    // A package cannot carry memories, sessions, account settings, hooks or executables.
    if (!(input.kind === "bot" && path === "SOUL.md") &&
      !methodDocument(path)) {
      throw new Error("Only public Bot identity and method documents can be shared");
    }
    if (paths.has(path)) throw new Error("Duplicate package path");
    paths.add(path);
    return { path, text: text(file.text, 100_000, "document") };
  }).sort((left, right) => left.path.localeCompare(right.path));
  for (const file of files) {
    const skill = /^skills\/([^/]+)\//.exec(file.path)?.[1];
    if (skill && !paths.has(`skills/${skill}/SKILL.md`)) throw new Error("Method references require SKILL.md");
    if (file.path.endsWith("/SKILL.md")) {
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(file.text)?.[1];
      if (!header || !new RegExp(`^name: ${skill}$`, "m").test(header) ||
        !/^description: \S.+$/m.test(header)) throw new Error("Method document requires its exact name and description");
    }
  }
  if (input.kind === "bot" && !paths.has("SOUL.md")) throw new Error("A Bot package requires SOUL.md");
  const result: BotPackage = {
    format: "livingbot-package-v1", id, kind: input.kind as BotPackage["kind"],
    name: text(input.name, 80, "name"), description: text(input.description, 4000, "description"),
    version, license: text(input.license, 100, "license"), author: text(input.author, 120, "author"),
    permissions: [...input.permissions] as string[], files,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new Error("Package exceeds 512 KB");
  return result;
}

/** Public Git objects only. Branches resolve once; all later reads use exact hashes. */
export class GitHubPackages implements PackageRepository {
  private readonly fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = fetch) { this.fetcher = fetcher; }

  private async readJson(path: string, limit = 1024 * 1024): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`https://api.github.com${path}`, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub package read failed (${response.status})`);
    if (!response.body) throw new Error("Empty GitHub response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) throw new Error("GitHub response exceeds package limits");
      chunks.push(chunk);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }

  async read(input: { repository: string; ref?: string; path?: string }): Promise<{ source: PackageSource; bytes: Uint8Array }> {
    repositoryName(input.repository);
    const path = packagePath(input.path ?? "livingbot.json");
    if (!path.endsWith(".json")) throw new Error("Select a LivingBot JSON package");
    const ref = input.ref ?? "HEAD";
    if (typeof ref !== "string" || !ref || ref.length > 200 || /[\u0000-\u001f]/.test(ref)) throw new Error("Invalid repository revision");
    const base = `/repos/${input.repository}`;
    const commit = await this.readJson(`${base}/commits/${encodeURIComponent(ref)}`);
    const sha = text(commit.sha, 40, "commit");
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid GitHub commit");
    const tree = record(record(commit.commit).tree);
    let treeId = text(tree.sha, 40, "tree");
    if (!/^[a-f0-9]{40}$/.test(treeId)) throw new Error("Invalid GitHub tree");
    const parts = path.split("/");
    let blob = "";
    for (const [index, part] of parts.entries()) {
      const directory = await this.readJson(`${base}/git/trees/${treeId}`);
      if (directory.sha !== treeId || directory.truncated !== false || !Array.isArray(directory.tree)) throw new Error("Incomplete GitHub package tree");
      const matches = directory.tree.map(record).filter((entry) => entry.path === part);
      if (matches.length !== 1) throw new Error("Package file not found");
      const entry = matches[0]!;
      if (!/^[a-f0-9]{40}$/.test(String(entry.sha))) throw new Error("Invalid GitHub object");
      if (index < parts.length - 1) {
        if (entry.type !== "tree" || entry.mode !== "040000") throw new Error("Package path contains a link or non-directory");
        treeId = String(entry.sha);
      } else {
        if (entry.type !== "blob" || entry.mode !== "100644" || !Number.isSafeInteger(entry.size) ||
          Number(entry.size) < 1 || Number(entry.size) > maxBytes) throw new Error("Package must be a bounded regular data file");
        blob = String(entry.sha);
      }
    }
    const data = await this.readJson(`${base}/git/blobs/${blob}`);
    if (data.sha !== blob || data.encoding !== "base64" || typeof data.content !== "string") throw new Error("Invalid GitHub package blob");
    const encoded = data.content.replace(/\s/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("Invalid package encoding");
    const bytes = Buffer.from(encoded, "base64");
    const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (!bytes.length || bytes.length > maxBytes || data.size !== bytes.length || actual !== blob) throw new Error("Package content integrity failed");
    return { source: { repository: input.repository, commit: sha, path, blob }, bytes };
  }
}

export class Marketplace {
  private readonly store: WorkbenchStore;
  private readonly repository: PackageRepository;
  private readonly installer?: {
    workspaces: Workspaces; registration: AgentRegistration; capabilities: CapabilityProvider;
    withChanges?<T>(botId: string, action: () => Promise<T>): Promise<T>;
  };
  private readonly installing = new Map<string, Promise<PackageInstallation>>();
  private readonly changing = new Map<string, { enabled: boolean; operation: Promise<PackageInstallation> }>();
  private readonly updating = new Map<string, Promise<PackageInstallation>>();
  constructor(store: WorkbenchStore, repository: PackageRepository,
    installer?: {
      workspaces: Workspaces; registration: AgentRegistration; capabilities: CapabilityProvider;
      withChanges?<T>(botId: string, action: () => Promise<T>): Promise<T>;
    }) {
    this.store = store; this.repository = repository; this.installer = installer;
  }

  async preview(input: { repository: string; ref?: string; path?: string }): Promise<PackagePreview> {
    const fetched = await this.repository.read(input);
    const bundle = botPackage(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fetched.bytes)));
    const preview: PackagePreview = {
      id: randomUUID(), digest: packageDigest(bundle), source: fetched.source, package: bundle, createdAt: Date.now(),
    };
    this.store.put("settings", { ...preview, id: `package-preview:${preview.id}` });
    return preview;
  }

  async readCatalog(input: { repository: string; ref?: string; path?: string }): Promise<MarketCatalog> {
    const fetched = await this.repository.read({ ...input, path: input.path ?? "livingbot-market.json" });
    const index = catalogIndex(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fetched.bytes)));
    const catalog: MarketCatalog = {
      id: randomUUID(), source: fetched.source, ...index, digest: catalogDigest(index), createdAt: Date.now(),
    };
    this.store.put("settings", { ...catalog, id: `market-catalog:${catalog.id}` });
    return catalog;
  }

  catalog(id: string): MarketCatalog {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid marketplace catalog identity");
    const catalog = this.store.get<MarketCatalog>("settings", `market-catalog:${id}`);
    if (!catalog) throw new Error("Marketplace catalog is unavailable");
    const index = catalogIndex({ format: "livingbot-market-v1", name: catalog.name, packages: catalog.entries });
    if (catalogDigest(index) !== catalog.digest) throw new Error("Marketplace catalog content changed");
    return { ...catalog, id };
  }

  catalogs(): MarketCatalog[] {
    const seen = new Set<string>();
    return this.store.list<MarketCatalog>("settings").filter((item) => item.id.startsWith("market-catalog:"))
      .sort((left, right) => right.createdAt - left.createdAt)
      .flatMap((item) => {
        const key = `${item.source.repository}/${item.source.path}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [this.catalog(item.id.slice("market-catalog:".length))];
      });
  }

  async previewCatalogEntry(catalogId: string, entryId: string): Promise<PackagePreview> {
    const catalog = this.catalog(catalogId);
    const entry = catalog.entries.find((item) => item.id === entryId);
    if (!entry) throw new Error("Unknown marketplace entry");
    const preview = await this.preview({ repository: entry.repository, ref: entry.commit, path: entry.path });
    if (preview.source.commit !== entry.commit || preview.package.id !== entry.id || preview.package.kind !== entry.kind) {
      throw new Error("Package differs from its catalog entry");
    }
    return preview;
  }

  prepareSubmission(input: { catalogId: string; previewId: string; digest: string; tags?: unknown }): CatalogSubmission {
    const catalog = this.catalog(input.catalogId);
    const preview = this.get(input.previewId);
    if (preview.digest !== input.digest) throw new Error("Review the exact hosted package before submission");
    const entry: CatalogEntry = {
      id: preview.package.id, name: preview.package.name, description: preview.package.description,
      kind: preview.package.kind, repository: preview.source.repository, commit: preview.source.commit,
      path: preview.source.path, tags: submissionTags(input.tags),
    };
    // Submission is prepared locally. The author reviews and submits on GitHub.
    catalogIndex({ format: "livingbot-market-v1", name: catalog.name, packages: [entry] });
    const query = new URLSearchParams({
      title: `${catalog.entries.some((item) => item.id === entry.id) ? "Update" : "Add"} ${entry.name}`,
      body: `Package inclusion request\n\nCatalog: ${catalog.source.path}\nCatalog revision: ${catalog.source.commit}\n\nPackage: ${entry.id}\nSource: https://github.com/${entry.repository}/blob/${entry.commit}/${entry.path}\n\nLicense: ${preview.package.license}\nAuthor: ${preview.package.author}`,
    });
    const submission: CatalogSubmission = {
      id: randomUUID(), catalogId: catalog.id, previewId: preview.id, digest: preview.digest, entry,
      filename: `${entry.id}.submission.json`,
      issueUrl: `https://github.com/${repositoryName(catalog.source.repository)}/issues/new?${query}`,
      state: "prepared", createdAt: Date.now(),
    };
    this.store.put("settings", { ...submission, id: `market-submission:${submission.id}` });
    return submission;
  }

  /** Prepared submissions survive the session, so the author can finish later. */
  submissions(): CatalogSubmission[] {
    return this.store.list<CatalogSubmission>("settings")
      .filter((item) => item.id.startsWith("market-submission:"))
      .map(({ id }) => this.submission(id.slice("market-submission:".length)))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  submission(id: string): CatalogSubmission {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("找不到这条收录申请");
    const item = this.store.get<CatalogSubmission>("settings", `market-submission:${id}`);
    if (!item) throw new Error("找不到这条收录申请");
    catalogIndex({ format: "livingbot-market-v1", name: "submission", packages: [item.entry] });
    return { ...item, id };
  }

  get(id: string): PackagePreview {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid package preview identity");
    const preview = this.store.get<PackagePreview>("settings", `package-preview:${id}`);
    if (!preview || packageDigest(botPackage(preview.package)) !== preview.digest) throw new Error("Package preview is unavailable or changed");
    return { ...preview, id };
  }

  installations(): PackageInstallation[] {
    return this.store.list<PackageInstallation>("settings").filter((record) => record.id.startsWith("package-installation:"));
  }

  install(input: { previewId: string; digest: string; botId?: string }): Promise<PackageInstallation> {
    if (!this.installer) throw new Error("Package installation is unavailable");
    const preview = this.get(input.previewId);
    if (input.digest !== preview.digest) throw new Error("Review the exact package before installation");
    if (preview.package.kind === "ability" && !input.botId) throw new Error("Select a Bot for this ability");
    if (preview.package.kind === "bot" && input.botId) throw new Error("Install a Bot package as a new Bot");
    const target = input.botId ? this.store.get<Bot>("bots", input.botId) : undefined;
    if (input.botId && !target) throw new Error("Unknown Bot");
    const identity = createHash("sha256").update(JSON.stringify([
      preview.source.repository, preview.source.path, preview.package.id, input.botId ?? preview.digest,
    ])).digest("hex");
    const id = `package-installation:${identity}`;
    if (this.updating.has(id) || this.unfinishedUpdate(id)) throw new Error("Complete the reviewed package update first");
    if (this.changing.has(id)) throw new Error("Package access is being changed; wait for confirmation");
    const existing = this.store.get<PackageInstallation>("settings", id);
    if (existing?.digest === preview.digest && existing.state === "ready") return Promise.resolve(existing);
    if (existing && existing.digest !== preview.digest) throw new Error("Review a version update before replacing an installed package");
    if (existing && ["revoked", "revoking", "restoring"].includes(existing.state)) {
      throw new Error("Use the installed package access control to resume this installation");
    }
    const pending = this.installing.get(id);
    if (pending) return pending;
    const installation: PackageInstallation = existing ?? {
      id, previewId: preview.id, digest: preview.digest, source: preview.source,
      packageId: preview.package.id, name: preview.package.name, version: preview.package.version,
      botId: target?.id ?? randomUUID(), agentId: target?.agentId ?? `market-${identity.slice(0,32)}`,
      kind: preview.package.kind, state: "installing", skills: [], createdAt: Date.now(),
    };
    const action = () => this.performInstall(installation, preview);
    const operation = (target && this.installer.withChanges ? this.installer.withChanges(target.id, action) : action())
      .finally(() => this.installing.delete(id));
    this.installing.set(id, operation);
    return operation;
  }

  /** Change only package-owned methods. Conversations, identity and files are retained. */
  setEnabled(id: string, enabled: boolean): Promise<PackageInstallation> {
    if (!this.installer) throw new Error("Package installation is unavailable");
    if (typeof enabled !== "boolean") throw new Error("Expected package access state");
    const current = this.store.get<PackageInstallation>("settings", id);
    if (!/^package-installation:[a-f0-9]{64}$/.test(id) || !current) throw new Error("Unknown package installation");
    if (this.updating.has(id) || this.unfinishedUpdate(id)) throw new Error("Complete the reviewed package update first");
    if (this.installing.has(id)) throw new Error("Wait for package installation to finish");
    const pending = this.changing.get(id);
    if (pending) {
      if (pending.enabled !== enabled) throw new Error("Wait for the current package access change");
      return pending.operation;
    }
    if (current.state === "installing" || current.state === "failed") throw new Error("Complete installation before changing package access");
    if ((current.state === "revoking" && enabled) || (current.state === "restoring" && !enabled)) {
      throw new Error("Retry the unfinished package access change first");
    }
    if (current.state === (enabled ? "ready" : "revoked")) return Promise.resolve(current);
    const action = () => this.changeAccess(current, enabled);
    const operation = (this.installer.withChanges ? this.installer.withChanges(current.botId, action) : action())
      .finally(() => this.changing.delete(id));
    this.changing.set(id, { enabled, operation });
    return operation;
  }

  updates(): PackageUpdate[] {
    return this.store.list<PackageUpdate>("settings").filter((record) => record.id.startsWith("package-update:"));
  }

  private unfinishedUpdate(id: string): PackageUpdate | undefined {
    return this.updates().find((update) => update.installationId === id && update.state !== "ready");
  }

  /** Explicit reviewed update of one existing installation, retaining its agent and private data. */
  update(input: { id: string; expectedDigest: string; previewId: string; digest: string; replaceIdentity: boolean }): Promise<PackageInstallation> {
    if (!this.installer) throw new Error("Package installation is unavailable");
    if (typeof input.replaceIdentity !== "boolean") throw new Error("Choose whether to update public identity");
    const current = this.store.get<PackageInstallation>("settings", input.id);
    if (!/^package-installation:[a-f0-9]{64}$/.test(input.id) || !current) throw new Error("Unknown package installation");
    const preview = this.get(input.previewId);
    if (preview.digest !== input.digest) throw new Error("Review the exact package update");
    if (preview.source.repository !== current.source.repository || preview.source.path !== current.source.path ||
      preview.package.id !== current.packageId || preview.package.kind !== current.kind) {
      throw new Error("An update must use the same package and repository");
    }
    const updateId = `package-update:${createHash("sha256").update(JSON.stringify([input.id, input.digest])).digest("hex")}`;
    const recorded = this.store.get<PackageUpdate>("settings", updateId);
    if (current.digest === input.digest && recorded?.state === "ready" &&
      recorded.previous.digest === input.expectedDigest) return Promise.resolve(current);
    if (current.digest !== input.expectedDigest || current.state !== "ready") throw new Error("Installed package changed; review its current version");
    if (preview.digest === current.digest || preview.package.version === current.version) throw new Error("Choose a different package version");
    if (this.installing.has(input.id) || this.changing.has(input.id)) throw new Error("Wait for the current package operation");
    const unfinished = this.unfinishedUpdate(input.id);
    if (unfinished && unfinished.id !== updateId) throw new Error("Retry the unfinished package update first");
    const pending = this.updating.get(input.id);
    if (pending) return pending;
    if (recorded?.identityBackup && recorded.replaceIdentity !== input.replaceIdentity) {
      throw new Error("Retry the reviewed identity update before changing its replacement choice");
    }
    const receipt: PackageUpdate = recorded ? { ...recorded, replaceIdentity: input.replaceIdentity } : {
      id: updateId, installationId: input.id, previous: current, previewId: preview.id,
      digest: preview.digest, replaceIdentity: input.replaceIdentity, state: "applying", createdAt: Date.now(),
    };
    // Durable intent precedes asynchronous work, including waiting for this Bot's admission lock.
    this.store.put("settings", { ...receipt, state: "applying" }, "marketplace.changed");
    const action = () => this.performUpdate(receipt, preview);
    const operation = (this.installer.withChanges ? this.installer.withChanges(current.botId, action) : action())
      .finally(() => this.updating.delete(input.id));
    this.updating.set(input.id, operation);
    return operation;
  }

  private async performUpdate(initial: PackageUpdate, preview: PackagePreview): Promise<PackageInstallation> {
    const { workspaces, registration } = this.installer!;
    let receipt = { ...initial, state: "applying" as PackageUpdate["state"] };
    const previous = receipt.previous;
    try {
      if (receipt.replaceIdentity && previous.kind === "bot") {
        const oldIdentity = this.get(previous.previewId).package.files.find((file) => file.path === "SOUL.md")!;
        const newIdentity = preview.package.files.find((file) => file.path === "SOUL.md")!;
        const actual = await workspaces.read(previous.agentId, "SOUL.md", maxBytes);
        const oldBytes = Buffer.from(oldIdentity.text);
        if (!actual.equals(oldBytes) && !(receipt.identityBackup && actual.equals(Buffer.from(newIdentity.text)))) {
          throw new Error("Bot identity was edited locally; retain it when updating this package");
        }
        const backup = `package-updates/${receipt.id.slice("package-update:".length)}/SOUL.md`;
        try { await workspaces.write(previous.agentId, "archive", backup, oldBytes); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        if (!(await workspaces.read(previous.agentId, `archive/${backup}`, maxBytes)).equals(oldBytes)) {
          throw new Error("Package identity backup verification failed");
        }
        receipt = { ...receipt, identityBackup: `archive/${backup}` };
        this.store.put("settings", receipt, "marketplace.changed");
      }
      const { workspace, skills } = await this.writeFiles(previous.agentId, preview.digest, preview.package, false);
      await registration.ensure({ agentId: previous.agentId, workspace });
      await this.installer!.capabilities.refreshMethods?.(previous.agentId);
      const sessionKey = `agent:${previous.agentId}:main`;
      for (const name of skills) await this.confirmMethod(previous.agentId, sessionKey, name, true);
      for (const name of previous.skills) {
        const anotherOwner = this.installations().some((item) => item.id !== previous.id &&
          item.agentId === previous.agentId && ["ready", "installing", "restoring"].includes(item.state) && item.skills.includes(name));
        if (!skills.includes(name) && !anotherOwner) await this.confirmMethod(previous.agentId, sessionKey, name, false);
      }
      if (receipt.identityBackup) {
        const oldBytes = await workspaces.read(previous.agentId, receipt.identityBackup, maxBytes);
        const newBytes = Buffer.from(preview.package.files.find((file) => file.path === "SOUL.md")!.text);
        const actual = await workspaces.read(previous.agentId, "SOUL.md", maxBytes);
        if (!actual.equals(newBytes)) {
          if (!actual.equals(oldBytes)) throw new Error("Bot identity changed during update; retained unchanged");
          const stage = `package-updates/${receipt.id.slice("package-update:".length)}/SOUL.md`;
          let staged: string;
          try { staged = await workspaces.write(previous.agentId, "profile", stage, newBytes); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            staged = join(workspace, "profile", stage);
          }
          if (!(await workspaces.read(previous.agentId, `profile/${stage}`, maxBytes)).equals(newBytes)) {
            throw new Error("Staged package identity verification failed");
          }
          if (!(await workspaces.read(previous.agentId, "SOUL.md", maxBytes)).equals(oldBytes)) {
            throw new Error("Bot identity changed during update; retained unchanged");
          }
          // Only this explicit reviewed update can replace identity, after verified backup.
          await rename(staged, join(workspace, "SOUL.md"));
          if (!(await workspaces.read(previous.agentId, "SOUL.md", maxBytes)).equals(newBytes)) throw new Error("Updated identity verification failed");
        }
      }
      return this.store.transaction(() => {
        const updated = this.save({
          ...previous, previewId: preview.id, digest: preview.digest, source: preview.source,
          name: preview.package.name, version: preview.package.version, skills, error: undefined,
        });
        this.store.put("settings", { ...receipt, state: "ready", error: undefined }, "marketplace.changed");
        return updated;
      });
    } catch (error) {
      this.store.put("settings", { ...receipt, state: "failed", error: "更新未完成，文件与备份已保留，请重试。" }, "marketplace.changed");
      throw error;
    }
  }

  private async confirmMethod(agentId: string, sessionKey: string, name: string, enabled: boolean): Promise<void> {
    const { capabilities } = this.installer!;
    const found = (await capabilities.read(agentId, sessionKey)).find((item) =>
      item.nativeKind === "skill" && item.nativeName === name);
    if (!found?.manageable) throw new Error("Package method access cannot yet be confirmed");
    await capabilities.setEnabled(agentId, found, enabled);
    const confirmed = (await capabilities.read(agentId, sessionKey)).find((item) =>
      item.nativeKind === "skill" && item.nativeName === name);
    if (!confirmed || confirmed.enabled !== enabled) throw new Error("Native package access has not been confirmed");
  }

  private async changeAccess(initial: PackageInstallation, enabled: boolean): Promise<PackageInstallation> {
    const sessionKey = `agent:${initial.agentId}:main`;
    const installation = this.save({ ...initial, state: enabled ? "restoring" : "revoking", error: undefined });
    try {
      for (const name of installation.skills) {
        // Identical immutable methods may be shared by separately reviewed sources.
        const anotherOwner = !enabled && this.installations().some((other) =>
          other.id !== initial.id && other.agentId === initial.agentId &&
          ["ready", "installing", "restoring"].includes(other.state) && other.skills.includes(name));
        if (anotherOwner) continue;
        await this.confirmMethod(initial.agentId, sessionKey, name, enabled);
      }
      return this.save({ ...installation, state: enabled ? "ready" : "revoked", error: undefined });
    } catch (error) {
      this.save({ ...installation, error: "能力变更未完成，请重试。" });
      throw error;
    }
  }

  private save(installation: PackageInstallation): PackageInstallation {
    const { error, ...record } = installation;
    return this.store.put("settings", { ...record, ...(error ? { error } : {}) }, "marketplace.changed");
  }

  private async performInstall(initial: PackageInstallation, preview: PackagePreview): Promise<PackageInstallation> {
    const { registration } = this.installer!;
    let installation = this.save({ ...initial, state: "installing", error: undefined });
    try {
      const { workspace, skills } = await this.writeFiles(initial.agentId, initial.digest, preview.package, true);
      installation = this.save({ ...installation, skills });
      await registration.ensure({ agentId: initial.agentId, workspace });
      await this.installer!.capabilities.refreshMethods?.(initial.agentId);
      const sessionKey = `agent:${initial.agentId}:main`;
      for (const name of installation.skills) await this.confirmMethod(initial.agentId, sessionKey, name, true);
      return this.store.transaction(() => {
        if (initial.kind === "bot" && !this.store.get<Bot>("bots", initial.botId)) {
          this.store.createBot({ id: initial.botId, agentId: initial.agentId, name: preview.package.name, description: preview.package.description });
          this.store.privateConversation(initial.botId);
        }
        return this.save({ ...installation, state: "ready", error: undefined });
      });
    } catch (error) {
      this.save({ ...installation, state: "failed", error: "安装未完成；已保留文件，可重试。" });
      throw error;
    }
  }

  private async writeFiles(agentId: string, digest: string, bundle: BotPackage, includeIdentity: boolean): Promise<{ workspace: string; skills: string[] }> {
    const { workspaces } = this.installer!;
    const workspace = await workspaces.initialize(agentId);
    const names = new Map<string, string>();
    for (const file of bundle.files) {
      const original = /^skills\/([^/]+)\//.exec(file.path)?.[1];
      if (original) names.set(original, methodName(digest, original));
    }
    for (const file of bundle.files) {
      if (file.path === "SOUL.md" && !includeIdentity) continue;
      let path = file.path;
      let content = file.text;
      const skill = /^skills\/([^/]+)\//.exec(path)?.[1];
      if (skill) {
        path = path.replace(`skills/${skill}/`, `skills/${names.get(skill)}/`);
        if (file.path.endsWith("/SKILL.md")) content = content.replace(
          new RegExp(`^(name: )${skill}$`, "m"), `$1${names.get(skill)}`,
        );
      }
      const bytes = Buffer.from(content);
      if (path === "SOUL.md") {
        // Root identity writes are only for this newly allocated package Bot.
        try {
          const file = await open(join(workspace, path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!(await workspaces.read(agentId, path, maxBytes)).equals(bytes)) throw new Error("Existing Bot identity differs; retained unchanged");
        }
      } else {
        try { await workspaces.write(agentId, "skills", path.slice("skills/".length), bytes); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!(await workspaces.read(agentId, path, maxBytes)).equals(bytes)) throw new Error("Existing method differs; retained unchanged");
        }
      }
    }
    return { workspace, skills: [...names.values()] };
  }

  /** Explicit allowlisted content only; never scans a Bot workspace or its private data. */
  export(value: unknown): { package: BotPackage; digest: string; filename: string } {
    const bundle = botPackage(value);
    return { package: bundle, digest: packageDigest(bundle), filename: `${bundle.id}-${bundle.version}.livingbot.json` };
  }

  async shareableMethods(botId: string): Promise<ShareableMethod[]> {
    if (!this.installer) throw new Error("Workspace sharing is unavailable");
    const bot = this.store.get<Bot>("bots", botId);
    if (!bot) throw new Error("Unknown Bot");
    const files = await this.installer.workspaces.listFiles(bot.agentId, "skills");
    const groups = new Map<string, ShareableMethod>();
    const titles = new Map<string, string>();
    for (const installed of this.installations().filter((item) => item.botId === botId)) {
      const preview = this.get(installed.previewId);
      for (const file of preview.package.files) {
        const original = /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path)?.[1];
        if (original) titles.set(methodName(installed.digest, original), original);
      }
    }
    for (const file of files) {
      const name = /^skills\/([^/]+)\//.exec(file.path)?.[1];
      if (!name) continue;
      const group = groups.get(name) ?? { id: name, name: titles.get(name) ?? name, files: [], excluded: [] };
      groups.set(name, group);
      if (file.kind !== "file" || !methodDocument(file.path) || file.bytes > maxBytes) {
        group.excluded.push({ path: file.path, reason: file.kind !== "file" ? "不是普通文件" :
          file.bytes > maxBytes ? "超过分享大小限制" : "当前分享格式不支持此文件" });
      } else group.files.push({ path: file.path, bytes: file.bytes });
    }
    // References without a method entry must never look like an installable method.
    for (const group of groups.values()) {
      if (!group.files.some((file) => file.path === `skills/${group.id}/SKILL.md`)) {
        group.excluded.push(...group.files.map((file) => ({ path: file.path, reason: "缺少方法入口文件" })));
        group.files = [];
      }
    }
    return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async prepareShare(input: { botId: string; metadata: unknown; paths: string[]; identity?: string }): Promise<PackageShare> {
    if (!this.installer) throw new Error("Workspace sharing is unavailable");
    const bot = this.store.get<Bot>("bots", input.botId);
    if (!bot) throw new Error("Unknown Bot");
    const metadata = record(input.metadata);
    fields(metadata, ["id", "kind", "name", "description", "version", "license", "author", "permissions"]);
    if (!Array.isArray(input.paths) || input.paths.length > 50 ||
      input.paths.some((path) => typeof path !== "string" || !methodDocument(path)) ||
      new Set(input.paths).size !== input.paths.length) throw new Error("Select distinct method documents");
    if (metadata.kind !== "bot" && input.identity !== undefined) throw new Error("An ability does not include Bot identity");
    const allowed = new Set((await this.shareableMethods(bot.id)).flatMap((method) => method.files.map((file) => file.path)));
    const selected: PackageFile[] = [];
    let bytes = 0;
    for (const path of input.paths) {
      if (!allowed.has(path)) throw new Error("Refresh the selected Bot's shareable files");
      const content = await this.installer.workspaces.read(bot.agentId, path, maxBytes);
      bytes += content.length;
      if (bytes > maxBytes) throw new Error("Package exceeds 512 KB");
      selected.push({ path, text: new TextDecoder("utf-8", { fatal: true }).decode(content) });
    }
    if (metadata.kind === "bot") selected.push({ path: "SOUL.md", text: text(input.identity, 100_000, "public identity") });
    const bundle = botPackage({ ...metadata, format: "livingbot-package-v1", files: selected });
    const share: PackageShare = { id: randomUUID(), botId: bot.id, package: bundle, digest: packageDigest(bundle), createdAt: Date.now() };
    this.store.put("settings", { ...share, id: `package-share:${share.id}` });
    return share;
  }

  share(id: string): PackageShare {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid share identity");
    const share = this.store.get<PackageShare>("settings", `package-share:${id}`);
    if (!share || packageDigest(botPackage(share.package)) !== share.digest) throw new Error("Share content is unavailable or changed");
    return { ...share, id };
  }

  exportShare(id: string, digest: string): ReturnType<Marketplace["export"]> {
    const share = this.share(id);
    if (share.digest !== digest) throw new Error("Review the exact share content before downloading");
    return this.export(share.package);
  }

  prepareUpload(input: { id: string; digest: string; repository: string; ref: string }): { url: string; filename: string; repository: string; ref: string } {
    const exported = this.exportShare(input.id, input.digest);
    const repository = repositoryName(input.repository);
    const ref = text(input.ref, 200, "upload branch");
    if (/[\u0000-\u001f]/.test(ref)) throw new Error("Invalid upload branch");
    return { url: `https://github.com/${repository}/upload/${encodeURIComponent(ref)}`, filename: exported.filename, repository, ref };
  }
}
