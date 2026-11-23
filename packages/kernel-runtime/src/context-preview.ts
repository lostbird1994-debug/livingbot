import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export type NativeContextPreview = {
  engine: "openclaw";
  agentId: string;
  workspace: string;
  budgets: { document: number; total: number };
  documents: Array<{
    path: string;
    name: string;
    scope: "bot" | "user";
    content: string;
    excerpt: string;
    totalChars: number;
    shownChars: number;
  }>;
};

type BootstrapResolver = (options: Record<string, unknown>) => Promise<{
  bootstrapFiles: Array<{ name: string; path: string; content?: string; missing: boolean }>;
  contextFiles: Array<{ path: string; content: string }>;
}>;

async function resolveBootstrapContext(kernelEntry: string): Promise<BootstrapResolver> {
  const host = createRequire(kernelEntry).resolve("openclaw/plugin-sdk/agent-harness-runtime");
  const sdk = await import(pathToFileURL(host).href) as {
    resolveBootstrapContextForRun?: BootstrapResolver;
  };
  if (!sdk.resolveBootstrapContextForRun) throw new Error("OpenClaw context preview is unavailable");
  return sdk.resolveBootstrapContextForRun;
}

/** Preview the next ordinary turn with OpenClaw's own bootstrap implementation. */
export async function previewOpenClawContext(input: {
  kernelEntry: string;
  config: Record<string, any>;
  agentId: string;
  workspace: string;
  resolve?: BootstrapResolver;
}): Promise<NativeContextPreview> {
  const resolver = input.resolve ?? await resolveBootstrapContext(input.kernelEntry);
  const { bootstrapFiles, contextFiles } = await resolver({
    workspaceDir: input.workspace,
    config: input.config,
    agentId: input.agentId,
    contextMode: "full",
    runKind: "default",
  });
  const defaults = input.config.agents?.defaults ?? {};
  return {
    engine: "openclaw",
    agentId: input.agentId,
    workspace: input.workspace,
    budgets: {
      document: defaults.bootstrapMaxChars ?? 12_000,
      total: defaults.bootstrapTotalMaxChars ?? 60_000,
    },
    documents: bootstrapFiles.filter((file) => !file.missing).map((file) => {
      const excerpt = contextFiles.find((candidate) => candidate.path === file.path)?.content ?? "";
      return {
        path: file.path,
        name: file.name,
        scope: "bot" as const,
        content: file.content ?? "",
        excerpt,
        totalChars: file.content?.length ?? 0,
        shownChars: excerpt.length,
      };
    }),
  };
}
