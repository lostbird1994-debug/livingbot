import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { mkdir, mkdtemp, open, readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { validateAgentId } from "./config.ts";
import { runtimeEnvironment } from "./paths.ts";
import type { RuntimePaths } from "./paths.ts";
import { createRecoverySnapshot, restoreRecoverySnapshot, verifyRecoverySnapshot } from "./recovery-snapshot.ts";
import type { RecoverableFileReceipt } from "./recoverable-memory-files.ts";

export type MemoryForgetPreview = {
  agentId: string;
  dryRun: true;
  sessionIds: string[];
  sessionResolutions: { sessionId: string; sessionKey?: string; source: "live" | "archived" | "unresolved" }[];
  entryKeys: string[];
  mixedLineageEntryKeys: string[];
  untargetableEntryKeys: string[];
  curatedWrites: { relativePath: string; observedAt: string | number }[];
  artifacts: Record<string, number>;
  refusals: string[];
};

export interface MemoryForgetPreviewProvider {
  preview(agentId: string, sessions: string[]): Promise<MemoryForgetPreview>;
  prepare?(agentId: string, sessions: string[], expectedDigest: string): Promise<MemoryForgetRecovery>;
  apply?(agentId: string, sessions: string[], expectedDigest: string, requestId?: string): Promise<MemoryForgetOutcome>;
  outcome?(agentId: string, sessions: string[], expectedDigest: string, requestId: string): Promise<MemoryForgetOutcome | undefined>;
  restore?(recoveryId: string): Promise<MemoryRestore>;
}
export type MemoryForgetOutcome = {
  id: string; status: "completed" | "recovery-required"; agentId: string; createdAt: number;
  recovery: MemoryForgetRecovery; files: RecoverableFileReceipt[];
  report?: Omit<MemoryForgetPreview, "dryRun"> & { dryRun: false };
  remaining?: MemoryForgetPreview; error?: string;
};
export type MemoryForgetRecovery = {
  id: string; createdAt: number; digest: string; previewDigest: string;
  files: number; bytes: number; scope: "kernel-and-selected-workspace";
};
/** A restored copy is an inspection target; activation stays a user action. */
export type MemoryRestore = {
  id: string; createdAt: number; target: string; files: number; bytes: number;
  source: string;
};
export function memoryPreviewDigest(report: MemoryForgetPreview): string {
  return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}

/**
 * Group the native counters into the scopes a user has to decide about, so the
 * report states what the operation covers instead of showing raw counter names.
 * Nothing here decides what the native command touches; it only restates it.
 */
export { memoryForgetScopeSummary } from "./memory-scopes.ts";
export type { MemoryForgetScopeId, MemoryForgetScope } from "./memory-scopes.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid memory forgetting preview");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\u0000-\u001f]/u.test(value)) {
    throw new Error("Invalid memory forgetting field");
  }
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100_000) throw new Error("Invalid memory forgetting list");
  return value.map(text);
}

export function memoryForgetPreview(value: unknown, agentId: string): MemoryForgetPreview {
  const result = record(value);
  if (result.agentId !== agentId || result.dryRun !== true) throw new Error("Memory forgetting preview ownership mismatch");
  if (!Array.isArray(result.sessionResolutions) || !Array.isArray(result.curatedWrites)) {
    throw new Error("Invalid memory forgetting provenance");
  }
  const artifacts: Record<string, number> = {};
  for (const key of [
    "memoryFiles", "memoryEntries", "memoryLines", "sessionCorpusFiles", "sessionCorpusLines",
    "indexChunks", "indexSources", "ftsRows", "vectorRows", "embeddingCacheRows",
    "shortTermEntries", "seenHashScopes", "backups", "originRows",
  ]) {
    const count = record(result.artifacts)[key];
    if (!Number.isSafeInteger(count) || Number(count) < 0) throw new Error("Invalid memory forgetting count");
    artifacts[key] = Number(count);
  }
  return {
    agentId, dryRun: true, sessionIds: strings(result.sessionIds),
    sessionResolutions: result.sessionResolutions.map((value) => {
      const item = record(value);
      if (item.source !== "live" && item.source !== "archived" && item.source !== "unresolved") {
        throw new Error("Invalid memory session resolution");
      }
      return {
        sessionId: text(item.sessionId), source: item.source,
        ...(item.sessionKey !== undefined ? { sessionKey: text(item.sessionKey) } : {}),
      };
    }),
    entryKeys: strings(result.entryKeys), mixedLineageEntryKeys: strings(result.mixedLineageEntryKeys),
    untargetableEntryKeys: strings(result.untargetableEntryKeys),
    curatedWrites: result.curatedWrites.map((value) => {
      const item = record(value);
      const relativePath = text(item.relativePath);
      if (isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.split("/").some((part) => part === ".." || !part)) {
        throw new Error("Invalid memory review path");
      }
      if (!(typeof item.observedAt === "string" && Number.isFinite(Date.parse(item.observedAt))) &&
        !(typeof item.observedAt === "number" && Number.isFinite(item.observedAt))) {
        throw new Error("Invalid memory review time");
      }
      return { relativePath, observedAt: item.observedAt as string | number };
    }),
    artifacts, refusals: strings(result.refusals),
  };
}

