import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ORPCError } from "@orpc/server";

/**
 * Extensions that macOS launches as code rather than as a document. A bot writes its own
 * workspace, so handing one of these to `open` would run it; those get the folder instead.
 */
const LAUNCHABLE_EXTENSIONS = new Set([
  "action",
  "app",
  "command",
  "dmg",
  "install",
  "mpkg",
  "osascript",
  "pkg",
  "scpt",
  "terminal",
  "tool",
  "workflow",
]);

export function isLaunchableFile(fileName: string): boolean {
  const extension = path.extname(fileName).slice(1).toLowerCase();
  return LAUNCHABLE_EXTENSIONS.has(extension);
}

/**
 * The folder a bot's workspace lives in. `pathFor` is on the local home store but not on the
 * interface, so a store that cannot name a folder (an object-backed one) returns undefined and
 * the caller refuses rather than opening a cache file.
 */
export function botWorkspaceRoot(store: unknown, homeKey: string): string | undefined {
  const pathFor = (store as { pathFor?: (id: string) => string } | null | undefined)?.pathFor;
  if (typeof pathFor !== "function") return undefined;
  try {
    return pathFor.call(store, homeKey);
  } catch {
    return undefined;
  }
}

export async function openBotWorkspaceFile(
  deps: {
    root: string | undefined;
    localHost: boolean;
    platform?: string;
    open?: (path: string, action: "open" | "reveal") => Promise<void>;
  },
  input: { storedPath: string; action: "open" | "reveal" },
): Promise<{ ok: true }> {
  if (!deps.localHost || (deps.platform ?? process.platform) !== "darwin") {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "Workspace files can only be opened on the connected local Mac.",
    });
  }
  if (!deps.root) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "This workspace has no folder on this Mac.",
    });
  }
  // Canonicalise the root too: on macOS a temp or home path can be reached through a link
  // (`/var` is `/private/var`), and comparing a canonical file with a raw root would reject
  // every real file.
  let root: string;
  try {
    root = await realpath(path.resolve(deps.root));
  } catch {
    throw new ORPCError("NOT_FOUND", { message: "The bot's folder is missing on this Mac." });
  }
  const requested = path.resolve(root, input.storedPath);
  const inside = (candidate: string) => candidate === root || candidate.startsWith(root + path.sep);
  if (!inside(requested)) {
    throw new ORPCError("NOT_FOUND", { message: "This file is not in the bot's workspace." });
  }

  let file: string;
  try {
    // Resolve links before deciding: a link inside the workspace can point outside it.
    file = await realpath(requested);
    if (!inside(file) || !(await stat(file)).isFile()) throw new Error("not a file");
  } catch {
    throw new ORPCError("NOT_FOUND", {
      message: "The file is missing or unavailable on this Mac.",
    });
  }

  if (input.action === "open" && isLaunchableFile(file)) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "This file type runs when opened, so it only opens its folder.",
    });
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
  await open(file, input.action);
  return { ok: true as const };
}
