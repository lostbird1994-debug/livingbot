import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ORPCError } from "@orpc/server";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { isLocalDocumentName } from "@rakazo/core";
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
 * Reuses a file already sitting in the folder when its size matches, so opening the same
 * attachment twice does not leave `report (2).xlsx` behind. Otherwise takes the first free
 * `report (n).xlsx` slot.
 */
export async function localArtifactTargetPath(
  dir: string,
  name: string,
  size: number,
): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let copy = 1; copy <= 99; copy += 1) {
    const candidate = join(dir, copy === 1 ? name : `${stem} (${copy})${extension}`);
    try {
      const existing = await stat(candidate);
      if (existing.isFile() && existing.size === size) return candidate;
    } catch {
      return candidate;
    }
  }
  return join(dir, `${stem}-${Date.now()}${extension}`);
}

export async function openLocalArtifactFile(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
    localHost: boolean;
    platform?: string;
    /** Overridable for tests; production writes to the user's Downloads folder. */
    downloadDir?: string;
    open?: (path: string, action: "open" | "reveal") => Promise<void>;
  },
  actor: Actor,
  input: { artifactId: string; action: "open" | "reveal" },
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
    select: { id: true, name: true, storageKey: true, botId: true, groupId: true },
  });
  if (!row) throw new ORPCError("NOT_FOUND", { message: "This file is not available." });

  // A bot chooses the attachment's name, so only the document types the link fix already
  // trusts are handed to the launcher. Revealing in Finder stays available for everything.
  if (input.action === "open" && !isLocalDocumentName(row.name)) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "This file type opens from Finder only.",
    });
  }

  const bytes = await deps.artifacts.get(
    row.storageKey,
    createAdapterContext(actor, row.botId ?? row.groupId ?? row.id, `artifact-file:${row.id}`),
  );

  const dir = deps.downloadDir ?? join(homedir(), "Downloads");
  await mkdir(dir, { recursive: true });
  const path = await localArtifactTargetPath(
    dir,
    localArtifactFileName(row.name),
    bytes.byteLength,
  );
  try {
    await stat(path);
  } catch {
    await writeFile(path, bytes);
  }

  const open =
    deps.open ??
    (async (target, action) => {
      await promisify(execFile)(
        "/usr/bin/open",
        [...(action === "reveal" ? ["-R"] : []), "--", target],
        { timeout: 15_000 },
      );
    });
  await open(path, input.action);
  return { ok: true as const };
}