/** Official offline memory operations; workspace publication uses the public SDK. */
export class OpenClawMemoryForgetPreview implements MemoryForgetPreviewProvider {
  private readonly options: { nodeExecutable: string; entry: string; paths: RuntimePaths };
  constructor(options: { nodeExecutable: string; entry: string; paths: RuntimePaths }) {
    if (!isAbsolute(options.nodeExecutable) || !isAbsolute(options.entry)) throw new Error("Kernel paths must be absolute");
    this.options = options;
  }

  async preview(agentId: string, sessions: string[]): Promise<MemoryForgetPreview> {
    validateAgentId(agentId);
    if (!Array.isArray(sessions) || !sessions.length || sessions.length > 20) throw new Error("Select 1–20 conversations");
    const selected = [...new Set(sessions.map(text))];
    if (selected.some((session) => !session.startsWith(`agent:${agentId}:`))) {
      throw new Error("Memory conversation ownership mismatch");
    }
    let stdout: string;
    try {
      ({ stdout } = await promisify(execFile)(this.options.nodeExecutable, [
        this.options.entry, "memory", "forget", "--agent", agentId,
        ...selected.flatMap((session) => ["--session", session]), "--dry-run", "--json",
      ], {
        cwd: this.options.paths.root, env: runtimeEnvironment(this.options.paths),
        timeout: 120_000, maxBuffer: 2_000_000, encoding: "utf8",
      }));
    } catch {
      // Child stderr can contain private file names or configuration diagnostics.
      throw new Error("Native memory preview failed; no forgetting was requested");
    }
    return memoryForgetPreview(JSON.parse(stdout), agentId);
  }

  /** Explicit user preparation; caller retains exclusive offline ownership. */
  async prepare(agentId: string, sessions: string[], expectedDigest: string): Promise<MemoryForgetRecovery> {
    if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error("Invalid memory preview digest");
    const report = await this.preview(agentId, sessions);
    if (memoryPreviewDigest(report) !== expectedDigest) throw new Error("Memory changed; review a new preview before creating its recovery copy");
    const path = await createRecoverySnapshot([
      // Official CLI shims and plugin method links are regenerated from the configured installation.
      { id: "kernel-state", path: this.options.paths.state, exclude: ["tmp", "plugin-skills"] },
      { id: "workspace", path: join(this.options.paths.workspaces, agentId) },
    ], join(this.options.paths.root, "memory-recovery"));
    const manifest = await verifyRecoverySnapshot(path);
    return {
      id: basename(path), createdAt: manifest.createdAt, digest: manifest.digest, previewDigest: expectedDigest,
      files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
      scope: "kernel-and-selected-workspace",
    };
  }

  /**
   * Materializes a reviewed recovery copy beside the live data without ever
   * writing into it. No kernel maintenance runs, so this is safe while the
   * product is in normal use.
   */
  async restore(recoveryId: string, target?: string): Promise<MemoryRestore> {
    if (!/^memory-recovery-[a-zA-Z0-9]+$/.test(recoveryId)) throw new Error("Invalid recovery copy");
    const source = join(this.options.paths.root, "memory-recovery", recoveryId);
    const destination = target ?? join(this.options.paths.root, "memory-restores", recoveryId);
    const restored = await restoreRecoverySnapshot(source, destination);
    return {
      id: basename(restored.target), createdAt: Date.now(), target: restored.target,
      files: restored.files, bytes: restored.bytes, source: basename(source),
    };
  }

