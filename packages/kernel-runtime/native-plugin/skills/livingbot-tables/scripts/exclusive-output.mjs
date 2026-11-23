/**
 * Exclusive new output for the livingbot-tables workbook script.
 *
 * A workbook the method produces must never replace the source workbook or any
 * file that is already there. The destination is created with O_EXCL, so an
 * existing file, symlink or hardlink to one is refused instead of overwritten,
 * and the same-inode check names the source itself before any bytes are written.
 */
import { lstat, stat, writeFile } from "node:fs/promises";

/** True when both paths resolve to the same file, link or hardlink. */
export async function sameFile(left, right) {
  if (!left || !right) return false;
  try {
    const [first, second] = await Promise.all([stat(left), stat(right)]);
    return first.dev === second.dev && first.ino === second.ino;
  } catch {
    return false;
  }
}

/** True when the path is taken, including by a link whose target is missing. */
export async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Writes bytes only where nothing exists yet; refuses and leaves it untouched otherwise. */
export async function writeNewFile(path, bytes) {
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw Object.assign(new Error(`输出路径已存在：${path}`), { code: "output-exists" });
    }
    throw error;
  }
}
