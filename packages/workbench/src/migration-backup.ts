import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MigrationFile, MigrationInventory } from "./migration-inventory.ts";

export type MigrationBackup = {
  version: 1; source: string; createdAt: number;
  files: { path: string; kind: MigrationFile["kind"]; bytes: number; sha256: string }[];
  excluded: { path: string; reason: string }[];
};

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

function sourcePath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid backup source path");
  const target = resolve(root, path);
  if (!inside(root, target) || target === root) throw new Error("Backup source escaped workspace");
  return target;
}

async function regularParents(root: string, path: string): Promise<void> {
  let parent = root;
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Backup root must be a regular directory");
  for (const component of relative(root, dirname(path)).split(sep).filter(Boolean)) {
    parent = join(parent, component);
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Backup parent changed or is a symbolic link");
  }
}

async function checkedBytes(root: string, path: string, expected: { bytes: number; sha256: string }): Promise<Buffer> {
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || expected.bytes > 100 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error("Invalid backup integrity record");
  const absolute = sourcePath(root, path);
  await regularParents(root, absolute);
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== expected.bytes) throw new Error("Source changed since preview");
    const bytes = Buffer.alloc(expected.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error("Source changed since preview");
      offset += result.bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(absolute);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev ||
      createHash("sha256").update(bytes).digest("hex") !== expected.sha256) throw new Error("Source changed since preview");
    return bytes;
  } finally { await file.close(); }
}

export async function readMigrationBackupFile(
  backup: string, entry: MigrationBackup["files"][number],
): Promise<Buffer> {
  return checkedBytes(join(backup, "files"), entry.path, entry);
}

/**
 * Explicit preparation only: preserve selected identity/memory/abilities in a new
 * immutable backup. It never initializes an agent or writes into its workspace.
 * An interrupted backup is retained for inspection; it is never auto-deleted.
 */
export async function createMigrationBackup(inventory: MigrationInventory, backupRoot: string): Promise<string> {
  if (!isAbsolute(backupRoot) || !isAbsolute(inventory.source)) throw new Error("Backup paths must be absolute");
  if (!inventory.complete) throw new Error("Resolve incomplete inventory before backup");
  const source = await realpath(inventory.source);
  if (source !== inventory.source) throw new Error("Workspace identity changed since preview");
  if (inside(source, resolve(backupRoot)) || inside(resolve(backupRoot), source)) throw new Error("Backup and source must be separate");
  const selected = inventory.files.filter((file) => file.kind !== "other" && file.status !== "symlink");
  if (!selected.length || selected.some((file) => file.status !== "verified" || !file.sha256)) {
    throw new Error("Every selected source requires a verified digest");
  }
  const unique = new Set<string>();
  for (const file of selected) {
    sourcePath(source, file.path);
    if (unique.has(file.path)) throw new Error("Duplicate backup source");
    unique.add(file.path);
  }
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const destination = await realpath(backupRoot);
  if (inside(source, destination) || inside(destination, source)) throw new Error("Backup and source must be separate");
  const backup = await mkdtemp(join(destination, "bot-backup-"));
  const content = join(backup, "files");
  await mkdir(content, { mode: 0o700 });
  const manifest: MigrationBackup = {
    version: 1, source, createdAt: Date.now(), files: [],
    excluded: [
      ...inventory.omitted,
      ...inventory.files.filter((file) => file.kind === "other" || file.status === "symlink").map((file) => ({
        path: file.path, reason: file.status === "symlink" ? "Symbolic link requires explicit source review" : "Outside identity, memory and abilities selection",
      })),
    ],
  };
  for (const file of selected) {
    const entry = { path: file.path, kind: file.kind, bytes: file.bytes, sha256: file.sha256! };
    const bytes = await checkedBytes(source, entry.path, entry);
    const output = sourcePath(content, entry.path);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
    await checkedBytes(content, entry.path, entry);
    manifest.files.push(entry);
  }
  await writeFile(join(backup, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await verifyMigrationBackup(backup);
  return backup;
}

export async function verifyMigrationBackup(backup: string): Promise<MigrationBackup> {
  if (!isAbsolute(backup)) throw new Error("Backup path must be absolute");
  const info = await lstat(backup);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid backup root");
  const raw = await readFile(join(backup, "manifest.json"), "utf8");
  if (raw.length > 20 * 1024 * 1024) throw new Error("Backup manifest is too large");
  const manifest = JSON.parse(raw) as MigrationBackup;
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length ||
    manifest.files.length > 50_000 || typeof manifest.source !== "string" || !isAbsolute(manifest.source)) {
    throw new Error("Invalid backup manifest");
  }
  const unique = new Set<string>();
  for (const entry of manifest.files) {
    if (unique.has(entry.path)) throw new Error("Duplicate backup source");
    unique.add(entry.path);
    await checkedBytes(join(backup, "files"), entry.path, entry);
  }
  return manifest;
}
