import type { GatewayRequests } from "./contracts.ts";

export type MemoryPreferences = {
  enabled: boolean;
  frequency: string;
  recallMode: "off" | "escalate" | "always";
  flushBeforeCompaction: boolean;
  timezone: string;
  applyState?: "applied" | "pending" | "unknown";
  schedule?: { enabled: boolean; nextRunAt?: number; lastRunAt?: number; status?: string };
};
export type MemoryPreferencesInput = {
  enabled: boolean;
  cadence: "daily" | "weekly";
  hour: number;
  minute: number;
  weekday: number;
  recallMode: MemoryPreferences["recallMode"];
  flushBeforeCompaction: boolean;
};
export function memoryFrequency(input: MemoryPreferencesInput): string {
  if (
    typeof input.enabled !== "boolean" ||
    typeof input.flushBeforeCompaction !== "boolean" ||
    !["off", "escalate", "always"].includes(input.recallMode) ||
    !["daily", "weekly"].includes(input.cadence) ||
    !Number.isInteger(input.hour) ||
    input.hour < 0 ||
    input.hour > 23 ||
    !Number.isInteger(input.minute) ||
    input.minute < 0 ||
    input.minute > 59 ||
    !Number.isInteger(input.weekday) ||
    input.weekday < 0 ||
    input.weekday > 6
  )
    throw new Error("请检查记忆整理设置");
  return `${input.minute} ${input.hour} * * ${input.cadence === "daily" ? "*" : input.weekday}`;
}
/** The native memory-core plugin owns execution, reconciliation and memory files. */
export class OpenClawMemorySettings {
  private readonly gateway: GatewayRequests;
  constructor(gateway: GatewayRequests) {
    this.gateway = gateway;
  }
  async read(): Promise<MemoryPreferences> {
    const result = await this.gateway.request<{
      config: any;
      configRevisionHash?: string;
      appliedConfigHash?: string;
    }>("config.get", {}, { timeoutMs: 5000 });
    const { config } = result;
    const entries = config.plugins?.entries ?? {};
    const dreaming = entries["memory-core"]?.config?.dreaming ?? {};
    const mode = entries["active-memory"]?.config?.mode ?? "escalate";
    const page = await this.gateway.request<{ jobs: any[] }>(
      "cron.list",
      {
        includeDisabled: true,
        limit: 100,
        sessionAgentId: config.agents?.defaults?.systemAgent?.agentId,
      },
      { timeoutMs: 5000 },
    );
    const job = page.jobs?.find(
      (row) => row.declarationKey === "memory-core:memory-dreaming-promotion",
    );
    return {
      enabled: entries["memory-core"]?.enabled !== false && dreaming.enabled !== false,
      frequency: dreaming.frequency ?? "0 3 * * *",
      applyState: result.configRevisionHash
        ? result.configRevisionHash === result.appliedConfigHash
          ? "applied"
          : "pending"
        : "unknown",
      recallMode: entries["active-memory"]?.enabled === false ? "off" : mode,
      flushBeforeCompaction: config.agents?.defaults?.compaction?.memoryFlush?.enabled !== false,
      timezone: job?.schedule?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(job
        ? {
            schedule: {
              enabled: job.enabled,
              nextRunAt: job.state?.nextRunAtMs,
              lastRunAt: job.state?.lastRunAtMs,
              status: job.state?.lastRunStatus ?? job.state?.lastStatus,
            },
          }
        : {}),
    };
  }
  async save(input: MemoryPreferencesInput): Promise<MemoryPreferences> {
    const frequency = memoryFrequency(input);
    const matches = (value: MemoryPreferences) =>
      value.enabled === input.enabled &&
      value.frequency === frequency &&
      value.recallMode === input.recallMode &&
      value.flushBeforeCompaction === input.flushBeforeCompaction;
    const current = await this.read();
    if (matches(current)) return current;
    const snapshot = await this.gateway.request<{ hash: string; config: any }>("config.get", {});
    if (!snapshot.hash) throw new Error("内核配置版本不可用");
    let writeError: unknown;
    try {
      await this.gateway.request(
        "config.patch",
        {
          baseHash: snapshot.hash,
          response: "summary",
          raw: JSON.stringify({
            plugins: {
              entries: {
                "memory-core": {
                  ...(input.enabled ? { enabled: true } : {}),
                  config: { dreaming: { enabled: input.enabled, frequency } },
                },
                "active-memory": {
                  ...(input.recallMode !== "off" ? { enabled: true } : {}),
                  config: { mode: input.recallMode },
                },
              },
            },
            agents: {
              defaults: { compaction: { memoryFlush: { enabled: input.flushBeforeCompaction } } },
            },
          }),
        },
        { timeoutMs: 15000 },
      );
    } catch (error) {
      writeError = error;
    }
    let saved: MemoryPreferences;
    try {
      saved = await this.read();
    } catch {
      throw new Error("保存结果尚未确认，请稍后刷新；不要重复提交");
    }
    if (
      saved.enabled !== input.enabled ||
      saved.frequency !== frequency ||
      saved.recallMode !== input.recallMode ||
      saved.flushBeforeCompaction !== input.flushBeforeCompaction
    )
      throw writeError ?? new Error("记忆配置尚未确认，请刷新后重试");
    return saved;
  }
}
