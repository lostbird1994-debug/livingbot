import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileHandlePath } from "./file-handle-path.js";
import { nativeWorkspacePath } from "./openclaw-workspace-files.js";

/** Attachments use the registered native workspace, including agents with an existing home. */
export async function readNativeWorkspaceBytes(root: string, filePath: string, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error("Invalid native attachment size limit");
  const name = relative(resolve(root), resolve(root, filePath)).split(sep).join("/");
  const target = await nativeWorkspacePath(root, name);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes || await fileHandlePath(file.fd) !== target)
      throw new Error("Native attachment is invalid, too large or outside its workspace");
    const bytes = await file.readFile();
    if (bytes.byteLength > maxBytes || await fileHandlePath(file.fd) !== target)
      throw new Error("Native attachment changed while reading");
    return new Uint8Array(bytes);
  } finally { await file.close(); }
}
