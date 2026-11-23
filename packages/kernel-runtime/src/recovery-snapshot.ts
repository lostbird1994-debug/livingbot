import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type SnapshotEntry = { root: string; path: string; bytes: number; sha256: string };
export type RecoverySnapshot = {
  format: "livingbot-recovery-v1";
  createdAt: number;
  roots: SnapshotSource[];
  directories: { root: string; path: string }[];
  files: SnapshotEntry[];
  digest: string;
};
export type SnapshotSource = { id: string; path: string; exclude?: string[] };
const maximumBytes = 2 * 1024 * 1024 * 1024;
const maximumFiles = 100_000;
const maximumFileBytes = 512 * 1024 * 1024;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error("Invalid recovery source");
  return value;
}
function sourcePath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid recovery file path");
  }
  const result = resolve(root, path);
  if (!inside(root, result) || result === root) throw new Error("Recovery path escaped source");
  return result;
}
function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
function manifestDigest(manifest: Omit<RecoverySnapshot, "digest">): string { return sha256(JSON.stringify(manifest)); }

async function writeVerifiedFile(path: string, bytes: Buffer | string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

async function regularRoot(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("Recovery paths must be absolute");
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error("Recovery source must be a canonical directory");
  }
}
async function regularParents(root: string, path: string): Promise<void> {
  await regularRoot(root);
  let current = root;
  for (const segment of relative(root, dirname(path)).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Recovery parent changed");
  }
}
async function readChecked(root: string, path: string, expected?: Pick<SnapshotEntry, "bytes" | "sha256">): Promise<Buffer> {
  const absolute = sourcePath(root, path);
  await regularParents(root, absolute);
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maximumFileBytes || expected && before.size !== expected.bytes) {
      throw new Error("Recovery source changed or exceeds its size limit");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error("Recovery source changed while reading");
      offset += result.bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(absolute);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev ||
      expected && sha256(bytes) !== expected.sha256) throw new Error("Recovery integrity mismatch");
    return bytes;
  } finally { await file.close(); }
}

async function inventory(sources: SnapshotSource[]): Promise<Pick<RecoverySnapshot, "directories" | "files">> {
  const directories: RecoverySnapshot["directories"] = [];
  const files: SnapshotEntry[] = [];
  let total = 0;
  async function visit(source: SnapshotSource, directory: string): Promise<void> {
    await regularParents(source.path, join(directory, "inventory"));
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const absolute = join(directory, name);
      const path = relative(source.path, absolute).split(sep).join("/");
      sourcePath(source.path, path);
      if (source.exclude?.some((excluded) => path === excluded || path.startsWith(`${excluded}/`))) continue;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error("Recovery sources cannot contain symbolic links");
      if (info.isDirectory()) {
        if (directories.length >= maximumFiles) throw new Error("Too many recovery directories");
        directories.push({ root: source.id, path });
        await visit(source, absolute);
      } else if (info.isFile()) {
        if (files.length >= maximumFiles || info.size > maximumFileBytes || total + info.size > maximumBytes) {
          throw new Error("Recovery snapshot exceeds its size limit");
        }
        const bytes = await readChecked(source.path, path);
        total += bytes.length;
        files.push({ root: source.id, path, bytes: bytes.length, sha256: sha256(bytes) });
      } else throw new Error("Recovery sources must contain only regular files and directories");
    }
  }
  for (const source of sources) { await regularRoot(source.path); await visit(source, source.path); }
  return { directories, files };
}

