import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type MigrationFile = {
  path: string; kind: "profile" | "memory" | "ability" | "other";
  bytes: number; sha256?: string;
  status: "verified" | "metadata-only" | "symlink" | "changed" | "unavailable";
};
export type MigrationInventory = {
  source: string; complete: boolean; files: MigrationFile[]; omitted: { path: string; reason: string }[];
};

const profiles = new Set(["AGENTS.md", "IDENTITY.md", "SOUL.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "BOOTSTRAP.md"]);
const excludedDirectories = new Set([".git", "node_modules", ".cache", ".venv"]);
function kind(path: string): MigrationFile["kind"] {
  if (profiles.has(path) || path.startsWith("profile/")) return "profile";
  if (path === "MEMORY.md" || path === "memory" || path.startsWith("memory/") ||
    path.startsWith(".rakazo/memory-archive/")) return "memory";
  if (path === "skills" || path.startsWith("skills/") || path.startsWith(".agents/skills/")) return "ability";
  return "other";
}

/** Read-only source inspection. It neither imports files nor initializes a Bot. */
export async function inspectMigrationWorkspace(source: string): Promise<MigrationInventory> {
  return inspectFiles(source, kind);
}

/** Inspect one explicitly selected, resolved skill directory and its supporting files. */
export async function inspectMigrationSkill(source: string): Promise<MigrationInventory> {
  return inspectFiles(source, () => "ability");
}

async function inspectFiles(source: string, classify: (path: string) => MigrationFile["kind"]): Promise<MigrationInventory> {
  if (!isAbsolute(source)) throw new Error("Migration source must be absolute");
  const metadata = await lstat(source);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Migration source must be a regular directory");
  const root = await realpath(source);
  const result: MigrationInventory = { source: root, complete: true, files: [], omitted: [] };
  let entries = 0;
  async function walk(relative: string, depth: number): Promise<void> {
    if (depth > 12 || entries >= 50_000) {
      result.complete = false;
      result.omitted.push({ path: relative, reason: "Inventory bound reached; review this directory separately" });
      return;
    }
    const names = await readdir(join(root, relative)).catch((error: NodeJS.ErrnoException) => {
      result.complete = false; result.omitted.push({ path: relative, reason: error.code ?? "Unreadable directory" }); return [];
    });
    for (const name of names.sort()) {
      if (++entries > 50_000) {
        result.complete = false;
        result.omitted.push({ path: relative, reason: "Inventory entry bound reached" });
        break;
      }
      const path = relative ? `${relative}/${name}` : name;
      const absolute = join(root, path);
      const info = await lstat(absolute).catch(() => undefined);
      if (!info) {
        result.complete = false; result.omitted.push({ path, reason: "Source disappeared during inventory" }); continue;
      }
      if (info.isSymbolicLink()) {
        result.files.push({ path, kind: classify(path), bytes: 0, status: "symlink" }); continue;
      }
      if (info.isDirectory()) {
        if (excludedDirectories.has(name)) result.omitted.push({ path, reason: "Runtime or dependency directory; not a migration source" });
        else await walk(path, depth + 1);
        continue;
      }
      if (!info.isFile()) {
        result.omitted.push({ path, reason: "Not a regular file" }); continue;
      }
      const entry: MigrationFile = { path, kind: classify(path), bytes: info.size, status: "metadata-only" };
      result.files.push(entry);
      if (entry.kind === "other") continue;
      if (info.size > 100 * 1024 * 1024) {
        result.complete = false; result.omitted.push({ path, reason: "Large source requires separate review" }); continue;
      }
      let file;
      try {
        // Check directory incarnations before opening so ordinary symlink
        // substitutions cannot redirect this inspector outside its source.
        let parent = root;
        for (const component of path.split("/").slice(0, -1)) {
          parent = join(parent, component);
          if ((await lstat(parent)).isSymbolicLink()) throw new Error("Source directory changed");
        }
        file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await file.stat();
        if (!before.isFile() || before.ino !== info.ino || before.dev !== info.dev) throw new Error("Source changed");
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(64 * 1024);
        let size = 0;
        for (;;) {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          size += bytesRead;
          if (size > info.size) throw new Error("Source changed");
          hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await file.stat();
        if (size !== info.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          entry.status = "changed"; result.complete = false;
        } else { entry.sha256 = hash.digest("hex"); entry.status = "verified"; }
      } catch {
        entry.status = "unavailable"; result.complete = false;
      } finally { await file?.close(); }
    }
  }
  await walk("", 0);
  return result;
}
