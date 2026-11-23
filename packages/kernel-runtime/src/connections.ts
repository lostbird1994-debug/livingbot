import type { GatewayRequests } from "./contracts.ts";

/** `oauth` defers to native account sign-in; `none` uses the configured headers. */
export type ServiceConnectionAuth = "none" | "oauth";

export type ServiceConnection = {
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  enabled: boolean;
  auth: ServiceConnectionAuth;
};

export type ServiceConnectionInput = {
  name: string;
  transport: ServiceConnection["transport"];
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  auth?: ServiceConnectionAuth;
  oauth?: { scope?: string };
};

export type ServiceConnectionUpdate = {
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string | null;
  headers?: Record<string, string | null> | null;
  env?: Record<string, string | null> | null;
  auth?: ServiceConnectionAuth;
  oauth?: { scope?: string } | null;
};

export interface ServiceConnections {
  list(): Promise<ServiceConnection[]>;
  add(input: ServiceConnectionInput): Promise<void>;
  setEnabled(name: string, enabled: boolean): Promise<void>;
  update(name: string, input: ServiceConnectionUpdate): Promise<void>;
  remove(name: string): Promise<void>;
}

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 100 ||
      value === "__proto__" || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("请输入有效的连接名称");
  return value;
}

/** Shared with account sign-in, which addresses the same native server names. */
export function serviceName(value: unknown): string {
  return name(value);
}

function authorizationMode(value: unknown): ServiceConnectionAuth | undefined {
  if (value === undefined) return undefined;
  if (value !== "none" && value !== "oauth") throw new Error("请选择账号登录方式");
  return value;
}

/** Only an explicit scope is accepted; the provider's default scope is used otherwise. */
function oauthSettings(value: unknown): { scope?: string } | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("账号登录参数格式不正确");
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some((key) => key !== "scope")) throw new Error("账号登录参数格式不正确");
  if (entry.scope === undefined) return {};
  const scope = bounded(entry.scope, "登录授权范围");
  if (scope.length > 512 || /[\r\n]/u.test(scope)) throw new Error("账号登录参数格式不正确");
  return { scope };
}
function bounded(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8192 || value.includes("\0")) {
    throw new Error(`请输入有效的${label}`);
  }
  return value;
}
function values(input: unknown, header: boolean, allowRemoval = false): Record<string, string | null> | null | undefined {
  if (input === undefined) return undefined;
  if (input === null && allowRemoval) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("连接参数格式不正确");
  const entries = Object.entries(input);
  if (entries.length > 64) throw new Error("连接参数过多");
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(key)) throw new Error("连接参数格式不正确");
    if (value === null && allowRemoval) continue;
    if (typeof value !== "string" || value.length > 8192 ||
        value.includes("\0") || header && /[\r\n]/u.test(value)) throw new Error("连接参数格式不正确");
  }
  return Object.fromEntries(entries);
}

