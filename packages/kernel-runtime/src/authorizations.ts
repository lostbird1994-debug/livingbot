import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { runtimeEnvironment } from "./paths.ts";
import type { RuntimePaths } from "./paths.ts";
import { serviceName } from "./connections.ts";

/**
 * Account consent for one external service. Values never carry credentials,
 * tokens or provider URLs: only the state OpenClaw itself reports.
 */
export type McpAuthorization = {
  name: string;
  authorization: "oauth" | "none";
  state: "authorized" | "sign-in-required" | "sign-in-pending" | "signed-out" | "not-required";
  hasTokens: boolean;
  expiresAt?: number;
  reason?: string;
};

export type AuthorizationAttempt = {
  id: string;
  name: string;
  state: "waiting" | "authorized" | "failed" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  authorizationUrl?: string;
  reason?: string;
};

export interface AuthorizationProvider {
  read(names?: string[]): Promise<McpAuthorization[]>;
  start(name: string): Promise<AuthorizationAttempt>;
  attempt(id: string): AuthorizationAttempt | undefined;
  wait(id: string, timeoutMs: number): Promise<AuthorizationAttempt | undefined>;
  complete(name: string, code: string, issuer?: string): Promise<McpAuthorization>;
  revoke(name: string): Promise<McpAuthorization>;
  cancel(id: string): Promise<void>;
  dispose?(): Promise<void>;
}

/** One started native command, still running, with its streamed output. */
export type AuthorizationProcess = {
  lines: AsyncIterable<string>;
  exit: Promise<{ code: number | null }>;
  cancel(): void;
};

