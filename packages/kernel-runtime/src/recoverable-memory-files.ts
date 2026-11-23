import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type MemoryFileChange = {
  filePath: string; content: string | null; expectedContent?: string; expectedHash?: string;
};
export type RecoverableFileReceipt = { original: string; recovery: string; operation: "remove" | "rewrite"; sha256: string };

/** Local implementation of the official Memory workspace maintenance boundary. */
export class RecoverableMemoryFiles {
  readonly workspace: string;
  private readonly trash: string;
  private readonly journal: string;
  constructor(options: { workspace: string; trash: string; journal: string }) {
    if (![options.workspace, options.trash, options.journal].every(isAbsolute)) throw new Error("Memory maintenance paths must be absolute");
    this.workspace = resolve(options.workspace); this.trash = resolve(options.trash); this.journal = resolve(options.journal);
    if (this.trash === this.workspace || this.trash.startsWith(`${this.workspace}${sep}`)) throw new Error("Trash must be outside workspace");
  }

  async checkedPath(path: string): Promise<string> {
    const absolute = resolve(path);
    const rel = relative(this.workspace, absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Memory file escaped workspace");
    if (await realpath(this.workspace) !== this.workspace || !(await lstat(this.workspace)).isDirectory()) throw new Error("Workspace identity changed");
    if (absolute === this.workspace) return absolute;
    let parent = this.workspace;
    for (const component of relative(this.workspace, dirname(absolute)).split(sep).filter(Boolean)) {
      parent = join(parent, component);
      const metadata = await lstat(parent);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Memory parent must be a regular directory");
    }
    return absolute;
  }

  async readFile(path: string): Promise<Buffer> {
    const absolute = await this.checkedPath(path);
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 100 * 1024 * 1024) throw new Error("Invalid memory file");
      const bytes = await handle.readFile();
      const after = await handle.stat();
      const current = await lstat(absolute);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink()) throw new Error("Memory file changed while reading");
      return bytes;
    } finally { await handle.close(); }
  }

  async stat(path: string, _followSymlinks: boolean) {
    const metadata = await lstat(await this.checkedPath(path));
    if (metadata.isSymbolicLink()) throw new Error("Memory symbolic links are unavailable during maintenance");
    return {
      isFile: metadata.isFile(), isDirectory: metadata.isDirectory(), isSymbolicLink: false,
      size: metadata.size, mtimeMs: metadata.mtimeMs, mode: metadata.mode,
    };
  }

  async listDirectory(path: string) {
    const directory = await this.checkedPath(path);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid memory directory");
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory(), isSymbolicLink: entry.isSymbolicLink() }));
  }

  private async record(value: Record<string, unknown>) {
    const file = await open(this.journal, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!(await file.stat()).isFile()) throw new Error("Invalid memory change journal");
      await file.writeFile(`${JSON.stringify({ at: Date.now(), ...value })}\n`);
      await file.sync();
    } finally { await file.close(); }
  }

  async commitContent(change: MemoryFileChange): Promise<void> {
    const original = await this.checkedPath(change.filePath);
    if (original === this.workspace || typeof change.expectedContent !== "string") throw new Error("Memory replacement requires an observed original");
    const bytes = await this.readFile(original);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!bytes.equals(Buffer.from(change.expectedContent)) || change.expectedHash && change.expectedHash !== sha256) {
      throw Object.assign(new Error("Memory changed before recoverable publication"), { name: "MemoryWriteConflictError" });
    }
    if (change.content !== null && typeof change.content !== "string") throw new Error("Invalid memory replacement");
    if (process.platform !== "darwin") throw new Error("Recoverable memory publication requires macOS Trash");
    const trashInfo = await lstat(this.trash);
    if (!trashInfo.isDirectory() || trashInfo.isSymbolicLink() || await realpath(this.trash) !== this.trash || trashInfo.mode & 0o077) {
      throw new Error("macOS Trash is unavailable");
    }
    const destination = await mkdtemp(join(this.trash, "LivingBot-memory-"));
    const recovery = join(destination, basename(original));
    const receipt: RecoverableFileReceipt = { original, recovery, operation: change.content === null ? "remove" : "rewrite", sha256 };
    await this.record({ phase: "prepared", ...receipt });
    await rename(original, recovery);
    try {
      const retained = await open(recovery, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (createHash("sha256").update(await retained.readFile()).digest("hex") !== sha256) throw new Error("Memory changed during Trash move");
      } finally { await retained.close(); }
      if (change.content !== null) {
        const file = await open(original, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try { await file.writeFile(change.content); await file.sync(); } finally { await file.close(); }
      }
      for (const path of [dirname(original), destination]) {
        const directory = await open(path, constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      }
      await this.record({ phase: "committed", ...receipt });
    } catch (cause) {
      // Do not overwrite a competing/partial publication. Both paths remain reviewable.
      await this.record({ phase: "uncertain", ...receipt });
      throw Object.assign(new Error("Memory publication needs recovery; original retained in Trash", { cause }), { publication: "uncertain" });
    }
  }

  async mkdir(path: string) {
    const directory = await this.checkedPath(path);
    await mkdir(directory, { mode: 0o700 });
  }
}