/** Caller holds exclusive offline kernel ownership throughout preparation. */
export async function createRecoverySnapshot(sources: SnapshotSource[], backupRoot: string): Promise<string> {
  if (!sources.length || sources.length > 20 || !isAbsolute(backupRoot)) throw new Error("Invalid recovery selection");
  const ids = new Set<string>();
  for (const source of sources) {
    identifier(source.id);
    if (ids.has(source.id)) throw new Error("Duplicate recovery source");
    ids.add(source.id);
    if (source.exclude && (!Array.isArray(source.exclude) || source.exclude.length > 20)) throw new Error("Invalid recovery exclusions");
    for (const path of source.exclude ?? []) sourcePath(source.path, path);
    await regularRoot(source.path);
    if (inside(source.path, resolve(backupRoot)) || inside(resolve(backupRoot), source.path)) {
      throw new Error("Recovery snapshot must be separate from source");
    }
  }
  for (let index = 0; index < sources.length; index++) for (const other of sources.slice(index + 1)) {
    if (inside(sources[index]!.path, other.path) || inside(other.path, sources[index]!.path)) throw new Error("Recovery sources overlap");
  }
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await regularRoot(backupRoot);
  if ((await lstat(backupRoot)).mode & 0o077) throw new Error("Recovery directory must be private");
  const scanned = await inventory(sources);
  const destination = await mkdtemp(join(backupRoot, "memory-recovery-"));
  const content = join(destination, "files");
  await mkdir(content, { mode: 0o700 });
  for (const source of sources) await mkdir(join(content, source.id), { mode: 0o700 });
  for (const directory of scanned.directories) {
    await mkdir(sourcePath(join(content, directory.root), directory.path), { recursive: true, mode: 0o700 });
  }
  for (const entry of scanned.files) {
    const source = sources.find((source) => source.id === entry.root)!;
    const bytes = await readChecked(source.path, entry.path, entry);
    const output = sourcePath(join(content, entry.root), entry.path);
    await writeVerifiedFile(output, bytes);
    await readChecked(join(content, entry.root), entry.path, entry);
  }
  const finalInventory = await inventory(sources);
  if (JSON.stringify(finalInventory) !== JSON.stringify(scanned)) throw new Error("Recovery sources changed during backup");
  const data: Omit<RecoverySnapshot, "digest"> = {
    format: "livingbot-recovery-v1", createdAt: Date.now(),
    roots: sources.map((source) => ({ ...source })), ...scanned,
  };
  await writeVerifiedFile(join(destination, "manifest.json"), JSON.stringify({ ...data, digest: manifestDigest(data) }));
  for (const directory of [
    ...scanned.directories.map((entry) => sourcePath(join(content, entry.root), entry.path)).reverse(),
    ...sources.map((source) => join(content, source.id)), content, destination, backupRoot,
  ]) {
    const handle = await open(directory, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  await verifyRecoverySnapshot(destination);
  return destination;
}

export async function verifyRecoverySnapshot(path: string): Promise<RecoverySnapshot> {
  await regularRoot(path);
  const raw = await readChecked(path, "manifest.json");
  if (raw.length > 30 * 1024 * 1024) throw new Error("Recovery manifest is too large");
  const manifest = JSON.parse(raw.toString()) as RecoverySnapshot;
  if (manifest.format !== "livingbot-recovery-v1" || !Array.isArray(manifest.roots) || !manifest.roots.length ||
    manifest.roots.length > 20 || !Array.isArray(manifest.files) || manifest.files.length > maximumFiles ||
    !Array.isArray(manifest.directories) || manifest.directories.length > maximumFiles ||
    !Number.isSafeInteger(manifest.createdAt) || manifest.createdAt <= 0) throw new Error("Invalid recovery manifest");
  const { digest, ...data } = manifest;
  if (typeof digest !== "string" || digest !== manifestDigest(data)) throw new Error("Recovery manifest integrity mismatch");
  const selected = new Set<string>();
  for (const root of manifest.roots) {
    identifier(root.id);
    if (!isAbsolute(root.path) || selected.has(root.id)) throw new Error("Invalid recovery root");
    if (root.exclude && (!Array.isArray(root.exclude) || root.exclude.length > 20)) throw new Error("Invalid recovery exclusions");
    for (const path of root.exclude ?? []) sourcePath(root.path, path);
    selected.add(root.id);
  }
  const unique = new Set<string>();
  let total = 0;
  for (const entry of [...manifest.directories, ...manifest.files]) {
    if (!selected.has(entry.root)) throw new Error("Invalid recovery file root");
    sourcePath(join(path, "files", entry.root), entry.path);
    const key = `${entry.root}/${entry.path}`;
    if (unique.has(key)) throw new Error("Duplicate recovery path");
    unique.add(key);
  }
  for (const directory of manifest.directories) await regularRoot(sourcePath(join(path, "files", directory.root), directory.path));
  for (const entry of manifest.files) {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > maximumFileBytes ||
      typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) || (total += entry.bytes) > maximumBytes) {
      throw new Error("Invalid recovery integrity record");
    }
    await readChecked(join(path, "files", entry.root), entry.path, entry);
  }
  const actual = await inventory(manifest.roots.map((root) => ({ id: root.id, path: join(path, "files", root.id) })));
  const rootNames = (await readdir(join(path, "files"))).sort();
  if (JSON.stringify(rootNames) !== JSON.stringify([...selected].sort())) throw new Error("Recovery snapshot has unrecorded roots");
  if (JSON.stringify(actual.directories) !== JSON.stringify(manifest.directories) || JSON.stringify(actual.files) !== JSON.stringify(manifest.files)) {
    throw new Error("Recovery snapshot has unrecorded or missing content");
  }
  return manifest;
}


export type RecoveryRestore = {
  target: string;
  files: number;
  bytes: number;
  roots: { id: string; path: string }[];
};

/**
 * Materializes a verified recovery copy into a fresh, independent directory.
 * It never writes inside a recorded source root, never reuses an existing
 * target and never changes the copy, so recovering cannot damage live data.
 * Activation stays a separate, explicit user action.
 */
export async function restoreRecoverySnapshot(snapshot: string, target: string): Promise<RecoveryRestore> {
  const manifest = await verifyRecoverySnapshot(snapshot);
  if (!isAbsolute(target)) throw new Error("Recovery target must be absolute");
  const resolved = resolve(target);
  if (inside(snapshot, resolved) || inside(resolved, snapshot)) throw new Error("Recovery target must be separate from the copy");
  for (const root of manifest.roots) {
    if (inside(root.path, resolved) || inside(resolved, root.path)) {
      throw new Error("Recovery target must be separate from the recorded sources");
    }
  }
  await mkdir(dirname(resolved), { recursive: true, mode: 0o700 });
  try {
    await mkdir(resolved, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Recovery target already exists");
    throw error;
  }
  const content = join(resolved, "files");
  await mkdir(content, { mode: 0o700 });
  for (const root of manifest.roots) await mkdir(join(content, root.id), { mode: 0o700 });
  for (const directory of manifest.directories) {
    await mkdir(sourcePath(join(content, directory.root), directory.path), { recursive: true, mode: 0o700 });
  }
  let bytes = 0;
  for (const entry of manifest.files) {
    const source = join(snapshot, "files", entry.root);
    const copy = await readChecked(source, entry.path, entry);
    await writeVerifiedFile(sourcePath(join(content, entry.root), entry.path), copy);
    await readChecked(join(content, entry.root), entry.path, entry);
    bytes += entry.bytes;
  }
  const restored = await inventory(manifest.roots.map((root) => ({ id: root.id, path: join(content, root.id) })));
  if (JSON.stringify(restored) !== JSON.stringify({ directories: manifest.directories, files: manifest.files })) {
    throw new Error("Restored content does not match the reviewed copy");
  }
  return { target: resolved, files: manifest.files.length, bytes, roots: manifest.roots.map(({ id, path }) => ({ id, path })) };
}
