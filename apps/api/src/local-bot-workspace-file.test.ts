import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  botWorkspaceRoot,
  isLaunchableFile,
  openBotWorkspaceFile,
} from "./local-bot-workspace-file.js";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "rakazo-workspace-"));
  const bot = join(root, "bots", "bot-1");
  await mkdir(join(bot, "deliverables"), { recursive: true });
  await writeFile(join(bot, "deliverables", "report.md"), "# done\n");
  return { root, bot };
}

function deps(root: string | undefined) {
  const open = vi.fn(async () => {});
  return { open, deps: { root, localHost: true, platform: "darwin", open } };
}

describe("bot workspace file actions", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["open", "reveal"] as const)("%s opens a file inside the workspace", async (action) => {
    const { root, bot } = await workspace();
    const { deps: d, open } = deps(root);
    await expect(
      openBotWorkspaceFile(d, {
        storedPath: join("bots", "bot-1", "deliverables", "report.md"),
        action,
      }),
    ).resolves.toEqual({ ok: true });
    // The action receives the canonical path, because that is what it verified.
    expect(open).toHaveBeenCalledWith(
      await realpath(join(bot, "deliverables", "report.md")),
      action,
    );
  });

  it("refuses a path that leaves the workspace", async () => {
    const { root } = await workspace();
    const { deps: d, open } = deps(root);
    await expect(
      openBotWorkspaceFile(d, { storedPath: "../../../etc/hosts", action: "open" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses a link that points outside the workspace", async () => {
    const { root, bot } = await workspace();
    await symlink("/etc/hosts", join(bot, "deliverables", "hosts.md"));
    const { deps: d, open } = deps(root);
    await expect(
      openBotWorkspaceFile(d, {
        storedPath: join("bots", "bot-1", "deliverables", "hosts.md"),
        action: "open",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(open).not.toHaveBeenCalled();
  });

  it("hands the folder, not the launcher, for a file that runs when opened", async () => {
    const { root, bot } = await workspace();
    await writeFile(join(bot, "build.command"), "rm -rf ~\n");
    const { deps: d, open } = deps(root);
    const storedPath = join("bots", "bot-1", "build.command");
    await expect(openBotWorkspaceFile(d, { storedPath, action: "open" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(open).not.toHaveBeenCalled();
    await expect(openBotWorkspaceFile(d, { storedPath, action: "reveal" })).resolves.toEqual({
      ok: true,
    });
  });

  it("refuses when the workspace has no folder on this Mac", async () => {
    const { deps: d, open } = deps(undefined);
    await expect(
      openBotWorkspaceFile(d, { storedPath: "bots/bot-1/report.md", action: "open" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses on a remote server", async () => {
    const { root } = await workspace();
    const { deps: d, open } = deps(root);
    await expect(
      openBotWorkspaceFile(
        { ...d, localHost: false },
        { storedPath: "bots/bot-1/report.md", action: "open" },
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(open).not.toHaveBeenCalled();
  });
});

describe("launchable names", () => {
  it("flags the bundle and script types macOS would run", () => {
    for (const name of ["a.app", "b.command", "c.pkg", "d.scpt", "e.TOOL"]) {
      expect(isLaunchableFile(name)).toBe(true);
    }
    for (const name of ["notes.md", "sheet.xlsx", "photo.png", "script.py"]) {
      expect(isLaunchableFile(name)).toBe(false);
    }
  });
});

describe("workspace root", () => {
  it("asks a local store for the folder", () => {
    expect(botWorkspaceRoot({ pathFor: (id: string) => `/tmp/homes/${id}` }, "home-1")).toBe(
      "/tmp/homes/home-1",
    );
  });

  it("returns nothing when the store cannot name a folder", () => {
    expect(botWorkspaceRoot({}, "home-1")).toBeUndefined();
    expect(botWorkspaceRoot(null, "home-1")).toBeUndefined();
    expect(
      botWorkspaceRoot(
        {
          pathFor: () => {
            throw new Error("bad id");
          },
        },
        "home-1",
      ),
    ).toBeUndefined();
  });
});
