import { mkdtemp, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext, MemoryCommitRequest, MemoryReadRequest, MemoryStore } from "@livingbot/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@livingbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { readNativeWorkspaceFile, writeNativeWorkspaceFile } from "./openclaw-workspace-files.js";
import { OpenClawWorkspaceMemoryStore } from "./openclaw-workspace-memory.js";

const context: AdapterContext = {
  spaceId: "space", userId: "owner", botId: "bot", traceId: "test", operationId: "test",
  signal: new AbortController().signal,
};
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rakazo-native-memory-")));
  const mirrorRows: Array<{ id: string; scope: string; botId?: string; path: string; content: string; revision: number }> = [
    { id: "legacy-id", scope: "bot", botId: "bot", path: "memory.md", content: "old", revision: 7 },
  ];
  const history: string[] = [];
  const mirror = {
    async read(request: MemoryReadRequest) {
      return { documents: mirrorRows.filter(doc =>
        doc.scope === request.scope && doc.botId === request.botId && (!request.path || doc.path === request.path))
        .map(doc => ({ ...doc })) };
    },
    async commit(request: MemoryCommitRequest) {
      let row = mirrorRows.find(doc =>
        doc.scope === request.scope && doc.botId === request.botId && doc.path === request.path);
      if (request.expectedRevision !== undefined && request.expectedRevision !== (row?.revision ?? 0))
        throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
      if (row) { history.push(row.content); row.content = request.content; row.revision++; }
      else { row = { id: `id-${mirrorRows.length}`, scope: request.scope, botId: request.botId,
        path: request.path, content: request.content, revision: 1 }; mirrorRows.push(row); }
      return { ...row };
    },
    remove: vi.fn(),
  } as unknown as MemoryStore;
  const trash = vi.fn(async () => {});
  const store = new OpenClawWorkspaceMemoryStore({
    mirror, trash,
    async resolve(request, actor) {
      if (request.botId !== "bot" || actor.spaceId !== "space" || actor.userId !== "owner")
        throw new Error("tenant rejected");
      return { root, aliases: { "memory.md": "MEMORY.md" } };
    },
    withLock: async (_key, work) => work(),
  });
  await writeFile(join(root, "MEMORY.md"), "old");
  return { root, store, mirror, mirrorRows, history, trash };
}
const read = { scope: "bot" as const, botId: "bot" };
describe("native file memory", () => {
  it("discovers engine-created files and preserves imported IDs and revisions", async () => {
    const { root, store, history } = await setup();
    await writeFile(join(root, "MEMORY.md"), "engine update");
    await mkdir(join(root, "memory"));
    await writeFile(join(root, "memory", "new.md"), "new finding");
    const docs = (await store.read(read, context)).documents;
    expect(docs.find(doc => doc.path === "MEMORY.md")).toMatchObject({
      id: "legacy-id", revision: 8, content: "engine update",
    });
    expect(docs.some(doc => doc.path === "memory/new.md")).toBe(true);
    expect(history).toEqual(["old"]);
    await store.read(read, context);
    expect(history).toEqual(["old"]);
  });
  it("a stale UI edit conflicts after a native engine write", async () => {
    const { root, store } = await setup();
    await writeFile(join(root, "MEMORY.md"), "new native facts");
    await expect(store.commit({ ...read, path: "memory.md", content: "stale UI", expectedRevision: 7 }, context))
      .rejects.toThrow(MEMORY_REVISION_CONFLICT_ERROR);
    expect(await readFile(join(root, "MEMORY.md"), "utf8")).toBe("new native facts");
  });
  it("edits the actual file and retains both file preimage and database history", async () => {
    const { root, store, history } = await setup();
    const result = await store.commit({ ...read, path: "memory.md", content: "saved", expectedRevision: 7 }, context);
    expect(result).toMatchObject({ id: "legacy-id", revision: 8, path: "MEMORY.md" });
    expect(await readFile(join(root, "MEMORY.md"), "utf8")).toBe("saved");
    const [folder] = await readdir(join(root, ".rakazo", "file-history"));
    const [file] = await readdir(join(root, ".rakazo", "file-history", folder!));
    expect(await readFile(join(root, ".rakazo", "file-history", folder!, file!), "utf8")).toBe("old");
    expect(history).toEqual(["old"]);
  });
  it("uses Trash and never deletes the stored revision history", async () => {
    const { root, store, mirror, trash } = await setup();
    await mkdir(join(root, "memory"));
    await writeFile(join(root, "memory", "note.md"), "retained");
    const doc = (await store.read(read, context)).documents.find(row => row.path === "memory/note.md")!;
    expect(await store.remove({ ...read, id: "other", path: doc.path }, context)).toEqual({ removed: false });
    expect(await store.remove({ ...read, id: doc.id, path: doc.path }, context)).toEqual({ removed: true });
    expect(trash).toHaveBeenCalledWith(join(root, "memory", "note.md"));
    expect(mirror.remove).not.toHaveBeenCalled();
  });
  it("rejects symlink, traversal, unrelated workspace files and cross-tenant requests", async () => {
    const { root, store } = await setup();
    const outside = await mkdtemp(join(tmpdir(), "rakazo-native-outside-"));
    await writeFile(join(outside, "secret.md"), "private");
    await symlink(outside, join(root, "memory"));
    await expect(store.read(read, context)).rejects.toThrow("symlink");
    await expect(readNativeWorkspaceFile(root, "../secret.md")).rejects.toThrow("Unsafe");
    await expect(store.read({ ...read, path: ".env" }, context)).rejects.toThrow("Not a native");
    await expect(store.read(read, { ...context, spaceId: "another-space" })).rejects.toThrow("tenant");
  });
  it("refuses a file edit with a changed preimage and protects core memory from removal", async () => {
    const { root, store } = await setup();
    await expect(writeNativeWorkspaceFile(root, "MEMORY.md", "bad overwrite", "outdated"))
      .rejects.toThrow(MEMORY_REVISION_CONFLICT_ERROR);
    await expect(store.remove({ ...read, path: "memory.md" }, context)).rejects.toThrow("Core context");
    expect(await readFile(join(root, "MEMORY.md"), "utf8")).toBe("old");
  });
});

