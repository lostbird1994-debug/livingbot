import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { KernelAgentEntry } from "./openclaw-kernel-registry.js";
import { loadKernelManifest } from "./openclaw-kernel-registry.js";
import { readNativeWorkspaceFile } from "./openclaw-workspace-files.js";

interface BootstrapFile {
  name: string;
  path: string;
  content?: string;
  missing: boolean;
  /** Trusted bootstrap metadata consumed by the installed native renderer. */
  maxChars?: number;
}
export interface NativeBootstrapEvent {
  context: {
    agentId?: string;
    sessionKey?: string;
    workspaceDir: string;
    bootstrapFiles: BootstrapFile[];
  };
}
export interface NativeBootstrapPreview {
  engine: "openclaw";
  agentId: string;
  workspace: string;
  budgets: { document: number; total: number };
  documents: Array<{
    path: string; name: string; scope: "bot" | "user"; content: string;
    excerpt: string; totalChars: number; shownChars: number;
  }>;
}
const standard = new Set(["IDENTITY.md", "SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md", "TOOLS.md", "HEARTBEAT.md", "BOOTSTRAP.md"]);
const documentLimit = (name: string) => {
  switch (name.split("/").at(-1)) {
    case "MEMORY.md": return 25_000;
    case "TOOLS.md": return 20_000;
    default: return 12_000;
  }
};
type BootstrapResolver = (options: Record<string, unknown>) => Promise<{
  bootstrapFiles: BootstrapFile[]; contextFiles: Array<{ path: string; content: string }>;
}>;
async function engineBootstrapResolver(): Promise<BootstrapResolver> {
  const host = process.argv[1];
  if (!host) throw new Error("OpenClaw engine host is unavailable");
  const sdk = createRequire(host).resolve("openclaw/plugin-sdk/agent-harness-runtime");
  const runtime = await import(pathToFileURL(sdk).href);
  if (typeof runtime.resolveBootstrapContextForRun !== "function")
    throw new Error("OpenClaw bootstrap preview is unavailable");
  return runtime.resolveBootstrapContextForRun;
}

/** Runs inside OpenClaw: previews use the same public bootstrap implementation as real calls. */
export class NativeWorkspaceContext {
  constructor(private options: {
    registryFile: string;
    config(): Record<string, any>;
    bootstrap?: BootstrapResolver;
  }) {}

  private async byAgent(agentId: string) {
    return (await loadKernelManifest(this.options.registryFile)).bots.find(entry => entry.agentId === agentId);
  }

  async bootstrap(event: NativeBootstrapEvent, privateContextAllowed = true) {
    if (!event.context.agentId) return;
    const entry = await this.byAgent(event.context.agentId);
    if (!entry) return; // Other native agents are outside this installation's registry.
    if (resolve(event.context.workspaceDir) !== resolve(entry.workspace))
      throw new Error("Native bootstrap workspace ownership mismatch");
    const files: BootstrapFile[] = [];
    for (const file of event.context.bootstrapFiles) {
      if (file.path.startsWith(`${entry.sharedWorkspace}/`)) continue;
      if (!privateContextAllowed && ["MEMORY.md", "USER.md"].includes(file.name)) continue;
      if (!standard.has(file.name) || resolve(file.path) !== join(resolve(entry.workspace), file.name)) {
        files.push(file);
        continue;
      }
      // Reload each turn: native bootstrap caches must not hide edits made in the UI.
      const content = await readNativeWorkspaceFile(entry.workspace, file.name);
      files.push({ ...file, content, missing: content === undefined });
    }
    // MEMORY.md may have been created since this session's bootstrap was cached.
    for (const name of ["IDENTITY.md", "SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md"]) {
      if (!privateContextAllowed && ["MEMORY.md", "USER.md"].includes(name)) continue;
      if (files.some(file => file.path === join(entry.workspace, name))) continue;
      const content = await readNativeWorkspaceFile(entry.workspace, name);
      if (content !== undefined) files.push({ name, path: join(entry.workspace, name), content, missing: false });
    }
    for (const name of ["USER.md", "MEMORY.md"]) {
      if (!privateContextAllowed) continue;
      const content = await readNativeWorkspaceFile(entry.sharedWorkspace, name);
      if (content?.trim()) files.push({
        name: `工作区共享/${name}`, path: join(entry.sharedWorkspace, name), content, missing: false,
      });
    }
    // OpenClaw's plugin hook wrapper shallow-copies context, while retaining this array.
    // Mutate the shared array so the real bootstrap sees removals and refreshed contents.
    event.context.bootstrapFiles.splice(0, event.context.bootstrapFiles.length,
      ...files.map(file => ({ ...file, maxChars: documentLimit(file.name) })));
  }

