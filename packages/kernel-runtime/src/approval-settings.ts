import { createHash } from "node:crypto";
import type { GatewayRequests } from "./contracts.ts";

type RecordValue = Record<string, unknown>;
type ApprovalMode = "never" | "ask" | "auto";
type NativeMode = "ask" | "auto" | "deny" | "allowlist" | "full";
type Rule = {
  id: string;
  effect: "always_allow";
  matchKind: "category";
  matchValue: string;
  createdAt: string;
};
type Snapshot = {
  hash?: string;
  config?: RecordValue;
  file?: RecordValue;
  resolvedDefaults?: RecordValue;
};
const object = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const rows = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(object) : []);
const idFor = (agent: string, kind: string, identity: unknown) =>
  createHash("sha256")
    .update(JSON.stringify([agent, kind, identity]))
    .digest("hex");

/**
 * Adapts the existing settings UI to OpenClaw's operator configuration APIs.
 * Policy evaluation, durable grants and human decisions remain entirely native.
 * Donor: OpenClaw exec-approvals handlers, exec-policy CLI and permission-modes.
 */
export class OpenClawApprovalSettings {
  private readonly gateway: GatewayRequests;
  constructor(gateway: GatewayRequests) {
    this.gateway = gateway;
  }

  private async snapshots() {
    const [config, approvals] = await Promise.all([
      this.gateway.request<Snapshot>("config.get", {}),
      this.gateway.request<Snapshot>("exec.approvals.get", {}),
    ]);
    return { config, approvals };
  }

  private view(config: Snapshot, approvals: Snapshot) {
    const root = object(config.config);
    const exec = object(object(root.tools).exec);
    // Native exec mode wins over legacy fields in the same config layer.
    // Host approvals may only tighten that requested policy, never loosen it.
    const requestedSecurity =
      exec.mode === "deny"
        ? "deny"
        : ["ask", "auto", "allowlist"].includes(String(exec.mode))
          ? "allowlist"
          : exec.mode === "full"
            ? "full"
            : (exec.security ?? "full");
    const requestedAsk =
      exec.mode === "ask" || exec.mode === "auto"
        ? "on-miss"
        : exec.mode
          ? "off"
          : (exec.ask ?? "off");
    const nativeMode = (security: unknown, ask: unknown): NativeMode =>
      security === "deny"
        ? "deny"
        : security === "allowlist" && ask === "off"
          ? "allowlist"
          : security === "full" && ask !== "always"
            ? "full"
            : "ask";
    const requestedMode = exec.mode ?? nativeMode(requestedSecurity, requestedAsk);
    const host = object(object(approvals.file).defaults);
    const security = [requestedSecurity, host.security].includes("deny")
      ? "deny"
      : [requestedSecurity, host.security].includes("allowlist")
        ? "allowlist"
        : "full";
    const ask = [requestedAsk, host.ask].includes("always")
      ? "always"
      : [requestedAsk, host.ask].includes("on-miss")
        ? "on-miss"
        : "off";
    const effectiveMode =
      security === requestedSecurity && ask === requestedAsk
        ? requestedMode
        : nativeMode(security, ask);
    const mode: ApprovalMode =
      effectiveMode === "auto" ? "auto" : effectiveMode === "full" ? "never" : "ask";
    const agents = object(root.agents);
    const hasPolicy = (value: unknown) =>
      ["mode", "security", "ask"].some((key) => Object.hasOwn(object(value), key));
    const modelName = (value: unknown) => {
      const name = typeof value === "string" ? value : object(value).primary;
      return typeof name === "string" && name.trim() ? name.trim() : undefined;
    };
    const primary =
      modelName(object(exec.reviewer).model) ?? modelName(object(agents.defaults).model);
    return {
      mode,
      enabled: mode === "auto",
      skipApprovals: mode === "never",
      checkerAvailable: typeof primary === "string" && Boolean(primary.trim()),
      native: {
        requestedMode,
        mode: effectiveMode,
        security,
        ask,
        // Do not claim the account default describes existing per-agent scopes.
        hasOverrides:
          hasPolicy(object(object(agents.defaults).tools).exec) ||
          Object.values(object(agents.entries)).some((entry) =>
            hasPolicy(object(object(entry).tools).exec),
          ) ||
          Object.values(object(object(approvals.file).agents)).some((entry) =>
            ["security", "ask"].some(
              (key) =>
                object(entry)[key] !== undefined &&
                object(entry)[key] !==
                  (host[key] ?? (key === "security" ? requestedSecurity : requestedAsk)),
            ),
          ),
      },
    };
  }

  async read() {
    const { config, approvals } = await this.snapshots();
    return this.view(config, approvals);
  }