it("detects a migrated/core identity collision before committing any revisions", async () => {
  const f = await setup();
  await mkdir(join(f.root, "memory"));
  await writeFile(join(f.root, "memory/legacy.md"), "legacy text");
  f.mirrorRows[0] = { id: "legacy-id", scope: "bot", botId: "bot", path: "MEMORY.md", content: "legacy text", revision: 7 };
  const commit = vi.spyOn(f.mirror, "commit");
  const store = new OpenClawWorkspaceMemoryStore({ mirror: f.mirror, trash: f.trash,
    resolve: async () => ({ root: f.root, aliases: { "MEMORY.md": "memory/legacy.md" } }),
    withLock: async (_k, work) => work() });
  await expect(store.read(read, context)).rejects.toThrow("identity collision");
  expect(commit).not.toHaveBeenCalled();
  // An explicit identity migration preserves the old row and its revision.
  f.mirrorRows[0]!.path = "memory/legacy.md";
  const migrated = new OpenClawWorkspaceMemoryStore({ mirror: f.mirror, trash: f.trash,
    resolve: async () => ({ root: f.root, aliases: {} }), withLock: async (_k, work) => work() });
  const docs = (await migrated.read(read, context)).documents;
  expect(docs.find(d => d.path === "memory/legacy.md")).toMatchObject({ id: "legacy-id", revision: 7, content: "legacy text" });
  expect(docs.find(d => d.path === "MEMORY.md")).toMatchObject({ content: "old", revision: 1 });
  await migrated.commit({ ...read, path: "MEMORY.md", content: "new current memory", expectedRevision: 1 }, context);
  expect(await readFile(join(f.root, "memory/legacy.md"), "utf8")).toBe("legacy text");
  expect(await readFile(join(f.root, "MEMORY.md"), "utf8")).toBe("new current memory");
});
