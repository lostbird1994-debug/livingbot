import type { GatewayRequests } from "./contracts.ts";
import { removedServiceDefinition } from "./connections.ts";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { containsPath } from "./paths.ts";

export type KernelCapability = {
  id: string;
  name: string;
  description: string;
  kind: "method" | "tool" | "service";
  source: string;
  enabled: boolean;
  ready: boolean;
  manageable: boolean;
  reason?: string;
  nativeName: string;
  nativeKind: "skill" | "tool" | "service";
  nativeSource?: string;
  nativeDescription?: string;
  skillKey?: string;
  bundled?: boolean;
  global?: boolean;
};

export interface CapabilityProvider {
  read(agentId: string, sessionKey: string, known?: KernelCapability[]): Promise<KernelCapability[]>;
  setEnabled(agentId: string, capability: KernelCapability, enabled: boolean): Promise<void>;
  prepareServices?(agentId: string, sessionKey: string, services: Record<string, boolean>): Promise<void>;
  refreshMethods?(agentId: string): Promise<void>;
  readGlobal?(known?: KernelCapability[]): Promise<KernelCapability[]>;
  refreshGlobal?(skillDirectories?: string[]): Promise<void>;
  setGlobalEnabled?(capability: KernelCapability, enabled: boolean): Promise<void>;
}

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function rows(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(object) : [];
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }

/** Retire only the fields written by the old per-agent capability controls. */
function sharedInheritance(config: RecordValue): { patch: RecordValue; replacePaths: string[] } {
  const agents = object(config.agents);
  const replacePaths: string[] = [];
  const inherit = (entry: RecordValue, path: string): RecordValue => {
    const patch: RecordValue = {};
    if (Object.hasOwn(entry, "skills")) {
      patch.skills = null;
      replacePaths.push(`${path}.skills`);
    }
    if (Object.hasOwn(object(entry.tools), "deny")) {
      patch.tools = { deny: null };
      replacePaths.push(`${path}.tools.deny`);
    }
    return patch;
  };
  const defaults = inherit(object(agents.defaults), "agents.defaults");
  const entries: RecordValue = {};
  for (const [id, entry] of Object.entries(object(agents.entries))) {
    const patch = inherit(object(entry), `agents.entries.${id}`);
    if (Object.keys(patch).length) entries[id] = patch;
  }
  return {
    patch: replacePaths.length ? { agents: {
      ...(Object.keys(defaults).length ? { defaults } : {}),
      ...(Object.keys(entries).length ? { entries } : {}),
    } } : {},
    replacePaths,
  };
}

// Compare complete installed packages, not just their instructions. Never copy,
// rename or overwrite an installation while making its existing root shared.
async function skillDigest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(path: string, relative: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("共享技能包含符号链接，请先检查安装来源");
    if (info.isDirectory()) {
      hash.update(JSON.stringify(["directory", relative]));
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), `${relative}/${name}`);
    } else if (info.isFile()) {
      hash.update(JSON.stringify(["file", relative, info.mode & 0o111, info.size]));
      hash.update(await readFile(path));
    } else throw new Error("共享技能包含不支持的文件");
  }
  await visit(directory, "");
  return hash.digest("hex");
}

const methodLabels: Record<string, string> = {
  "livingbot-text-revisions": "精确文本修订",
  "livingbot-batch-work": "批量处理",
};

const toolLabels: Record<string, string> = {
  read: "读取文件", write: "创建文件", edit: "修改文件", apply_patch: "精确修改文件",
  ls: "浏览文件夹", exec: "运行本机命令", process: "管理运行中的程序",
  memory_search: "回忆信息", memory_get: "查看记忆来源", ask_user: "向你提问",
  web_search: "搜索网页", web_fetch: "阅读网页", browser: "操作浏览器",
  cron: "安排定时工作", image: "查看图片", imagegen: "制作图片",
  sessions_history: "查阅会话记录", sessions_list: "查看会话", sessions_spawn: "分派协作任务",
  sessions_send: "向其他会话发送消息", sessions_yield: "等待协作结果", message: "发送消息",
  livingbot_conversations: "回顾对话", livingbot_deliver_file: "交付文件", livingbot_report_privately: "私聊汇报",
  livingbot_assign_group: "分派群内工作",
  call_user: "语音来电", end_call: "结束通话",
};

