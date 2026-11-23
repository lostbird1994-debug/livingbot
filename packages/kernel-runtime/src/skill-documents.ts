import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GatewayRequests } from "./contracts.ts";

export type SkillSummary = { key: string; name: string; description: string; source: string };
type NativeSkill = SkillSummary & { skillKey?: string; baseDir: string };
export type SkillDocument = {
  skill: SkillSummary;
  path: string;
  content: string;
  files: string[];
  changes: { at?: number; reason?: string; kind?: string }[];
};
const privateSources = new Set([
  "openclaw-workspace",
  "agents-skills-project",
  "openclaw-workshop",
]);
const readable = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".ts",
  ".js",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".html",
  ".css",
  ".toml",
  ".csv",
]);
/** Reads only files belonging to a skill discovered by the native catalog. No mutation surface. */
export class SkillDocuments {
  private readonly gateway: GatewayRequests;
  constructor(gateway: GatewayRequests) {
    this.gateway = gateway;
  }
  private async catalog(agentId: string) {
    const page = await this.gateway.request<{ skills: NativeSkill[] }>("skills.status", {
      agentId,
      refresh: true,
    });
    return (page.skills ?? []).map((skill) => ({
      ...skill,
      key: `${skill.source}:${skill.skillKey || skill.name}`,
    }));
  }
  async list(agentId: string): Promise<SkillSummary[]> {
    return (await this.catalog(agentId))
      .filter((skill) => privateSources.has(skill.source))
      .map(({ key, name, description, source }) => ({ key, name, description, source }));
  }
  async read(
    agentId: string,
    key: string,
    path = "SKILL.md",
    shared = false,
  ): Promise<SkillDocument> {
    const skill = (await this.catalog(agentId)).find((item) => item.key === key);
    if (!skill || privateSources.has(skill.source) === shared)
      throw new Error("未知技能或技能不属于当前范围");
    if (!skill.baseDir || !isAbsolute(skill.baseDir)) throw new Error("技能文档位置不可用");
    const root = await realpath(skill.baseDir);
    if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0"))
      throw new Error("无效文档路径");
    const target = resolve(root, path);
    const rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("文档路径越界");
    let current = root;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error("不读取符号链接文档");
    }
    const info = await lstat(target);
    if (!info.isFile() || info.size > 1024 * 1024 || !readable.has(extname(path).toLowerCase()))
      throw new Error("该文件不支持文本预览");
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    let content: string;
    try {
      if ((await file.stat()).size > 1024 * 1024) throw new Error("文档过大");
      content = await file.readFile("utf8");
    } finally {
      await file.close();
    }
    if (content.includes("\0")) throw new Error("该文件不支持文本预览");
    const files: string[] = [];
    async function walk(dir: string, prefix = "", depth = 0): Promise<void> {
      if (depth > 6) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink() || files.length >= 256) continue;
        const name = prefix + entry.name;
        if (entry.isDirectory()) await walk(join(dir, entry.name), `${name}/`, depth + 1);
        else if (entry.isFile() && readable.has(extname(name).toLowerCase())) files.push(name);
      }
    }
    await walk(root);
    let changes: SkillDocument["changes"] = [];
    if (skill.source === "openclaw-workshop") {
      const history = await this.gateway.request<{ changes: Record<string, unknown>[] }>(
        "skills.workshop.changes",
        { agentId, limit: 100 },
      );
      changes = (history.changes ?? [])
        .filter((x) => x.skillName === skill.name || x.name === skill.name)
        .map((x) => ({
          at: typeof x.createdAtMs === "number" ? x.createdAtMs : undefined,
          reason:
            typeof x.summary === "string"
              ? x.summary
              : typeof x.reason === "string"
                ? x.reason
                : undefined,
          kind:
            typeof x.action === "string"
              ? x.action
              : typeof x.kind === "string"
                ? x.kind
                : undefined,
        }));
    }
    return {
      skill: {
        key: skill.key,
        name: skill.name,
        description: skill.description,
        source: skill.source,
      },
      path,
      content,
      files: files.sort(),
      changes,
    };
  }
}