  async preview(params: Record<string, unknown>): Promise<NativeBootstrapPreview> {
    const { botId, spaceId, userId } = params;
    const entry = (await loadKernelManifest(this.options.registryFile)).bots.find(bot =>
      bot.botId === botId && bot.spaceId === spaceId && bot.userId === userId);
    if (!entry) throw new Error("Native context ownership is not confirmed");
    const config = this.options.config();
    const resolver = this.options.bootstrap ?? await engineBootstrapResolver();
    // No session key avoids the cache and gives an ordinary full-context next-run preview.
    const { bootstrapFiles, contextFiles } = await resolver({
      workspaceDir: entry.workspace, config, agentId: entry.agentId, contextMode: "full", runKind: "default",
    });
    return {
      engine: "openclaw", agentId: entry.agentId, workspace: entry.workspace,
      budgets: {
        document: config.agents?.defaults?.bootstrapMaxChars ?? 12_000,
        total: config.agents?.defaults?.bootstrapTotalMaxChars ?? 60_000,
      },
      documents: bootstrapFiles.filter(file => !file.missing).map(file => {
        const embedded = contextFiles.find(candidate => resolve(candidate.path) === resolve(file.path));
        return {
          path: file.path, name: file.name,
          scope: file.path.startsWith(`${entry.sharedWorkspace}/`) ? "user" : "bot",
          content: file.content ?? "", excerpt: embedded?.content ?? "",
          totalChars: file.content?.length ?? 0, shownChars: embedded?.content.length ?? 0,
        };
      }),
    };
  }

  async guidance(agentId: string, privateContextAllowed = true) {
    const entry: KernelAgentEntry | undefined = await this.byAgent(agentId);
    if (!entry) return;
    return {
      appendSystemContext: [
        `Your Rakazo bot ID is ${entry.botId}. Your actual workspace is ${entry.workspace}.`,
        privateContextAllowed
          ? `Workspace-shared user profile and memory are in ${entry.sharedWorkspace}; this is scoped to your Rakazo workspace and owner, never global.`
          : "This channel has no access to workspace-shared or private profiles and memory.",
        !privateContextAllowed ? "" : entry.chief
          ? "You are this workspace's Chief. Maintain shared USER.md, MEMORY.md and shared memory/ here; preserve useful facts, revision history and sources."
          : "Maintain your own MEMORY.md and memory/. Ask this workspace's Chief to consolidate shared facts rather than rewriting shared summaries yourself.",
        privateContextAllowed
          ? "Use memory_search/memory_get for private native memory. Shared files can be read explicitly. Never use another agent's private workspace as memory."
          : "This is an external messaging conversation. Do not read, search, write or disclose private or shared USER.md, MEMORY.md or memory/. Do not use the private app conversation as channel history.",
        "Never permanently delete user files, memories, history, outputs, caches or test fixtures. Cleanup means moving confirmed obsolete items to macOS Trash and reporting original and recoverable paths. Never automatically replace, relocate or clean a formal database.",
      ].filter(Boolean).join("\n"),
    };
  }
}