  async setMode(mode: ApprovalMode) {
    const { config, approvals } = await this.snapshots();
    if (!config.hash || !approvals.hash || !approvals.file) {
      throw new Error("原生审批配置版本不可用，请刷新后重试");
    }
    const security = mode === "never" ? "full" : "allowlist";
    const ask = mode === "never" ? "off" : "on-miss";
    const file = structuredClone(approvals.file);
    file.defaults = { ...object(file.defaults), security, ask };
    // Existing grants and unrelated host settings are preserved. The account
    // control intentionally applies one policy to every existing native agent.
    file.agents = Object.fromEntries(
      Object.entries(object(file.agents)).map(([id, value]) => [
        id,
        { ...object(value), security, ask },
      ]),
    );
    const exec = { mode: mode === "never" ? "full" : mode, security: null, ask: null };
    const root = object(config.config);
    const agents = object(root.agents);
    const replacePaths = ["tools.exec.security", "tools.exec.ask"];
    const inherit = (value: unknown, path: string) => {
      const existing = object(object(value).exec);
      const patch: RecordValue = {};
      for (const key of ["mode", "security", "ask"])
        if (Object.hasOwn(existing, key)) {
          patch[key] = null;
          replacePaths.push(`${path}.exec.${key}`);
        }
      return Object.keys(patch).length ? { tools: { exec: patch } } : {};
    };
    const defaults = inherit(object(agents.defaults).tools, "agents.defaults.tools");
    const entries = Object.fromEntries(
      Object.entries(object(agents.entries)).flatMap(([id, entry]) => {
        const patch = inherit(object(entry).tools, `agents.entries.${id}.tools`);
        return Object.keys(patch).length ? [[id, patch]] : [];
      }),
    );
    const written = await this.gateway.request<Snapshot>("exec.approvals.set", {
      baseHash: approvals.hash,
      file,
    });
    // Like the native CLI, write the requested policy and host policy together;
    // report a failed native write rather than storing a cosmetic UI preference.
    try {
      await this.gateway.request("config.patch", {
        baseHash: config.hash,
        response: "summary",
        replacePaths,
        raw: JSON.stringify({
          tools: { exec },
          ...(Object.keys(defaults).length || Object.keys(entries).length
            ? {
                agents: {
                  ...(Object.keys(defaults).length ? { defaults } : {}),
                  ...(Object.keys(entries).length ? { entries } : {}),
                },
              }
            : {}),
        }),
      });
    } catch (error) {
      // Preserve the native CLI's rollback behavior; a concurrent native edit
      // must never be overwritten by an old snapshot.
      if (written.hash) {
        try {
          await this.gateway.request("exec.approvals.set", {
            baseHash: written.hash,
            file: approvals.file,
          });
        } catch {
          throw new Error("审批配置保存失败，原生策略可能已有并发修改，请重新读取确认");
        }
      }
      throw error;
    }
    const snapshots = await this.snapshots();
    const confirmed = this.view(snapshots.config, snapshots.approvals);
    const savedMode = object(object(object(snapshots.config.config).tools).exec).mode;
    if (confirmed.mode !== mode || savedMode !== exec.mode) {
      throw new Error("原生审批模式尚未确认，请刷新后重试");
    }
    return confirmed;
  }

  private grants(file: RecordValue): { rule: Rule; agent: string; kind: string; index: number }[] {
    return Object.entries(object(file.agents)).flatMap(([agent, value]) => {
      const policy = object(value);
      return [
        ...rows(policy.allowlist).map((entry, index) => ({
          agent,
          kind: "allowlist",
          index,
          rule: {
            id: idFor(agent, "allowlist", entry.id ?? entry.pattern),
            effect: "always_allow" as const,
            matchKind: "category" as const,
            matchValue: `${agent} · ${String(entry.pattern ?? "")}`,
            createdAt: new Date(
              typeof entry.lastUsedAt === "number" ? entry.lastUsedAt : 0,
            ).toISOString(),
          },
        })),
        ...rows(policy.mcpTools).map((entry, index) => ({
          agent,
          kind: "mcpTools",
          index,
          rule: {
            id: idFor(agent, "mcpTools", [entry.server, entry.tool]),
            effect: "always_allow" as const,
            matchKind: "category" as const,
            matchValue: `${agent} · ${String(entry.server)} / ${String(entry.tool)}`,
            createdAt: new Date(
              typeof entry.addedAt === "number" ? entry.addedAt : 0,
            ).toISOString(),
          },
        })),
      ];
    });
  }

  async listRules() {
    const snapshot = await this.gateway.request<Snapshot>("exec.approvals.get", {});
    return this.grants(object(snapshot.file)).map((entry) => entry.rule);
  }

  async removeRule(id: string) {
    const snapshot = await this.gateway.request<Snapshot>("exec.approvals.get", {});
    const found = this.grants(object(snapshot.file)).find((entry) => entry.rule.id === id);
    if (!found) throw new Error("原生授权不存在，请刷新后重试");
    if (!snapshot.hash || !snapshot.file) throw new Error("原生审批配置版本不可用");
    const file = structuredClone(snapshot.file);
    const policy = object(object(file.agents)[found.agent]);
    policy[found.kind] = rows(policy[found.kind]).filter((_, index) => index !== found.index);
    await this.gateway.request("exec.approvals.set", { baseHash: snapshot.hash, file });
    if ((await this.listRules()).some((entry) => entry.id === id))
      throw new Error("原生授权撤销尚未确认");
    return { ok: true as const };
  }
}
