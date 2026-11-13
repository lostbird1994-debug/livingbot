import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@livingbot/adapter-kit";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const within = (root: string, path: string) => {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
};

/** No symlinks in a workspace file path, including ancestors of a new file. */
export async function nativeWorkspacePath(root: string, name: string, createParents = false) {
  if (
    !name || name.includes("\\") || name.includes("\0") || isAbsolute(name) ||
    name.split("/").some(part => part === ".." || part === "." || !part)
  ) throw new Error("Unsafe native workspace file path");
  const canonical = await realpath(root);
  if (canonical !== resolve(root)) throw new Error("Native workspace root must not be a symlink");
  const target = resolve(canonical, name);
  if (!within(canonical, target) || target === canonical)
    throw new Error("Native workspace file escaped its root");
  let parent = canonical;
  const parts = name.split("/");
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    if (createParents) {
      try { await mkdir(parent, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Native workspace directory must not be a symlink");
  }
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error("Native workspace file must be a regular unlinked file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

export async function readNativeWorkspaceFile(root: string, name: string): Promise<string | undefined> {
  let file;
  try { file = await open(await nativeWorkspacePath(root, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 * 1024)
      throw new Error("Native workspace text file is invalid or too large");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

/** Preimage is retained before atomic replacement. No cleanup permanently deletes files. */
export async function writeNativeWorkspaceFile(
  root: string, name: string, content: string, expected: string | undefined,
) {
  const path = await nativeWorkspacePath(root, name, true);
  const current = await readNativeWorkspaceFile(root, name);
  if (current !== expected) throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
  if (current === content) return;
  const revisionName = `.rakazo/file-history/${hash(name)}/${Date.now()}-${randomUUID()}.md`;
  if (current !== undefined) {
    const previous = await open(await nativeWorkspacePath(root, revisionName, true), "wx", 0o600);
    try { await previous.writeFile(current); await previous.sync(); } finally { await previous.close(); }
  }
  const tempName = `${name}.rakazo-${randomUUID()}.pending`;
  const temp = await open(await nativeWorkspacePath(root, tempName, true), "wx", 0o600);
  try { await temp.writeFile(content); await temp.sync(); } finally { await temp.close(); }
  // A stale editor must never overwrite an engine update observed during preparation.
  if (await readNativeWorkspaceFile(root, name) !== current)
    throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
  await nativeWorkspacePath(root, name);
  await rename(await nativeWorkspacePath(root, tempName), path);
}

/** Only engine memory files; roles and recovery history are separate concerns. */
export async function listNativeMemoryFiles(root: string, shared: boolean): Promise<string[]> {
  const found: string[] = [];
  for (const name of shared ? ["MEMORY.md", "USER.md"] : ["MEMORY.md"]) {
    if (await readNativeWorkspaceFile(root, name) !== undefined) found.push(name);
  }
  async function walk(folder: string, depth: number) {
    if (depth > 12 || found.length > 2000) throw new Error("Native memory directory limit exceeded");
    let entries;
    try {
      const path = await nativeWorkspacePath(root, `${folder}/.scan`);
      entries = await readdir(dirname(path), { withFileTypes: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const name = `${folder}/${entry.name}`;
      if (entry.isDirectory()) await walk(name, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        await nativeWorkspacePath(root, name);
        found.push(name);
      }
    }
  }
  await walk("memory", 0);
  return found.sort();
}
