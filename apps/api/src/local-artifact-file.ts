import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ORPCError } from "@orpc/server";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { attachmentFileName, isLocalDocumentName } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

const MAX_NAME_LENGTH = 120;

/**
 * A name that can sit in Downloads without surprising anyone: no separators, no control
 * characters, no leading dots, and short enough for the filesystem.
 */
export function localArtifactFileName(name: string): string {
  const base = name.split(/[/\\]/).at(-1) ?? "";
  const cleaned = [...base]
    .map((char) => (char.charCodeAt(0) < 0x20 || '<>:"|?*'.includes(char) ? "-" : char))
    .join("")
    .replace(/^\.+/, "")
    .trim();
  if (!cleaned) return "attachment";
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 ? cleaned.slice(dot).slice(0, 16) : "";
  return cleaned.slice(0, MAX_NAME_LENGTH - extension.length) + extension;
}

/**
 * Reuses a file already sitting in the folder when its content matches, so opening the same
 * attachment twice does not leave `report (2).xlsx` behind. Otherwise takes the first free
 * `report (n).xlsx` slot.
 */
export async function localArtifactTargetPath(
  dir: string,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let copy = 1; copy <= 99; copy += 1) {
    const candidate = join(dir, copy === 1 ? name : `${stem} (${copy})${extension}`);
    try {
      const existing = await stat(candidate);
      if (
        existing.isFile() &&
        existing.size === bytes.byteLength &&
        Buffer.from(bytes).equals(await readFile(candidate))
      )
        return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw error;
    }
  }
  return join(dir, `${stem}-${Date.now()}${extension}`);
}

type SourceDeps = {
  prisma: PrismaClient;
  resolveSourceDocument?: (botId: string, reference: string) => Promise<string | undefined>;
};
async function resolveArtifactSource(
  deps: SourceDeps, actor: Actor, row: { id: string; botId: string | null; runId: string | null },
) {
  // Recover provenance from the completed attachment operation, matched by
  // artifact ID and owner. An attachment title alone cannot identify a source.
  let source: string | undefined;
  if (row.botId && row.runId && deps.resolveSourceDocument) {
    const effects = await deps.prisma.externalEffect.findMany({
      where: { spaceId: actor.spaceId, runId: row.runId, kind: "attach_file", status: "completed",
        run: { botId: row.botId, userId: actor.userId, spaceId: actor.spaceId } },
      select: { request: true, result: true },
    });
    const references = new Set<string>();
    for (const effect of effects) {
      const result = effect.result as { ok?: unknown; artifactId?: unknown; path?: unknown } | null;
      const request = effect.request as { path?: unknown } | null;
      if (result?.ok === true && result.artifactId === row.id &&
          typeof result.path === "string" && result.path === request?.path)
        references.add(result.path);
    }
    if (references.size === 1) {
      const candidate = await deps.resolveSourceDocument(row.botId, [...references][0]!);
      if (candidate) {
        try { if ((await stat(candidate)).isFile()) source = await realpath(candidate); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  }
  return source;
}

export async function localArtifactInfo(
  deps: SourceDeps & { localHost: boolean; platform?: string }, actor: Actor, artifactId: string,
) {
  const row = await deps.prisma.artifact.findFirst({
    where: { id: artifactId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true, botId: true, runId: true, size: true },
  });
  if (!row) throw new ORPCError("NOT_FOUND", { message: "This file is not available." });
  const sourcePath = deps.localHost && (deps.platform ?? process.platform) === "darwin"
    ? await resolveArtifactSource(deps, actor, row) : undefined;
  return { sourcePath: sourcePath ?? null, ...(row.size === undefined ? {} : { size: row.size }) };
}

export async function openLocalArtifactFile(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
    localHost: boolean;
    platform?: string;
    resolveSourceDocument?: (botId: string, reference: string) => Promise<string | undefined>;
    /** Overridable for tests; production writes to the user's Downloads folder. */
    downloadDir?: string;
    open?: (path: string, action: "open" | "reveal") => Promise<void>;
  },
  actor: Actor,
  input: { artifactId: string; action: "open" | "reveal"; version?: "source" | "attachment" },
) {
  if (!deps.localHost || (deps.platform ?? process.platform) !== "darwin") {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "Files can only be opened on the connected local Mac.",
    });
  }
  const row = await deps.prisma.artifact.findFirst({
    where: {
      id: input.artifactId,
      spaceId: actor.spaceId,
      userId: actor.userId,
    },
    select: { id: true, name: true, mimeType: true, storageKey: true, botId: true, groupId: true, runId: true },
  });
  if (!row) throw new ORPCError("NOT_FOUND", { message: "This file is not available." });

  // A bot chooses the attachment's name, so only the document types the link fix already
  // trusts are handed to the launcher. Revealing in Finder stays available for everything.
  const name = localArtifactFileName(attachmentFileName(row.name, row.mimeType));
  if (input.action === "open" && !isLocalDocumentName(name)) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "This file type opens from Finder only.",
    });
  }

  const source = input.action === "open" && input.version === "attachment"
    ? undefined : await resolveArtifactSource(deps, actor, row);
  const launch = deps.open ?? (async (target: string, action: "open" | "reveal") => {
    await promisify(execFile)("/usr/bin/open", [...(action === "reveal" ? ["-R"] : []), "--", target], { timeout: 15_000 });
  });
  if (source) {
    if (input.action === "open" && !isLocalDocumentName(source))
      throw new ORPCError("PRECONDITION_FAILED", { message: "This file type opens from Finder only." });
    await launch(source, input.action);
    return { ok: true as const };
  }
  if (input.action === "reveal") {
    throw new ORPCError("NOT_FOUND", { message: "无法定位源文件所在目录。你仍可下载此附件。" });
  }

  const bytes = await deps.artifacts.get(
    row.storageKey,
    createAdapterContext(actor, row.botId ?? row.groupId ?? row.id, `artifact-file:${row.id}`),
  );

  const dir = deps.downloadDir ?? join(homedir(), "Downloads");
  await mkdir(dir, { recursive: true });
  let path: string | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = await localArtifactTargetPath(dir, name, bytes);
    try {
      await writeFile(candidate, bytes, { flag: "wx" });
      path = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another open may have claimed the filename after our lookup. Only
      // reuse it if it really contains this attachment; otherwise choose again.
      if (Buffer.from(bytes).equals(await readFile(candidate))) {
        path = candidate;
        break;
      }
    }
  }
  if (!path) throw new Error("Could not save the attachment without replacing another file.");

  await launch(path, input.action);
  return { ok: true as const };
}
