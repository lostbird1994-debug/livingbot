import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  localArtifactFileName,
  localArtifactTargetPath,
  openLocalArtifactFile,
} from "./local-artifact-file.js";

const actor = { spaceId: "space-1", userId: "user-1" } as never;

async function fixture(row: { id: string; name: string; storageKey: string } | null = null) {
  const dir = await mkdtemp(join(tmpdir(), "rakazo-artifact-"));
  const open = vi.fn(async () => {});
  const findFirst = vi.fn(async () => row);
  const get = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
  return {
    dir,
    open,
    findFirst,
    get,
    deps: {
      prisma: { artifact: { findFirst } } as unknown as PrismaClient,
      artifacts: { get } as unknown as ArtifactStore,
      localHost: true,
      platform: "darwin",
      downloadDir: dir,
      open,
    },
  };
}

describe("artifact file actions", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["open", "reveal"] as const)(
    "%s writes the bytes then opens the copy",
    async (action) => {
      const { deps, open, dir } = await fixture({
        id: "artifact-1",
        name: "合并报表.xlsx",
        storageKey: "key-1",
      });
      await expect(
        openLocalArtifactFile(deps, actor, { artifactId: "artifact-1", action }),
      ).resolves.toEqual({ ok: true });
      const path = join(dir, "合并报表.xlsx");
      expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3, 4]));
      expect(open).toHaveBeenCalledWith(path, action);
    },
  );

  it("scopes the lookup to the actor's space and user", async () => {
    const { deps, findFirst } = await fixture({
      id: "artifact-1",
      name: "a.txt",
      storageKey: "key-1",
    });
    await openLocalArtifactFile(deps, actor, { artifactId: "artifact-1", action: "open" });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "artifact-1", spaceId: "space-1", userId: "user-1" },
      }),
    );
  });

  it("refuses an artifact the actor cannot see, without writing anything", async () => {
    const { deps, open, get, dir } = await fixture(null);
    await expect(
      openLocalArtifactFile(deps, actor, { artifactId: "artifact-1", action: "open" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(get).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it("never launches an attachment whose name is not a document", async () => {
    const { deps, open, dir } = await fixture({
      id: "artifact-1",
      name: "installer.command",
      storageKey: "key-1",
    });
    await expect(
      openLocalArtifactFile(deps, actor, { artifactId: "artifact-1", action: "open" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(open).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it("still shows a non-document attachment in Finder", async () => {
    const { deps, open, dir } = await fixture({
      id: "artifact-1",
      name: "installer.command",
      storageKey: "key-1",
    });
    await openLocalArtifactFile(deps, actor, { artifactId: "artifact-1", action: "reveal" });
    expect(open).toHaveBeenCalledWith(join(dir, "installer.command"), "reveal");
  });

  it("refuses to open files on a remote server", async () => {
    const { deps, open, findFirst, get } = await fixture({
      id: "artifact-1",
      name: "a.txt",
      storageKey: "key-1",
    });
    await expect(
      openLocalArtifactFile({ ...deps, localHost: false }, actor, {
        artifactId: "artifact-1",
        action: "open",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(findFirst).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

describe("artifact file name", () => {
  it("keeps a plain name", () => {
    expect(localArtifactFileName("合并报表.xlsx")).toBe("合并报表.xlsx");
  });

  it("drops directories and reserved characters", () => {
    expect(localArtifactFileName("../../etc/pa:ss?wd.xlsx")).toBe("pa-ss-wd.xlsx");
    expect(localArtifactFileName("/Users/me/exports/report.pdf")).toBe("report.pdf");
  });

  it("never yields a dotfile or an empty name", () => {
    expect(localArtifactFileName(".hidden")).toBe("hidden");
    expect(localArtifactFileName("   ")).toBe("attachment");
  });

  it("shortens a long name but keeps its extension", () => {
    const name = localArtifactFileName(`${"a".repeat(300)}.xlsx`);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith(".xlsx")).toBe(true);
  });
});

describe("artifact target path", () => {
  it("reuses a file already there with the same size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rakazo-artifact-"));
    await writeFile(join(dir, "report.xlsx"), Buffer.alloc(4));
    await expect(localArtifactTargetPath(dir, "report.xlsx", 4)).resolves.toBe(
      join(dir, "report.xlsx"),
    );
  });

  it("steps aside for a different file with the same name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rakazo-artifact-"));
    await writeFile(join(dir, "report.xlsx"), Buffer.alloc(4));
    await expect(localArtifactTargetPath(dir, "report.xlsx", 99)).resolves.toBe(
      join(dir, "report (2).xlsx"),
    );
  });
});
