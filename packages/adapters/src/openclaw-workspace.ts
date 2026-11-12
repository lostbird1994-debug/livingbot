import { createHash } from "node:crypto";
import { posix } from "node:path";

export interface WorkspaceSourceDocument {
  id: string;
  scope: "bot" | "user";
  botId?: string | null;
  path: string;
  content: string;
  revision: number;
}
export interface WorkspaceSourceBot {
  id: string;
  spaceId: string;
  name: string;
  description?: string;
  instructions?: string;
  roleCard?: {
    identity?: string; personality?: string; userIdentity?: string; backstory?: string;
  } | null;
}
export interface WorkspaceFilePlan {
  files: Record<string, string>;
  sources: Array<{ documentId: string; originalPath: string; path: string; revision: number; sha256: string }>;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function nativeBotAgentId(spaceId: string, botId: string) {
  return `rakazo-${digest(JSON.stringify([spaceId, botId])).slice(0, 32)}`;
}
function safeSourcePath(value: string) {
  if (
    !value || value.includes("\\") || value.includes("\0") || value.startsWith("/") ||
    value.split("/").some(part => part === "..")
  ) throw new Error("Unsafe source memory path");
  const path = posix.normalize(value);
  if (path === "." || path.startsWith("../")) throw new Error("Unsafe source memory path");
  return path;
}
function memoryPath(document: WorkspaceSourceDocument, shared: boolean) {
  const path = safeSourcePath(document.path);
  // Old tool-produced "bot:" prefixes and stale review artifacts remain
  // recoverable, but must not be indexed as current native facts.
  if (path.includes(":") || /^memory\/(archive|reviews)\//i.test(path))
    return `.rakazo/memory-archive/${digest(document.id).slice(0, 20)}.md`;
  if (path.toLowerCase() === "memory.md") return "MEMORY.md";
  if (shared && path.toLowerCase() === "user.md") return "USER.md";
  return path.startsWith("memory/") ? path : `memory/${path}`;
}
function addDocuments(
  plan: WorkspaceFilePlan, documents: WorkspaceSourceDocument[], shared: boolean,
) {
  const ordered = [...documents].sort((a, b) =>
    Number(b.path === "MEMORY.md") - Number(a.path === "MEMORY.md") || a.id.localeCompare(b.id));
  for (const document of ordered) {
    if (plan.sources.some(source => source.documentId === document.id))
      throw new Error("Duplicate source memory identity");
    let path = memoryPath(document, shared);
    if (Object.hasOwn(plan.files, path))
      path = `memory/migrated/${digest(document.id).slice(0, 20)}-${posix.basename(path)}`;
    if (Object.hasOwn(plan.files, path)) throw new Error("Native workspace file collision");
    plan.files[path] = document.content;
    plan.sources.push({
      documentId: document.id, originalPath: document.path, path,
      revision: document.revision, sha256: digest(document.content),
    });
  }
}
export function planBotWorkspace(bot: WorkspaceSourceBot, documents: WorkspaceSourceDocument[]): WorkspaceFilePlan {
  const card = bot.roleCard ?? {};
  const plan: WorkspaceFilePlan = {
    files: {
      "IDENTITY.md": [`# ${bot.name}`, card.identity?.trim() || bot.description?.trim()].filter(Boolean).join("\n\n") + "\n",
      "SOUL.md": card.personality ?? "",
      "AGENTS.md": bot.instructions ?? "",
      "USER.md": card.userIdentity ?? "",
    },
    sources: [],
  };
  const privateDocuments = documents.filter(document => document.scope === "bot" && document.botId === bot.id);
  addDocuments(plan, privateDocuments, false);
  plan.files["MEMORY.md"] ??= "";
  if (card.backstory?.trim()) {
    if (Object.hasOwn(plan.files, "memory/legacy-role-card.md")) throw new Error("Native workspace file collision");
    plan.files["memory/legacy-role-card.md"] = card.backstory;
  }
  return plan;
}
export function planSharedWorkspace(documents: WorkspaceSourceDocument[]): WorkspaceFilePlan {
  const plan: WorkspaceFilePlan = { files: {}, sources: [] };
  addDocuments(plan, documents.filter(document => document.scope === "user"), true);
  plan.files["MEMORY.md"] ??= "";
  return plan;
}