export type AuthorizationCommands = {
  run(args: string[], timeoutMs: number): Promise<string>;
  start(args: string[]): AuthorizationProcess;
};

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function rows(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(object) : [];
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Maps native `mcp status --json` entries to product states. Unknown fields are
 * ignored on purpose: `launch`, `url` and headers can hold private addresses.
 */
export function authorizationReport(value: unknown, names?: string[]): McpAuthorization[] {
  const servers = rows(object(value).servers);
  const wanted = names ? new Set(names) : undefined;
  return servers.flatMap((entry): McpAuthorization[] => {
    const name = text(entry.name);
    if (!name || wanted && !wanted.has(name)) return [];
    if (entry.auth !== "oauth") {
      return [{ name, authorization: "none", state: "not-required", hasTokens: false }];
    }
    // Per-requester sign-in has no operator credential to manage here.
    if (entry.connectedPrincipals !== undefined) {
      return [{
        name, authorization: "oauth", state: "not-required", hasTokens: false,
        reason: "这个服务在每次连接时单独登录",
      }];
    }
    const status = object(entry.authStatus);
    const expiresAt = typeof status.expiresAt === "number" && Number.isFinite(status.expiresAt) ? status.expiresAt : undefined;
    const hasTokens = status.hasTokens === true;
    const base: McpAuthorization = { name, authorization: "oauth", state: "signed-out", hasTokens };
    if (status.state === "authorized") return [{ ...base, state: "authorized", ...(expiresAt ? { expiresAt } : {}) }];
    if (status.state === "requires-authorization") return [{ ...base, state: "sign-in-required" }];
    if (status.state === "pending-authorization") return [{ ...base, state: "sign-in-pending" }];
    if (status.state === "unauthenticated") return [base];
    return [{ ...base, reason: "还没有登录这个服务" }];
  });
}

/** The authorization URL is the only native output a person needs to see. */
export function authorizationUrl(line: string): string | undefined {
  const match = /^\s*(https?:\/\/[^\s<>"]+)\s*$/u.exec(line);
  if (!match) return undefined;
  const parsed = URL.parse(match[1]!);
  if (!parsed || !["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
  if (parsed.href.length > 4096) return undefined;
  return parsed.href;
}

const refusals: [RegExp, string][] = [
  [/not configured with auth: "oauth"/u, "这个连接还没有选择账号登录"],
  [/needs a URL for OAuth login|needs a valid HTTP transport/u, "只有远程服务可以账号登录"],
  [/per-requester OAuth/u, "这个服务在每次连接时单独登录"],
  [/requires exclusive offline state ownership|Cannot admit mcp/u, "助手正在运行，请稍后再试"],
  [/did not finish|expired/iu, "登录没有完成，请重试或改用授权码"],
  [/no matching authorization|invalid_grant|code_verifier/iu, "授权码无效或已过期，请重新登录"],
];

/** Only recognized native failures are surfaced; raw stderr can hold private paths. */
function safeReason(output: string): string {
  for (const [pattern, message] of refusals) if (pattern.test(output)) return message;
  return "登录没有完成，请重试或改用授权码";
}

function authorizationCode(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[^\u0021-\u007e]/u.test(value)) {
    throw new Error("请输入浏览器给出的授权码");
  }
  return value.trim();
}

function issuerValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" ? URL.parse(value) : undefined;
  if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.href.length > 2048) {
    throw new Error("授权来源地址不正确");
  }
  return parsed.href;
}

/** Native account sign-in only. No hosted vendor, no token handling here. */
export class OpenClawMcpAuthorizations implements AuthorizationProvider {
  private readonly attempts = new Map<string, AuthorizationAttempt>();
  /** Attempt identity to the operation that ends it; also bounds concurrent starts. */
  private readonly running = new Map<string, Promise<void>>();
  private readonly processes = new Map<string, AuthorizationProcess>();
  private readonly options: {
    commands: AuthorizationCommands;
    pauseKernel<T>(operation: () => Promise<T>): Promise<T>;
    now?: () => number;
  };

  constructor(options: {
    commands: AuthorizationCommands;
    pauseKernel<T>(operation: () => Promise<T>): Promise<T>;
    now?: () => number;
  }) {
    this.options = options;
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  async read(names?: string[]): Promise<McpAuthorization[]> {
    const stdout = await this.options.commands.run(["mcp", "status", "--json"], 60_000);
    let parsed: unknown;
    try { parsed = JSON.parse(stdout); } catch { throw new Error("暂时无法读取账号状态"); }
    return authorizationReport(parsed, names);
  }

  attempt(id: string): AuthorizationAttempt | undefined {
    const attempt = this.attempts.get(id);
    return attempt ? { ...attempt } : undefined;
  }

  async start(name: string): Promise<AuthorizationAttempt> {
    const server = serviceName(name);
    if (this.waiting(server)) throw new Error("这个连接正在登录");
    const current = (await this.read([server]))[0];
    if (!current) throw new Error("找不到这个连接，请刷新连接列表");
    if (current.authorization !== "oauth") throw new Error("先在连接设置里选择账号登录");
    if (current.state === "not-required" && current.reason) throw new Error(current.reason);

    const attempt: AuthorizationAttempt = { id: randomUUID(), name: server, state: "waiting", startedAt: this.now() };
    this.attempts.set(attempt.id, attempt);
    this.trim();

    let publish!: (url: string) => void;
    const published = new Promise<string>((resolve) => { publish = resolve; });

    const login = this.pauseKernel(async () => {
      const process = this.options.commands.start(["mcp", "login", server]);
      this.processes.set(attempt.id, process);
      void this.publishUrl(process, (url) => { attempt.authorizationUrl = url; publish(url); });
      try { return await process.exit; } finally { this.processes.delete(attempt.id); }
    });

    const settled = login.then(
      (outcome) => {
        // An explicit cancel owns the final state; a killed child also exits nonzero.
        if (attempt.state !== "waiting") return;
        if (outcome.code === 0) attempt.state = "authorized";
        else { attempt.state = "failed"; attempt.reason = "登录没有完成，请重试或改用授权码"; }
      },
      (error: unknown) => {
        if (attempt.state !== "waiting") return;
        attempt.state = "failed";
        attempt.reason = error instanceof Error ? error.message : "登录没有完成";
      },
    ).finally(() => {
      attempt.finishedAt = this.now();
      this.running.delete(attempt.id);
    });
    this.running.set(attempt.id, settled);

    // Return the sign-in address as soon as the native flow publishes it.
    await Promise.race([
      published,
      settled.then(() => { throw new Error(attempt.reason ?? "登录没有开始，请重试"); }),
    ]);
    return { ...attempt };
  }

  async wait(id: string, timeoutMs: number): Promise<AuthorizationAttempt | undefined> {
    const attempt = this.attempts.get(id);
    if (!attempt) return undefined;
    const settled = this.running.get(id);
    if (settled) await Promise.race([settled, delay(Math.min(Math.max(timeoutMs, 0), 300_000))]);
    return { ...attempt };
  }

  async cancel(id: string): Promise<void> {
    const attempt = this.attempts.get(id);
    if (!attempt) return;
    const process = this.processes.get(id);
    if (process) process.cancel();
    if (attempt.state === "waiting") {
      attempt.state = "cancelled";
      attempt.reason = "已取消这次登录";
      attempt.finishedAt = this.now();
    }
    const settled = this.running.get(id);
    if (settled) await Promise.race([settled, delay(10_000)]);
  }

  async complete(name: string, code: string, issuer?: string): Promise<McpAuthorization> {
    const server = serviceName(name);
    const value = authorizationCode(code);
    const origin = issuerValue(issuer);
    // The browser hop may still be waiting on the same server. The documented
    // fallback is to cancel that attempt and finish with the code it produced,
    // which also releases the kernel the attempt was holding.
    const waiting = [...this.attempts.values()].find((attempt) => attempt.name === server && attempt.state === "waiting");
    if (waiting) await this.cancel(waiting.id);
    try {
      await this.pauseKernel(() => this.options.commands.run([
        "mcp", "login", server, "--code", value, ...(origin ? ["--issuer", origin] : []),
      ], 180_000));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/等当前工作结束/u.test(message)) throw error;
      // A rejected code is the common case here; native detail is never surfaced.
      throw new Error("授权码没有通过，请重新开始登录");
    }
    const confirmed = (await this.read([server]))[0];
    if (!confirmed) throw new Error("找不到这个连接，请刷新连接列表");
    if (confirmed.state !== "authorized") throw new Error("还没有确认登录，请重试");
    return confirmed;
  }

  async revoke(name: string): Promise<McpAuthorization> {
    const server = serviceName(name);
    await this.pauseKernel(() => this.options.commands.run(["mcp", "logout", server], 120_000));
    const confirmed = (await this.read([server]))[0];
    if (!confirmed) throw new Error("找不到这个连接，请刷新连接列表");
    if (confirmed.state === "authorized") throw new Error("还没有确认撤销，请重试");
    return confirmed;
  }

  /** Stops every pending sign-in so a closing application leaves no orphan process. */
  async dispose(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.cancel(id)));
  }

  private waiting(server: string): boolean {
    return [...this.attempts.values()].some((attempt) => attempt.name === server && attempt.state === "waiting");
  }

  private trim(): void {
    if (this.attempts.size <= 20) return;
    const finished = [...this.attempts.values()]
      .filter((attempt) => attempt.state !== "waiting")
      .sort((left, right) => left.startedAt - right.startedAt);
    for (const attempt of finished.slice(0, this.attempts.size - 20)) this.attempts.delete(attempt.id);
  }

  private async publishUrl(process: AuthorizationProcess, publish: (url: string) => void): Promise<void> {
    for await (const line of process.lines) {
      const url = authorizationUrl(line);
      if (url) { publish(url); return; }
    }
  }

  private async pauseKernel<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await this.options.pauseKernel(operation);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // Only the kernel's own admission errors are translated; native failures pass through.
      if (/Kernel is not available for memory maintenance|Wait for native work to finish/u.test(message)) {
        throw new Error("请等当前工作结束后再登录账号");
      }
      throw error;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
}

