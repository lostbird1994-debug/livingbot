import type {
  AdapterContext, MemoryCommitRequest, MemoryExportRequest, MemoryReadRequest,
  MemoryRemoveRequest, MemoryRevision, MemorySearchRequest, MemoryStore, PortableFile,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import {
  listNativeMemoryFiles, nativeWorkspacePath, readNativeWorkspaceFile, writeNativeWorkspaceFile,
} from "./openclaw-workspace-files.js";

export interface NativeMemoryWorkspace {
  root: string;
  /** Exact old-to-new migration aliases, never guessed from basenames. */
  aliases?: Record<string, string>;
}
export interface NativeWorkspaceMemoryOptions {
  mirror: MemoryStore;
  resolve(request: MemoryReadRequest, context: AdapterContext): Promise<NativeMemoryWorkspace>;
  /** Database advisory lock shared by API and workers; scoped to one owner/workspace. */
  withLock<T>(scope: string, work: () => Promise<T>): Promise<T>;
  trash(path: string): Promise<void>;
}

/** Files own live content. The existing encrypted store retains IDs and revision history. */
export class OpenClawWorkspaceMemoryStore implements MemoryStore {
  constructor(private options: NativeWorkspaceMemoryOptions) {}
  describe() {
    return {
      id: "openclaw-workspace", contractVersion: "1", adapterVersion: "0.1.0",
      capabilities: { search: false, revisions: true, markdownPortable: true },
    };
  }
  private locked<T>(request: MemoryReadRequest, context: AdapterContext, work: () => Promise<T>) {
    return this.options.withLock(
      JSON.stringify(["native-memory", context.spaceId, context.userId, request.scope, request.botId ?? null]),
      work,
    );
  }
  private async refresh(request: MemoryReadRequest, context: AdapterContext) {
    const workspace = await this.options.resolve(request, context);
    const aliases = workspace.aliases ?? {};
    const stored = await this.options.mirror.read({ ...request, path: undefined }, context);
    const names = request.path
      ? [aliases[request.path] ?? request.path]
      : await listNativeMemoryFiles(workspace.root, request.scope === "user");
    // Validate the complete identity map before syncing any revisions. An old
    // alias must never make a live core file reuse another document's key.
    for (const name of names) {
      const existing = stored.documents.find(doc => (aliases[doc.path] ?? doc.path) === name);
      if (!existing && stored.documents.some(doc => doc.path === name))
        throw new Error("Memory document identity collision; preserve the legacy document under its migrated path before syncing");
    }
    const documents: Awaited<ReturnType<MemoryStore["read"]>>["documents"] = [];
    for (const name of names) {
      if (name !== "MEMORY.md" && !(request.scope === "user" && name === "USER.md") &&
        !/^memory\/.+\.md$/i.test(name) &&
        !(request.path && aliases[request.path] === name && /^\.rakazo\/memory-archive\/[a-f0-9]+\.md$/.test(name)))
        throw new Error("Not a native memory document");
      const content = await readNativeWorkspaceFile(workspace.root, name);
      if (content === undefined) continue;
      const existing = stored.documents.find(doc => (aliases[doc.path] ?? doc.path) === name);
      // Preserve the source document's identity and append, never rewrite, revisions.
      const path = existing?.path ?? name;
      const revision = existing?.content === content ? existing : await this.options.mirror.commit({
        scope: request.scope, botId: request.botId, path, content,
        expectedRevision: existing?.revision ?? 0,
      }, context);
      documents.push({ ...revision, path: name });
    }
    return { workspace, documents };
  }
  async read(request: MemoryReadRequest, context: AdapterContext) {
    return this.locked(request, context, async () => ({ documents: (await this.refresh(request, context)).documents }));
  }
  async commit(request: MemoryCommitRequest, context: AdapterContext): Promise<MemoryRevision> {
    return this.locked(request, context, async () => {
      const live = await this.refresh(request, context);
      const name = live.workspace.aliases?.[request.path] ?? request.path;
      if (name !== "MEMORY.md" && !(request.scope === "user" && name === "USER.md") &&
        !/^memory\/.+\.md$/i.test(name))
        throw new Error("Write identity and instructions through the bot profile editor");
      const current = live.documents.find(doc => doc.path === name);
      const actual = current?.revision ?? 0;
      if (request.expectedRevision !== undefined && actual !== request.expectedRevision)
        throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
      await writeNativeWorkspaceFile(live.workspace.root, name, request.content, current?.content);
      // A crash here is recoverable: next read mirrors the authoritative file.
      const stored = await this.options.mirror.read({ ...request, path: undefined }, context);
      const alias = stored.documents.find(doc =>
        (live.workspace.aliases?.[doc.path] ?? doc.path) === name);
      const saved = await this.options.mirror.commit({
        ...request, path: alias?.path ?? name, expectedRevision: alias?.revision ?? 0,
      }, context);
      return { ...saved, path: name };
    });
  }
  async remove(request: MemoryRemoveRequest, context: AdapterContext) {
    return this.locked(request, context, async () => {
      const live = await this.refresh(request, context);
      const name = live.workspace.aliases?.[request.path] ?? request.path;
      const document = live.documents.find(doc => doc.path === name && (!request.id || doc.id === request.id));
      if (!document) return { removed: false };
      if (name === "MEMORY.md" || name === "USER.md")
        throw new Error("Core context files can be edited, not removed");
      await this.options.trash(await nativeWorkspacePath(live.workspace.root, name));
      // Keep the database document and all revisions for recovery.
      return { removed: true };
    });
  }
  async search(_request: MemorySearchRequest, _context: AdapterContext): Promise<never> {
    throw new Error("Use the native engine memory_search and memory_get tools");
  }
  async *exportMarkdown(request: MemoryExportRequest, context: AdapterContext): AsyncIterable<PortableFile> {
    for (const scope of request.scope === "all" ? ["bot", "user"] as const : [request.scope]) {
      if (scope === "bot" && !request.botId) continue;
      const snapshot = await this.read({ scope, botId: scope === "bot" ? request.botId : undefined }, context);
      for (const doc of snapshot.documents)
        yield { path: `${request.scope === "all" ? `${scope}/` : ""}${doc.path}`, content: new TextEncoder().encode(doc.content) };
    }
  }
  async importMarkdown(files: AsyncIterable<PortableFile>, context: AdapterContext): Promise<MemoryRevision> {
    let last: MemoryRevision | undefined;
    for await (const file of files)
      last = await this.commit({ scope: "user", path: file.path, content: new TextDecoder().decode(file.content) }, context);
    if (!last) throw new Error("No memory files to import");
    return last;
  }
}