function address(value: unknown): string {
  const parsed = URL.parse(bounded(value, "服务地址"));
  if (!parsed || !["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error("请输入不含账号密码和片段的 HTTP 或 HTTPS 服务地址");
  }
  return parsed.href;
}

function argumentsValue(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128 ||
      value.some((arg) => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"))) {
    throw new Error("程序参数格式不正确");
  }
  return value;
}

/** A disabled empty override prevents a removed definition falling back to plugin defaults. */
export function removedServiceDefinition(value: unknown): boolean {
  const entry = object(value);
  return entry.enabled === false && Object.keys(entry).every((key) => key === "enabled");
}

function arrayPaths(value: unknown, path: string, depth = 0): string[] {
  if (depth > 32) throw new Error("连接配置层级过深");
  if (Array.isArray(value)) return [path];
  return Object.entries(object(value)).flatMap(([key, child]) => arrayPaths(child, `${path}.${key}`, depth + 1));
}

/** Global definitions only. Saving does not probe, launch commands, or claim authorization. */
export class OpenClawConnections implements ServiceConnections {
  private readonly gateway: GatewayRequests;
  constructor(gateway: GatewayRequests) { this.gateway = gateway; }

  private async snapshot() {
    const snapshot = await this.gateway.request<RecordValue>("config.get", {});
    const servers = object(object(object(snapshot.config).mcp).servers);
    return { hash: typeof snapshot.hash === "string" ? snapshot.hash : "", servers };
  }

  async list(): Promise<ServiceConnection[]> {
    const { servers } = await this.snapshot();
    return Object.entries(servers).filter(([, value]) => !removedServiceDefinition(value)).map(([key, value]) => {
      const entry = object(value);
      return {
        name: key, enabled: entry.enabled !== false,
        auth: entry.auth === "oauth" ? "oauth" : "none",
        transport: entry.transport === "sse" ? "sse" : entry.transport === "stdio" || !entry.url ? "stdio" : "streamable-http",
      };
    });
  }

  async add(input: ServiceConnectionInput): Promise<void> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((field) =>
      !["name", "transport", "url", "command", "args", "cwd", "headers", "env", "auth", "oauth"].includes(field))) {
      throw new Error("连接参数格式不正确");
    }
    const key = name(input.name);
    const auth = authorizationMode(input.auth) ?? "none";
    const oauth = oauthSettings(input.oauth);
    if (auth !== "oauth" && oauth !== undefined) throw new Error("请先选择账号登录");
    let entry: RecordValue;
    if (input.transport === "stdio") {
      if (input.url !== undefined || input.headers !== undefined) throw new Error("本机程序不使用服务地址或请求头");
      if (auth === "oauth" || oauth !== undefined) throw new Error("本机程序不使用账号登录");
      entry = {
        transport: "stdio", command: bounded(input.command, "程序命令"),
        ...(input.args !== undefined ? { args: argumentsValue(input.args) } : {}),
        ...(input.cwd !== undefined ? { cwd: bounded(input.cwd, "工作目录") } : {}),
        ...(input.env !== undefined ? { env: values(input.env, false) } : {}),
      };
    } else if (input.transport === "sse" || input.transport === "streamable-http") {
      if ([input.command, input.args, input.cwd, input.env].some((value) => value !== undefined)) {
        throw new Error("远程服务不使用本机程序参数");
      }
      entry = {
        transport: input.transport, url: address(input.url),
        ...(input.headers !== undefined ? { headers: values(input.headers, true) } : {}),
        ...(auth === "oauth" ? { auth: "oauth" } : {}),
        ...(oauth ? { oauth } : {}),
      };
    } else throw new Error("请选择连接方式");
    const { hash, servers } = await this.snapshot();
    if (Object.hasOwn(servers, key) && !removedServiceDefinition(servers[key])) throw new Error("这个连接名称已存在");
    // A saved service makes the Gateway restart, so the reply can be lost after the
    // write landed. The confirmed definition, not the reply, decides the outcome.
    const failure = await this.patch(hash, key, { ...entry, enabled: true }).catch((error: unknown) => error);
    const confirmed = await this.snapshot();
    if (!Object.hasOwn(confirmed.servers, key)) {
      throw failure instanceof Error ? failure : new Error("尚未确认保存，请重新查看连接");
    }
  }

  async setEnabled(connectionName: string, enabled: boolean): Promise<void> {
    const key = name(connectionName);
    if (typeof enabled !== "boolean") throw new Error("连接开关格式不正确");
    const { hash, servers } = await this.snapshot();
    if (!Object.hasOwn(servers, key) || removedServiceDefinition(servers[key])) throw new Error("找不到这个连接");
    const failure = await this.patch(hash, key, { enabled }).catch((error: unknown) => error);
    const confirmed = await this.snapshot();
    if (!Object.hasOwn(confirmed.servers, key) || (object(confirmed.servers[key]).enabled !== false) !== enabled) {
      throw failure instanceof Error ? failure : new Error("尚未确认连接开关，请重新查看连接");
    }
  }

  async update(connectionName: string, input: ServiceConnectionUpdate): Promise<void> {
    const key = name(connectionName);
    const { hash, servers } = await this.snapshot();
    if (!Object.hasOwn(servers, key) || removedServiceDefinition(servers[key])) throw new Error("找不到这个连接");
    const current = object(servers[key]);
    const allowed = ["url", "command", "args", "cwd", "headers", "env", "auth", "oauth"];
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some((field) => !allowed.includes(field))) throw new Error("连接修改格式不正确");
    const remote = current.transport === "sse" || current.transport === "streamable-http" || Boolean(current.url);
    const auth = authorizationMode(input.auth);
    const oauth = oauthSettings(input.oauth);
    if (!remote && (auth === "oauth" || oauth)) throw new Error("本机程序不使用账号登录");
    if (auth === "none" && oauth && typeof oauth === "object" && oauth.scope) throw new Error("请先选择账号登录");
    let patch: RecordValue;
    if (remote) {
      if ([input.command, input.args, input.cwd, input.env].some((value) => value !== undefined)) {
        throw new Error("远程服务不使用本机程序参数");
      }
      patch = {
        ...(input.url !== undefined ? { url: address(input.url) } : {}),
        ...(input.headers !== undefined ? { headers: values(input.headers, true, true) } : {}),
        ...(auth === undefined ? {} : auth === "oauth" ? { auth: "oauth" } : { auth: null, oauth: null }),
        ...(oauth === undefined ? {} : { oauth }),
      };
    } else {
      if (input.url !== undefined || input.headers !== undefined) throw new Error("本机程序不使用服务地址或请求头");
      patch = {
        ...(input.command !== undefined ? { command: bounded(input.command, "程序命令") } : {}),
        ...(input.args !== undefined ? { args: argumentsValue(input.args) } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd === null ? null : bounded(input.cwd, "工作目录") } : {}),
        ...(input.env !== undefined ? { env: values(input.env, false, true) } : {}),
      };
    }
    if (!Object.keys(patch).length) throw new Error("请填写需要修改的设置");
    const replacePaths = input.args !== undefined ? [`mcp.servers.${key}.args`] : [];
    const failure = await this.patch(hash, key, patch, replacePaths).catch((error: unknown) => error);
    const confirmed = await this.snapshot();
    if (!Object.hasOwn(confirmed.servers, key) || removedServiceDefinition(confirmed.servers[key])) {
      throw failure instanceof Error ? failure : new Error("尚未确认保存，请重新查看连接");
    }
  }

  async remove(connectionName: string): Promise<void> {
    const key = name(connectionName);
    const { hash, servers } = await this.snapshot();
    if (!Object.hasOwn(servers, key)) throw new Error("找不到这个连接");
    if (removedServiceDefinition(servers[key])) return;
    const current = object(servers[key]);
    const cleared = Object.fromEntries(Object.keys(current).map((field) => [field, null]));
    // Keep an explicit denial so deleting a user override cannot activate a
    // plugin's declaration of the same server. This removes no workspace files.
    const failure = await this.patch(hash, key, { ...cleared, enabled: false }, arrayPaths(current, `mcp.servers.${key}`))
      .catch((error: unknown) => error);
    const confirmed = await this.snapshot();
    if (!removedServiceDefinition(confirmed.servers[key])) {
      throw failure instanceof Error ? failure : new Error("尚未确认移除，请重新查看连接");
    }
  }

  private async patch(hash: string, key: string, entry: RecordValue, replacePaths: string[] = []): Promise<void> {
    if (!hash) throw new Error("无法获取配置版本，请重新查看连接");
    try {
      await this.gateway.request("config.patch", {
        baseHash: hash, raw: JSON.stringify({ mcp: { servers: { [key]: entry } } }), response: "summary",
        ...(replacePaths.length ? { replacePaths } : {}),
      });
    } catch {
      // A provider's validation error may repeat the submitted credential.
      throw new Error("连接配置未确认保存，请刷新后重试");
    }
  }
}