/** Official CLI boundary: the pinned OpenClaw binary, in this application's state. */
export class OpenClawAuthorizationCommands implements AuthorizationCommands {
  private readonly options: { nodeExecutable: string; entry: string; paths: RuntimePaths };
  constructor(options: { nodeExecutable: string; entry: string; paths: RuntimePaths }) {
    this.options = options;
  }

  async run(args: string[], timeoutMs: number): Promise<string> {
    try {
      const { stdout } = await promisify(execFile)(this.options.nodeExecutable, [this.options.entry, ...args], {
        cwd: this.options.paths.root, env: runtimeEnvironment(this.options.paths),
        timeout: timeoutMs, maxBuffer: 2_000_000, encoding: "utf8",
      });
      return stdout;
    } catch (error) {
      // Native stderr can name private paths and provider addresses.
      const stderr = text(object(error as RecordValue).stderr);
      throw new Error(safeReason(stderr));
    }
  }

  start(args: string[]): AuthorizationProcess {
    const child = spawn(this.options.nodeExecutable, [this.options.entry, ...args], {
      cwd: this.options.paths.root, env: runtimeEnvironment(this.options.paths),
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    return {
      lines: lines(child.stdout),
      exit: new Promise<{ code: number | null }>((resolve) => {
        child.once("error", () => resolve({ code: null }));
        child.once("close", (code) => resolve({ code }));
      }),
      cancel: () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 5_000);
        force.unref?.();
      },
    };
  }
}

async function* lines(stream: NodeJS.ReadableStream | null): AsyncGenerator<string> {
  if (!stream) return;
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      queue.push(buffer.slice(0, index).replace(/\r$/u, ""));
      buffer = buffer.slice(index + 1);
    }
    wake?.();
  });
  stream.on("end", () => { if (buffer) queue.push(buffer.replace(/\r$/u, "")); ended = true; wake?.(); });
  stream.on("error", () => { ended = true; wake?.(); });
  for (;;) {
    if (queue.length) { yield queue.shift()!; continue; }
    if (ended) return;
    await new Promise<void>((resolve) => { wake = resolve; });
    wake = undefined;
  }
}
