import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  moveNativePathToTrash,
  moveNativePathToTrashSync,
} from "../../adapters/src/desktop-workspace-cleanup.js";

if (process.platform === "darwin") {
  const normalize = (target: string | Buffer | URL) =>
    target instanceof URL
      ? fileURLToPath(target)
      : Buffer.isBuffer(target)
        ? target.toString()
        : target;

  async function move(
    target: string | Buffer | URL,
    options: { force?: boolean; recursive?: boolean } = {},
    unlink = false,
  ) {
    const file = normalize(target);
    let stat: Awaited<ReturnType<typeof fsPromises.lstat>>;
    try {
      stat = await fsPromises.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.force && !unlink) return;
      throw error;
    }
    if (stat.isDirectory() && (unlink || !options.recursive))
      throw Object.assign(new Error(`Path is a directory: ${file}`), { code: "ERR_FS_EISDIR" });
    await moveNativePathToTrash(file);
  }

  function moveSync(
    target: string | Buffer | URL,
    options: { force?: boolean; recursive?: boolean } = {},
    unlink = false,
  ) {
    const file = normalize(target);
    let stat: ReturnType<typeof fs.lstatSync>;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.force && !unlink) return;
      throw error;
    }
    if (stat.isDirectory() && (unlink || !options.recursive))
      throw Object.assign(new Error(`Path is a directory: ${file}`), { code: "ERR_FS_EISDIR" });
    moveNativePathToTrashSync(file);
  }

  type DeleteOptions = { force?: boolean; recursive?: boolean };
  type AsyncFs = {
    rm: (target: string | Buffer | URL, options?: DeleteOptions) => Promise<void>;
    unlink: (target: string | Buffer | URL) => Promise<void>;
    rmdir: (target: string | Buffer | URL, options?: DeleteOptions) => Promise<void>;
  };
  type SyncFs = {
    rmSync: (target: string | Buffer | URL, options?: DeleteOptions) => void;
    unlinkSync: (target: string | Buffer | URL) => void;
    rmdirSync: (target: string | Buffer | URL, options?: DeleteOptions) => void;
  };
  const asyncFs = fsPromises as unknown as AsyncFs;
  const syncFs = fs as unknown as SyncFs;
  asyncFs.rm = (target, options = {}) =>
    move(target as string, options as { force?: boolean; recursive?: boolean });
  asyncFs.unlink = (target) => move(target as string, {}, true);
  asyncFs.rmdir = (target, options = {}) => move(target as string, { ...options, recursive: true });
  syncFs.rmSync = (target, options = {}) =>
    moveSync(target as string, options as { force?: boolean; recursive?: boolean });
  syncFs.unlinkSync = (target) => moveSync(target as string, {}, true);
  syncFs.rmdirSync = (target, options = {}) =>
    moveSync(target as string, { ...options, recursive: true });

  syncBuiltinESMExports();
  const testBin = path.resolve(process.cwd(), "packages/testkit/src/test-trash-bin");
  const searchPath = process.env.PATH?.split(path.delimiter) ?? [];
  if (!searchPath.includes(testBin)) {
    process.env.PATH = [testBin, ...searchPath].join(path.delimiter);
  }
}
