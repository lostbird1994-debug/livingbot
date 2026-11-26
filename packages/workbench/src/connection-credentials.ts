import { createHash } from "node:crypto";
import type { ServiceConnections } from "../../kernel-runtime/src/connections.ts";
import type { NativeAuthority } from "./authority.ts";
import { nativeTask } from "./authority.ts";
import type { Interaction, Run, Task } from "./contracts.ts";
import type { WorkbenchStore } from "./store.ts";
import { SUPER_ADMIN_AGENT_ID } from "./system-policy.ts";

const open = (item: Interaction) => item.status === "pending" || item.status === "answering";
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * Reuses the native connection writer and existing masked ask UI. Only public
 * field/destination metadata is persisted; values go straight to config.patch.
 * Native MCP env/headers are scalar values, not SecretRef-capable fields.
 */
export class ConnectionCredentials {
  private readonly saving = new Set<string>();
  private readonly store: WorkbenchStore;
  private readonly connections: ServiceConnections;
  private readonly generation: () => number;
  constructor(
    store: WorkbenchStore,
    connections: ServiceConnections,
    generation: () => number,
  ) {
    this.store = store;
    this.connections = connections;
    this.generation = generation;
  }

  async request(authority: NativeAuthority, input: Record<string, unknown>): Promise<{ id: string; status: string }> {
    const { bot, task } = nativeTask(this.store, authority);
    if (bot.agentId !== SUPER_ADMIN_AGENT_ID || bot.archivedAt || task.routine) {
      throw new Error("只有用户会话中的超级管理员可以配置公共连接");
    }
    const name = input.connection;
    const target = input.target;
    const toolCallId = input.toolCallId;
    const fields = Array.isArray(input.fields) ? input.fields.map(object) : [];
    if (typeof name !== "string" || !name || name.length > 100 || !["env", "headers"].includes(String(target)) ||
      typeof toolCallId !== "string" || !toolCallId || toolCallId.length > 256 || fields.length < 1 || fields.length > 8 ||
      fields.some((field) => Object.keys(field).some((key) => !["key", "label"].includes(key)) ||
        typeof field.key !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/u.test(field.key) ||
        ["__proto__", "constructor", "prototype"].includes(field.key) ||
        typeof field.label !== "string" || !field.label.trim() || field.label.length > 64) ||
      new Set(fields.map((field) => String(field.key).toLowerCase())).size !== fields.length ||
      new Set(fields.map((field) => String(field.label).trim().toLowerCase())).size !== fields.length) {
      throw new Error("凭证字段格式不正确");
    }
    const connection = (await this.connections.list()).find((item) => item.name === name);
    // Recheck after I/O: a cancelled tool cannot create a late input request.
    nativeTask(this.store, authority);
    if (!connection || (connection.transport === "stdio" ? target !== "env" : target !== "headers")) {
      throw new Error("连接不存在或凭证目标与连接方式不符");
    }
    const id = `credentials:${createHash("sha256").update(JSON.stringify([authority.runId, toolCallId])).digest("hex")}`;
    const metadata = {
      name, allowedHosts: [],
      connection: { name, target: target as "env" | "headers", fields: fields as { key: string; label: string }[] },
    };
    const existing = this.store.get<Interaction>("interactions", id);
    if (existing) {
      if (JSON.stringify(existing.secureInput) !== JSON.stringify(metadata)) throw new Error("凭证请求标识冲突");
      return { id, status: existing.status };
    }
    const now = Date.now();
    this.store.transaction(() => {
      this.store.put<Interaction>("interactions", {
        id, engineId: id, kind: "question", ...authority, taskId: task.id, conversationId: task.conversationId,
        generation: this.generation(), title: `配置 ${name}`, secureInput: metadata,
        questions: fields.map((field) => ({
          id: field.key as string, header: field.label as string, question: field.label as string,
          multiSelect: false, allowOther: true, options: [],
        })),
        decisions: [], status: "pending", createdAt: now, expiresAt: now + 15 * 60_000,
      });
      this.store.updateTask(task.id, "waiting");
      const run = this.store.get<Run>("runs", authority.runId)!;
      this.store.put("runs", { ...run, state: "waiting" });
    });
    return { id, status: "pending" };
  }

  status(authority: NativeAuthority, id: string): { id: string; status: string } {
    nativeTask(this.store, authority);
    const prompt = this.store.get<Interaction>("interactions", id);
    if (!prompt?.secureInput?.connection || prompt.runId !== authority.runId || prompt.sessionKey !== authority.sessionKey) {
      throw new Error("凭证请求不属于当前任务");
    }
    if (open(prompt) && prompt.expiresAt <= Date.now() && !this.saving.has(id)) this.finish(prompt, "expired");
    return { id, status: this.store.get<Interaction>("interactions", id)!.status };
  }

  async resolve(id: string, taskId: string, input: { values?: unknown; cancel?: boolean }): Promise<Interaction> {
    const prompt = this.store.get<Interaction>("interactions", id);
    if (!prompt?.secureInput?.connection || prompt.taskId !== taskId) throw new Error("凭证请求不属于当前任务");
    if (prompt.status === "answered" || prompt.status === "cancelled") return prompt;
    const task = this.store.get<Task>("tasks", taskId);
    const run = this.store.get<Run>("runs", prompt.runId);
    if (!open(prompt) || prompt.generation !== this.generation() || prompt.expiresAt <= Date.now() ||
      !task || !["waiting", "running"].includes(task.status) || task.stopRequestedAt !== undefined ||
      !run || !["waiting", "running"].includes(run.state)) throw new Error("凭证请求已失效");
    if (this.saving.has(id)) throw new Error("凭证正在保存");
    if (input.cancel === true) return this.finish(prompt, "cancelled");
    const values = object(input.values);
    const { connection } = prompt.secureInput;
    const keys = connection.fields.map((field) => field.key);
    if (Object.keys(values).length !== keys.length || keys.some((key) => !Object.hasOwn(values, key) ||
      typeof values[key] !== "string" || !(values[key] as string).length || (values[key] as string).length > 8192 ||
      /[\u0000\r\n]/u.test(values[key] as string))) throw new Error("请填写全部凭证字段");
    this.saving.add(id);
    try {
      this.store.put("interactions", { ...prompt, status: "answering" });
      await this.connections.update(connection.name, { [connection.target]: values });
      // Saving proves configuration only. It never claims the remote account is valid.
      const current = this.store.get<Interaction>("interactions", id)!;
      return this.finish(current, "answered");
    } catch {
      const current = this.store.get<Interaction>("interactions", id)!;
      if (open(current)) this.store.put("interactions", { ...current, status: "pending" });
      throw new Error("凭证保存未确认，请检查连接后重试");
    } finally {
      this.saving.delete(id);
    }
  }

  private finish(prompt: Interaction, status: Interaction["status"]): Interaction {
    return this.store.transaction(() => {
      const result = this.store.put<Interaction>("interactions", { ...prompt, status });
      const task = this.store.get<Task>("tasks", prompt.taskId);
      if (task?.status === "waiting" && !this.store.list<Interaction>("interactions").some((item) => item.taskId === task.id && open(item))) {
        this.store.updateTask(task.id, "running");
        const run = this.store.get<Run>("runs", prompt.runId);
        if (run?.state === "waiting") this.store.put("runs", { ...run, state: "running" });
      }
      return result;
    });
  }
}
