import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open as openFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { MessageBlock } from "@livingbot/contracts";
import { expandToolStepNotes, localDocumentPath, localDocumentReferences } from "@livingbot/core";
import type { PrismaClient } from "@livingbot/db";
import { ORPCError } from "@orpc/server";

export async function resolveLocalMessageFile(
  deps: {
    prisma: PrismaClient;
    localHost: boolean;
    platform?: string;
    resolveDocument?: (reference: string) => Promise<string | undefined>;
    open?: (path: string, action: "open" | "reveal") => Promise<void>;
  },
  threadId: string,
  input: { messageId: string; path: string; action: "open" | "reveal" },
) {
  if (!deps.localHost || (deps.platform ?? process.platform) !== "darwin") {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "Local files can only be opened on the connected local Mac.",
    });
  }
  const message = await deps.prisma.message.findFirst({
    where: { id: input.messageId, threadId, role: "bot" },
    select: { blocks: true },
  });
  const referenced =
    message &&
    expandToolStepNotes(message.blocks as MessageBlock[]).some(
      (block) =>
        block.kind === "text" &&
        localDocumentReferences(block.text).some((reference) => reference.path === input.path),
    );
  if (!referenced || localDocumentPath(input.path) !== input.path) {
    throw new ORPCError("NOT_FOUND", { message: "This file is not referenced by this message." });
  }
  const requested = input.path.startsWith("~/") ? join(homedir(), input.path.slice(2)) : input.path;
  let path: string;
  try {
    try {
      path = await realpath(requested);
    } catch {
      const recovered = await deps.resolveDocument?.(input.path);
      if (!recovered) throw new Error("missing document");
      path = await realpath(recovered);
    }
    if (!localDocumentPath(path) || !(await stat(path)).isFile()) throw new Error("not a document");
  } catch {
    throw new ORPCError("NOT_FOUND", {
      message: "文件不存在、路径不完整，或当前 Mac 无法访问。",
    });
  }
  return { path, name: basename(path), size: (await stat(path)).size ?? 0 };
}

export async function openLocalMessageFile(
  deps: Parameters<typeof resolveLocalMessageFile>[0],
  threadId: string,
  input: { messageId: string; path: string; action: "open" | "reveal" },
) {
  const { path } = await resolveLocalMessageFile(deps, threadId, input);
  const open =
    deps.open ??
    (async (path, action) => {
      await promisify(execFile)(
        "/usr/bin/open",
        [...(action === "reveal" ? ["-R"] : []), "--", path],
        { timeout: 15_000 },
      );
    });
  await open(path, input.action);
  return { ok: true as const };
}

/** Read only Markdown explicitly referenced by a message in the authorized thread. */
export async function previewLocalMessageFile(
  deps: Parameters<typeof resolveLocalMessageFile>[0],
  threadId: string,
  input: { messageId: string; path: string },
) {
  const file = await resolveLocalMessageFile(deps, threadId, { ...input, action: "open" });
  if (!/\.md$/i.test(input.path) || !/\.md$/i.test(file.path))
    throw new ORPCError("BAD_REQUEST", { message: "Only Markdown files can be previewed." });
  const maximumBytes = 2 * 1024 * 1024;
  const handle = await openFile(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes)
      throw new ORPCError("BAD_REQUEST", { message: "This file is too large to preview." });
    // Bound reads even if another process grows the file after the size check.
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximumBytes)
      throw new ORPCError("BAD_REQUEST", { message: "This file is too large to preview." });
    try {
      return {
        name: file.name,
        text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)),
      };
    } catch {
      throw new ORPCError("BAD_REQUEST", { message: "This file is not valid UTF-8 text." });
    }
  } finally {
    await handle.close();
  }
}
