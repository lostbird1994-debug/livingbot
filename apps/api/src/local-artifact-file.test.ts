import { mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  localArtifactFileName,
  localArtifactInfo,
  localArtifactTargetPath,
  openLocalArtifactFile,
} from "./local-artifact-file.js";

const actor = { spaceId: "space-1", userId: "user-1" } as never;

async function fixture(
  row: { id: string; name: string; storageKey: string; mimeType?: string } | null = null,
) {
  const dir = await mkdtemp(join(tmpdir(), "rakazo-artifact-"));
  const open = vi.fn(async (_path: string, _action: "open" | "reveal") => {});
  const findFirst = vi.fn(async () => row && { mimeType: "application/octet-stream", ...row });
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

  it.each(["open"] as const)(
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

  it("opens an older Excel attachment whose title omitted the extension", async () => {
    const { deps, open, dir } = await fixture({
      id: "artifact-1",
      name: "报表",
      storageKey: "key-1",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    await openLocalArtifactFile(deps, actor, { artifactId: "artifact-1", action: "open" });
    expect(open).toHaveBeenCalledWith(join(dir, "报表.xlsx"), "open");
  });

  it("opens the correct version when two same-name attachments are opened concurrently", async () => {
    const { deps, open } = await fixture({
      id: "artifact-1",
      name: "report.xlsx",
      storageKey: "key-1",
    });
    const second = {
      ...deps,
      artifacts: {
        get: vi.fn(async () => new Uint8Array([4, 3, 2, 1])),
      } as unknown as ArtifactStore,
      open: vi.fn(async (_path: string, _action: "open" | "reveal") => {}),
    };
    await Promise.all([
      openLocalArtifactFile(deps, actor, { artifactId: "artifact-1", action: "open" }),
      openLocalArtifactFile(second, actor, { artifactId: "artifact-1", action: "open" }),
    ]);
    const firstPath = open.mock.calls[0]![0];
    const secondPath = second.open.mock.calls[0]![0];
    expect(firstPath).not.toBe(secondPath);
    expect(await readFile(firstPath)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(await readFile(secondPath)).toEqual(Buffer.from([4, 3, 2, 1]));
  });

  it("does not reinterpret an executable filename as a document based on its MIME type", async () => {
    const { deps, open } = await fixture({
      id: "artifact-1",
      name: "installer.command",
      storageKey: "key-1",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    await expect(
      openLocalArtifactFile(deps, actor, { artifactId: "artifact-1", action: "open" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(open).not.toHaveBeenCalled();
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

  it("does not create a Downloads copy when a source folder cannot be located", async () => {
    const { deps, open, get, dir } = await fixture({ id: "artifact-1", name: "report.xlsx", storageKey: "key-1" });
    await expect(openLocalArtifactFile(deps, actor, { artifactId: "artifact-1", action: "reveal" }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "无法定位源文件所在目录。你仍可下载此附件。" });
    expect(open).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
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
  it("reuses a file already there with identical content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rakazo-artifact-"));
    await writeFile(join(dir, "report.xlsx"), Buffer.alloc(4));
    await expect(localArtifactTargetPath(dir, "report.xlsx", Buffer.alloc(4))).resolves.toBe(
      join(dir, "report.xlsx"),
    );
  });

  it("steps aside for a different file with the same name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rakazo-artifact-"));
    await writeFile(join(dir, "report.xlsx"), Buffer.alloc(4));
    await expect(localArtifactTargetPath(dir, "report.xlsx", Buffer.alloc(99))).resolves.toBe(
      join(dir, "report (2).xlsx"),
    );
  });

  it("does not reuse an older version just because it has the same byte length", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rakazo-artifact-"));
    await writeFile(join(dir, "report.xlsx"), Buffer.from([1, 2, 3, 4]));
    await expect(
      localArtifactTargetPath(dir, "report.xlsx", Buffer.from([4, 3, 2, 1])),
    ).resolves.toBe(join(dir, "report (2).xlsx"));
    expect(await readFile(join(dir, "report.xlsx"))).toEqual(Buffer.from([1, 2, 3, 4]));
  });
});

describe("artifact source actions", () => {
  async function sourceFixture() {
    const f = await fixture({ id: "artifact-1", name: "renamed.xlsx", storageKey: "key-1" });
    const source = join(f.dir, "original.xlsx");
    await writeFile(source, "source content");
    f.findFirst.mockResolvedValue({ id: "artifact-1", name: "renamed.xlsx", storageKey: "key-1",
      mimeType: "application/octet-stream", botId: "bot-1", runId: "run-1" } as never);
    const effects = vi.fn(async () => [{ request: { path: "exports/original.xlsx" },
      result: { ok: true, artifactId: "artifact-1", path: "exports/original.xlsx" } }]);
    const resolve = vi.fn(async () => source);
    const deps = { ...f.deps, prisma: { artifact: { findFirst: f.findFirst }, externalEffect: { findMany: effects } } as unknown as PrismaClient,
      resolveSourceDocument: resolve };
    return { ...f, deps, source, effects, resolve };
  }
  it("opens the exact historical attachment bytes even when the source was changed later", async () => {
    const f = await sourceFixture();
    await openLocalArtifactFile(f.deps, actor, { artifactId: "artifact-1", action: "open", version: "attachment" });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.get).toHaveBeenCalledTimes(1);
    const launched = f.open.mock.calls[0]![0];
    expect(launched).not.toBe(f.source);
    expect(await readFile(launched)).toEqual(Buffer.from([1,2,3,4]));
    expect(await readFile(f.source, "utf8")).toBe("source content");
  });
  it("still reveals only the real source for attachment-version requests", async () => {
    const f = await sourceFixture();
    await openLocalArtifactFile(f.deps, actor, { artifactId: "artifact-1", action: "reveal", version: "attachment" });
    expect(f.open).toHaveBeenCalledWith(await realpath(f.source), "reveal");
    expect(f.get).not.toHaveBeenCalled();
  });
  it("reports verified source metadata without downloading or launching", async () => {
    const f = await sourceFixture();
    expect(await localArtifactInfo(f.deps, actor, "artifact-1")).toEqual({ sourcePath: await realpath(f.source) });
    expect(f.open).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });
  it("does not expose local source paths when not running on the local Mac", async () => {
    const f = await sourceFixture();
    expect(await localArtifactInfo({ ...f.deps, localHost: false }, actor, "artifact-1")).toEqual({ sourcePath: null });
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it.each(["open", "reveal"] as const)("%s launches the recorded original without retrieving attachment bytes", async action => {
    const f = await sourceFixture();
    await openLocalArtifactFile(f.deps, actor, { artifactId: "artifact-1", action });
    expect(f.open).toHaveBeenCalledWith(await realpath(f.source), action);
    expect(f.get).not.toHaveBeenCalled();
    expect(f.resolve).toHaveBeenCalledWith("bot-1", "exports/original.xlsx");
    expect(await readdir(f.dir)).toEqual(["original.xlsx"]);
    expect(f.effects).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      spaceId: "space-1", runId: "run-1", status: "completed", kind: "attach_file",
      run: { botId: "bot-1", userId: "user-1", spaceId: "space-1" },
    }) }));
  });
  it("never locates a same-name file from a different artifact operation", async () => {
    const f = await sourceFixture();
    f.effects.mockResolvedValue([{ request: { path: "exports/original.xlsx" }, result: {
      ok: true, artifactId: "another-artifact", path: "exports/original.xlsx",
    } }]);
    await expect(openLocalArtifactFile(f.deps, actor, { artifactId: "artifact-1", action: "reveal" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });
  it("does not launch a non-document source disguised with a document title", async () => {
    const f = await sourceFixture();
    const unsafe = join(f.dir, "original.command");
    await writeFile(unsafe, "test placeholder");
    f.resolve.mockResolvedValue(unsafe);
    await expect(openLocalArtifactFile(f.deps, actor, { artifactId: "artifact-1", action: "open" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(f.open).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });
  it("does not download or launch when the source is missing", async () => {
    const f = await sourceFixture();
    f.resolve.mockResolvedValue(join(f.dir, "missing.xlsx"));
    await expect(openLocalArtifactFile(f.deps, actor, { artifactId: "artifact-1", action: "reveal" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.open).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });
  it("refuses paths that differ between the request and successful receipt", async () => {
    const f = await sourceFixture();
    f.effects.mockResolvedValue([{ request: { path: "exports/original.xlsx" }, result: {
      ok: true, artifactId: "artifact-1", path: "exports/different.xlsx",
    } }]);
    await expect(openLocalArtifactFile(f.deps, actor, { artifactId: "artifact-1", action: "reveal" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });
});