  async assertNoUnfinishedOperations(): Promise<void> {
    const directory = join(this.options.paths.root, "memory-operations");
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of names) {
      if (!/^memory-forget-[a-zA-Z0-9]+$/.test(name)) throw new Error("Unknown memory operation requires review");
      let running = false;
      try { await readFile(join(directory, name, "running.json")); running = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!running) continue;
      const outcome = await readFile(join(directory, name, "outcome.json"), "utf8").then(
        (raw) => JSON.parse(raw) as MemoryForgetOutcome,
        (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; },
      );
      if (outcome?.status !== "completed") throw new Error("Interrupted memory maintenance requires explicit recovery before kernel startup");
    }
  }

  /** Read an exact durable request without invoking the native command again. */
  async outcome(agentId: string, sessions: string[], expectedDigest: string, requestId: string): Promise<MemoryForgetOutcome | undefined> {
    validateAgentId(agentId);
    if (!/^memory-forget-[a-zA-Z0-9-]{1,128}$/.test(requestId) || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
      throw new Error("Invalid forgetting request identity");
    }
    const directory = join(this.options.paths.root, "memory-operations");
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    let found: MemoryForgetOutcome | undefined;
    for (const name of names) {
      if (!/^memory-forget-[a-zA-Z0-9]+$/.test(name)) throw new Error("Unknown memory operation requires review");
      const operation = join(directory, name);
      const binding = await readFile(join(operation, "request.json"), "utf8").then(
        (raw) => record(JSON.parse(raw)),
        (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; },
      );
      if (binding?.requestId !== requestId) continue;
      if (binding.agentId !== agentId || binding.expectedDigest !== expectedDigest ||
        JSON.stringify(binding.sessions) !== JSON.stringify(sessions)) throw new Error("Forgetting request ownership changed");
      const running = await readFile(join(operation, "running.json")).then(
        () => true,
        (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; },
      );
      if (!running) continue;
      const result = await readFile(join(operation, "outcome.json"), "utf8").then(
        (raw) => JSON.parse(raw) as MemoryForgetOutcome,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") throw new Error("Interrupted memory maintenance requires explicit recovery");
          throw error;
        },
      );
      if (result.id !== name || result.agentId !== agentId ||
        !["completed", "recovery-required"].includes(result.status) ||
        result.recovery?.previewDigest !== expectedDigest) throw new Error("Invalid durable forgetting outcome");
      if (found) throw new Error("Multiple native operations claimed the same forgetting request");
      found = result;
    }
    return found;
  }

  /** Official native apply, with file publication supplied by its public SDK. */
  async apply(agentId: string, sessions: string[], expectedDigest: string, requestId?: string): Promise<MemoryForgetOutcome> {
    if (requestId) {
      const previous = await this.outcome(agentId, sessions, expectedDigest, requestId);
      if (previous) return previous;
    }
    if (process.platform !== "darwin") throw new Error("Recoverable forgetting requires macOS Trash");
    const reviewed = await this.preview(agentId, sessions);
    if (!reviewed.sessionIds.length || reviewed.sessionResolutions.some((session) => session.source === "unresolved")) {
      throw new Error("Resolve every selected native conversation before forgetting");
    }
    if (reviewed.refusals.length) throw new Error("Resolve native memory refusals before forgetting");
    // Capture current shared state, not a previous copy that predates newer work.
    const recovery = await this.prepare(agentId, sessions, expectedDigest);
    const root = join(this.options.paths.root, "memory-operations");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const operation = await mkdtemp(join(root, "memory-forget-"));
    const journal = join(operation, "file-changes.jsonl");
    const input = {
      format: "livingbot-memory-maintenance-v1", action: "forget", entry: this.options.entry,
      workspace: join(this.options.paths.workspaces, agentId), trash: join(homedir(), ".Trash"),
      journal, agentId, sessions,
    };
    const save = async (name: string, value: unknown) => {
      const file = await open(join(operation, name), "wx", 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      const directory = await open(operation, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    };
    const outcome: MemoryForgetOutcome = {
      id: basename(operation), agentId, createdAt: Date.now(), status: "recovery-required", recovery, files: [],
    };
    await save("input.json", input);
    await save("prepared.json", { ...outcome, expectedDigest, reviewed });
    if (requestId) await save("request.json", { requestId, agentId, sessions, expectedDigest });
    await save("running.json", { startedAt: Date.now() });
    try {
      const runner = fileURLToPath(new URL("./memory-maintenance-runner.mjs", import.meta.url));
      const { stdout } = await promisify(execFile)(this.options.nodeExecutable, [runner, join(operation, "input.json")], {
        env: runtimeEnvironment(this.options.paths), cwd: this.options.paths.root,
        timeout: 120_000, maxBuffer: 2_000_000, encoding: "utf8",
      });
      const raw = record(JSON.parse(stdout));
      if (raw.dryRun !== false) throw new Error("Native forgetting did not confirm apply");
      const report = memoryForgetPreview({ ...raw, dryRun: true }, agentId);
      if (JSON.stringify(report.sessionIds) !== JSON.stringify(reviewed.sessionIds)) throw new Error("Native forgetting selection changed");
      outcome.report = { ...report, dryRun: false };
      outcome.remaining = await this.preview(agentId, sessions);
      outcome.status = "completed";
    } catch {
      outcome.error = "Native forgetting needs recovery; its verified original copy and file journal are retained";
    }
    try {
      const lines = await readFile(journal, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      outcome.files = lines.trim() ? lines.trim().split("\n").map((line) => record(JSON.parse(line)))
        .filter((line) => line.phase === "committed" || line.phase === "uncertain")
        .map((line) => ({
          original: text(line.original), recovery: text(line.recovery),
          operation: line.operation === "remove" ? "remove" : "rewrite", sha256: text(line.sha256),
        })) : [];
      await save("outcome.json", outcome);
    } catch {
      // The running marker remains durable; startup refuses to hide a lost outcome.
      outcome.status = "recovery-required";
      outcome.error = "Memory outcome could not be saved; explicit recovery is required";
    }
    return outcome;
  }
}