/** Official operator reads/configuration. Raw config and credentials never leave this adapter. */
export class OpenClawCapabilities implements CapabilityProvider {
  private readonly gateway: GatewayRequests;

  constructor(gateway: GatewayRequests) { this.gateway = gateway; }

  async refreshMethods(agentId: string): Promise<void> {
    await this.gateway.request("skills.status", { agentId, refresh: true });
  }

  async read(agentId: string, sessionKey: string, known: KernelCapability[] = []): Promise<KernelCapability[]> {
    return this.inventory(agentId, sessionKey, known);
  }

  private async globalAgent(): Promise<string> {
    const snapshot = await this.gateway.request<RecordValue>("config.get", {});
    const entries = object(object(snapshot.config).agents);
    const agents = Object.entries(object(entries.entries));
    const agent = agents.find(([, value]) => object(value).default === true) ?? agents[0];
    if (!agent) throw new Error("No kernel agent is configured");
    return agent[0];
  }

  async readGlobal(known: KernelCapability[] = []): Promise<KernelCapability[]> {
    const agentId = await this.globalAgent();
    // A dedicated operator inventory has no conversation-specific permissions.
    return this.inventory(agentId, `agent:${agentId}:explicit:livingbot-global-abilities`, known, true);
  }

  async refreshGlobal(skillDirectories: string[] = []): Promise<void> {
    const snapshot = await this.gateway.request<RecordValue>("config.get", {});
    const config = object(snapshot.config);
    const existing = strings(object(object(config.skills).load).extraDirs);
    const inheritance = sharedInheritance(config);
    const directories = new Set(existing);
    for (const directory of skillDirectories) {
      if (!isAbsolute(directory)) throw new Error("Shared skill directory must be absolute");
      const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) continue;
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("请检查共享技能安装目录");
      directories.add(directory);
    }
    if (directories.size !== new Set(existing).size) {
      // Native discovery supplies canonical names/skillKeys and the winning
      // package paths. Include every existing agent before changing precedence.
      const inventories = await Promise.all(Object.keys(object(object(config.agents).entries)).map((agentId) =>
        this.gateway.request<RecordValue>("skills.status", { agentId })));
      const packages = new Map<string, { path: string; digest?: string }>();
      for (const inventory of inventories) for (const skill of rows(inventory.skills)) {
        const name = text(skill.name);
        const path = text(skill.baseDir);
        if (!name || !path) continue;
        const previous = packages.get(name);
        if (!previous) { packages.set(name, { path }); continue; }
        if (previous.path === path) continue;
        previous.digest ??= await skillDigest(previous.path);
        if (previous.digest !== await skillDigest(path)) {
          throw new Error(`同名技能内容不同，保留原安装并先选择版本：${name}`);
        }
      }
    }
    const addedDirectories = directories.size !== new Set(existing).size;
    if (addedDirectories || inheritance.replacePaths.length) {
      if (!text(snapshot.hash)) throw new Error("Configuration revision is unavailable");
      await this.gateway.request("config.patch", {
        baseHash: snapshot.hash,
        raw: JSON.stringify({
          ...inheritance.patch,
          ...(addedDirectories ? { skills: { load: { extraDirs: [...directories] } } } : {}),
        }),
        replacePaths: [
          ...inheritance.replacePaths,
          ...(addedDirectories ? ["skills.load.extraDirs"] : []),
        ], response: "summary",
      });
      const confirmed = await this.gateway.request<RecordValue>("config.get", {});
      const applied = strings(object(object(object(confirmed.config).skills).load).extraDirs);
      if (![...directories].every((directory) => applied.includes(directory))) {
        throw new Error("公共技能目录配置尚未确认，请刷新后重试");
      }
      if (sharedInheritance(object(confirmed.config)).replacePaths.length) {
        throw new Error("公共能力继承配置尚未确认，请刷新后重试");
      }
    }
    await this.refreshMethods(await this.globalAgent());
  }

  async setGlobalEnabled(capability: KernelCapability, enabled: boolean): Promise<void> {
    if (!capability.manageable) throw new Error("This ability is controlled by shared settings");
    const snapshot = await this.gateway.request<RecordValue>("config.get", {});
    const config = object(snapshot.config);
    const inheritance = sharedInheritance(config);
    if (!text(snapshot.hash)) throw new Error("Configuration revision is unavailable");
    let patch: RecordValue;
    let replacePaths: string[] = [];
    if (capability.nativeKind === "skill") {
      patch = { skills: { entries: { [capability.skillKey || capability.nativeName]: { enabled } } } };
    } else if (capability.nativeKind === "service") {
      const server = object(object(config.mcp).servers)[capability.nativeName];
      if (!server || removedServiceDefinition(server)) throw new Error("Unknown shared connection");
      patch = { mcp: { servers: { [capability.nativeName]: { enabled } } } };
    } else {
      const deny = new Set(strings(object(config.tools).deny));
      if (enabled) deny.delete(capability.nativeName);
      else deny.add(capability.nativeName);
      patch = { tools: { deny: [...deny] } };
      replacePaths = ["tools.deny"];
    }
    await this.gateway.request("config.patch", {
      baseHash: snapshot.hash, raw: JSON.stringify({ ...inheritance.patch, ...patch }),
      replacePaths: [...inheritance.replacePaths, ...replacePaths], response: "summary",
    });
    if (inheritance.replacePaths.length) {
      const confirmed = await this.gateway.request<RecordValue>("config.get", {});
      if (sharedInheritance(object(confirmed.config)).replacePaths.length) {
        throw new Error("公共能力继承配置尚未确认，请刷新后重试");
      }
    }
  }

  private async inventory(agentId: string, sessionKey: string, known: KernelCapability[], global = false): Promise<KernelCapability[]> {
    // This formal create-or-adopt operation materializes an empty session.
    // It starts no model turn and preserves existing session settings/history.
    await this.gateway.request("sessions.create", {
      agentId, key: sessionKey, idempotencyKey: `livingbot-session:${sessionKey}`,
    });
    const [catalog, skills, effective, snapshot, described] = await Promise.all([
      this.gateway.request<RecordValue>("tools.catalog", { agentId }),
      this.gateway.request<RecordValue>("skills.status", { agentId }),
      this.gateway.request<RecordValue>("tools.effective", { agentId, sessionKey }),
      this.gateway.request<RecordValue>("config.get", {}),
      this.gateway.request<RecordValue>("sessions.describe", { key: sessionKey, agentId }),
    ]);
    const activeTools = rows(effective.groups).flatMap((group) => rows(group.tools));
    const servers = object(object(object(snapshot.config).mcp).servers);
    const agent = object(object(object(object(snapshot.config).agents).entries)[agentId]);
    const denied = new Set(strings(object(global ? object(snapshot.config).tools : agent.tools).deny));
    const serviceOverrides = global ? {} : object(object(object(described.session).toolOverrides).mcpServers);
    const notices = rows(effective.notices);
    const serverReason = (name: string): string | undefined => {
      const matching = notices.filter((notice) =>
        strings(notice.servers).includes(name) || notice.id === `mcp-server-diagnostic:${name}`);
      if (matching.some((notice) => notice.id === `mcp-server-diagnostic:${name}`)) return "服务暂不可用，请检查连接或授权";
      if (matching.some((notice) => notice.id === "mcp-stale-catalog")) return "配置已更新，等待下次任务重新连接";
      if (matching.some((notice) => notice.id === "mcp-not-yet-listed")) return "已连接，等待读取能力";
      if (matching.some((notice) => notice.id === "mcp-not-yet-connected")) return "已配置，尚未连接";
      return undefined;
    };
    const result: KernelCapability[] = [];
    for (const [name, raw] of Object.entries(servers)) {
      if (removedServiceDefinition(raw)) continue;
      const globalEnabled = object(raw).enabled !== false;
      const enabled = globalEnabled && serviceOverrides[name] !== false;
      const availableTools = activeTools.some((tool) =>
        tool.source === "mcp" && tool.mcpServer === name && tool.deniedBySession !== true);
      const reason = !globalEnabled ? "已在公共连接设置中停用" : !enabled ? "未为这位伙伴启用" : serverReason(name) ??
        (!availableTools ? "尚未发现可用工具" : undefined);
      result.push({
        id: `service:mcp:${name}`, name, description: "", kind: "service", source: "mcp",
        enabled, ready: enabled && availableTools && !reason, manageable: global || globalEnabled,
        ...(reason ? { reason } : {}),
        nativeName: name, nativeKind: "service", nativeSource: "mcp", ...(global ? { global: true } : {}),
      });
    }
    for (const skill of rows(skills.skills)) {
      const name = text(skill.name);
      if (!name) continue;
      const blocked = skill.disabled === true || skill.blockedByAllowlist === true;
      const source = text(skill.source);
      const localSkill = source === "openclaw-workspace" || source === "agents-skills-project";
      const sharedRoots = strings(object(object(object(snapshot.config).skills).load).extraDirs);
      const unshared = global && (source === "openclaw-workshop" || localSkill &&
        !sharedRoots.some((root) => isAbsolute(root) && text(skill.baseDir) && containsPath(root, text(skill.baseDir))));
      if (unshared) continue;
      const enabled = !blocked && (global || skill.blockedByAgentFilter !== true);
      const missing = object(skill.missing);
      result.push({
        id: global ? `skill:${text(skill.skillKey) || name}` :
          `skill:${text(skill.source)}:${name}${skill.bundled === true ? "" : `:${agentId}`}`,
        name: methodLabels[name] ?? name, description: text(skill.description), kind: "method", source: text(skill.source),
        enabled, ready: enabled && skill.eligible === true && skill.blockedByAgentFilter !== true,
        manageable: global ? !unshared && skill.blockedByAllowlist !== true : !blocked,
        ...(unshared ? { reason: "此技能尚未加入公共目录，请刷新" } :
          !enabled ? { reason: blocked ? "已被公共策略停用" : "未为这位伙伴启用" } :
          skill.blockedByAgentFilter === true ? { reason: "原有伙伴策略限制了技能使用" } :
          skill.eligible !== true ? { reason: strings(missing.env).length ? "需要连接账号或配置凭据" : "需要完成本机配置" } : {}),
        nativeName: name, nativeKind: "skill", skillKey: text(skill.skillKey) || name,
        nativeSource: text(skill.source), nativeDescription: text(skill.description), bundled: skill.bundled === true,
        ...(global ? { global: true } : {}),
      });
    }
    const allTools = new Map<string, RecordValue>();
    for (const group of rows(catalog.groups)) for (const entry of rows(group.tools)) allTools.set(text(entry.id), entry);
    for (const entry of activeTools) allTools.set(text(entry.id), entry);
    for (const [name, entry] of allTools) {
      if (!name) continue;
      const active = activeTools.find((tool) => tool.id === name);
      const source = text(entry.source) || "core";
      const owner = text(entry.mcpServer) || text(entry.pluginId) || source;
      if (source === "mcp" && removedServiceDefinition(servers[owner])) continue;
      const serviceUnavailable = source === "mcp" && (serviceOverrides[owner] === false ? "未为这位伙伴启用" : serverReason(owner) ??
        (Object.hasOwn(servers, owner) && object(servers[owner]).enabled === false ? "已在公共连接设置中停用" : undefined));
      const enabled = global ? !denied.has(name) &&
        !(source === "mcp" && object(servers[owner]).enabled === false) :
        Boolean(active && active.deniedBySession !== true && !denied.has(name) &&
          !(source === "mcp" && serviceOverrides[owner] === false));
      result.push({
        id: `tool:${source}:${owner}:${name}${!global && source === "mcp" ? `:${agentId}` : ""}`,
        name: toolLabels[name] ?? (text(entry.label) || name), description: text(entry.description), kind: source === "mcp" ? "service" : "tool",
        source: owner, enabled,
        ready: enabled && Boolean(active && active.deniedBySession !== true) && !serviceUnavailable, manageable: true,
        ...(!enabled ? { reason: global ? "已被公共策略停用" : "当前会话策略未开放" } :
          serviceUnavailable ? { reason: serviceUnavailable } : global && !active ? { reason: "等待原生工具可用" } : {}),
        nativeName: name, nativeKind: "tool", nativeSource: source, nativeDescription: text(entry.description),
        ...(global ? { global: true } : {}),
      });
    }
    // The prospective native inventory can omit denied tools or a cold MCP
    // catalog. Preserve observed MCP identities while their definition exists,
    // but require a fresh effective entry before reporting readiness.
    for (const previous of known) {
      const configuredService = previous.kind === "service" && Object.hasOwn(servers, previous.source) &&
        !removedServiceDefinition(servers[previous.source]);
      if (previous.nativeKind !== "tool" || result.some((item) => item.id === previous.id) ||
          previous.kind === "service" && !configuredService ||
          !configuredService && !denied.has(previous.nativeName)) continue;
      const enabled = !denied.has(previous.nativeName) && serviceOverrides[previous.source] !== false &&
        !(global && configuredService && object(servers[previous.source]).enabled === false);
      result.push({
        ...previous, enabled, ready: false,
        reason: !enabled ? "未为这位伙伴启用" :
          object(servers[previous.source]).enabled === false ? "已在公共连接设置中停用" :
          serverReason(previous.source) ?? "等待下次任务确认工具",
      });
    }
    return result;
  }

  async prepareServices(agentId: string, sessionKey: string, services: Record<string, boolean>): Promise<void> {
    if (!Object.keys(services).length) return;
    // Native raw-server overrides avoid guessing provider-safe tool prefixes.
    // sessions.patch can materialize a classified key without marking a group
    // as a direct/private conversation.
    const described = await this.gateway.request<RecordValue>("sessions.describe", { key: sessionKey, agentId });
    const session = object(described.session);
    if (session.agentId && session.agentId !== agentId) throw new Error("Service policy session owner differs");
    const previous = object(session.toolOverrides);
    const servers = { ...object(previous.mcpServers) };
    // Allow means inherit the shared definition. Native true overrides can
    // otherwise reactivate a server disabled in shared connection settings.
    const matches = (current: RecordValue) => Object.entries(services).every(([name, enabled]) =>
      enabled ? !Object.hasOwn(current, name) : current[name] === false);
    if (matches(servers)) return;
    for (const [name, enabled] of Object.entries(services)) {
      if (enabled) delete servers[name];
      else servers[name] = false;
    }
    await this.gateway.request("sessions.patch", {
      key: sessionKey, toolOverrides: { ...previous, mcpServers: servers },
      expectedToolOverrides: session.toolOverrides ?? null,
      ...(typeof session.sessionId === "string" ? { expectedSessionId: session.sessionId } : {}),
    });
    const confirmed = await this.gateway.request<RecordValue>("sessions.describe", { key: sessionKey, agentId });
    const applied = object(object(object(confirmed.session).toolOverrides).mcpServers);
    if (!matches(applied)) {
      throw new Error("服务权限尚未确认，请重试");
    }
  }

  async setEnabled(agentId: string, capability: KernelCapability, enabled: boolean): Promise<void> {
    if (!capability.manageable || capability.nativeKind === "service") throw new Error("This ability is controlled by shared settings");
    const snapshot = await this.gateway.request<RecordValue>("config.get", {});
    const config = object(snapshot.config);
    const agents = object(config.agents);
    const entry = object(object(agents.entries)[agentId]);
    if (!Object.hasOwn(object(agents.entries), agentId)) throw new Error("Unknown kernel agent");
    if (!text(snapshot.hash)) throw new Error("Configuration revision is unavailable");
    let patch: RecordValue;
    let replacePath: string;
    if (capability.nativeKind === "skill") {
      const inherited = entry.skills ?? object(agents.defaults).skills;
      const inventory = inherited === undefined
        ? rows((await this.gateway.request<RecordValue>("skills.status", { agentId })).skills).map((skill) => text(skill.name)).filter(Boolean)
        : strings(inherited);
      const names = new Set(inventory);
      if (enabled) names.add(capability.nativeName);
      else names.delete(capability.nativeName);
      patch = { skills: [...names] };
      replacePath = `agents.entries.${agentId}.skills`;
    } else {
      const deny = new Set(strings(object(entry.tools).deny));
      if (enabled) deny.delete(capability.nativeName);
      else deny.add(capability.nativeName);
      patch = { tools: { deny: [...deny] } };
      replacePath = `agents.entries.${agentId}.tools.deny`;
    }
    await this.gateway.request("config.patch", {
      baseHash: snapshot.hash,
      raw: JSON.stringify({ agents: { entries: { [agentId]: patch } } }),
      replacePaths: [replacePath],
      response: "summary",
    });
  }
}
