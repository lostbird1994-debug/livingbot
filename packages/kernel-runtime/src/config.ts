import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
} from "../../contracts/src/model-defaults.ts";
import { parseModelHeaders } from "../../contracts/src/model-headers.ts";
import type { RuntimePaths } from "./paths.ts";

export type ModelConnection = {
  id: string;
  baseUrl: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages";
  apiKey: string;
  model: string;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  reasoning?: boolean;
  thinkingLevel?: string;
  embeddingModel?: string;
};

export function modelLimits(contextWindow: unknown, maxTokens: unknown) {
  const context = contextWindow === undefined ? DEFAULT_MODEL_CONTEXT_WINDOW : contextWindow;
  const output =
    maxTokens === undefined || maxTokens === null ? DEFAULT_MODEL_MAX_TOKENS : maxTokens;
  if (
    typeof context !== "number" ||
    typeof output !== "number" ||
    !Number.isInteger(context) ||
    !Number.isInteger(output) ||
    context < 1 ||
    context > 2_147_483_647 ||
    output < 1 ||
    output >= context
  ) {
    throw new Error("请检查上下文和输出 token 限制");
  }
  return { contextWindow: context, maxTokens: output };
}

export function modelThinkingLevel(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (
    typeof value !== "string" ||
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
  ) {
    throw new Error("请选择有效的思考强度");
  }
  return value;
}

export function modelInputs(value: unknown): ("text" | "image")[] {
  if (value === undefined) return ["text"];
  if (
    !Array.isArray(value) ||
    !value.includes("text") ||
    new Set(value).size !== value.length ||
    value.some((item) => item !== "text" && item !== "image")
  )
    throw new Error("请选择模型支持的输入类型");
  return value.includes("image") ? ["text", "image"] : ["text"];
}

export type AgentConfig = {
  id: string;
  workspace?: string;
  instructions?: string;
  rememberAcrossConversations?: boolean;
};

export function validateAgentId(id: string): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new Error("Invalid engine agent identifier");
}

export function buildKernelConfig(
  paths: RuntimePaths,
  port: number,
  token: string,
  agents: AgentConfig[],
  connection?: ModelConnection,
  embeddings?: {
    provider: string;
    model: string;
    baseUrl: string;
    command: string;
    args: string[];
    healthUrl: string;
  },
): Record<string, unknown> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid kernel port");
  if (agents.length === 0) throw new Error("At least one agent is required");
  const entries: Record<string, unknown> = {};
  for (const agent of agents) {
    validateAgentId(agent.id);
    if (entries[agent.id]) throw new Error("Duplicate agent identifier");
    entries[agent.id] = {
      workspace: agent.workspace ?? join(paths.workspaces, agent.id),
      memory: {
        search: { rememberAcrossConversations: agent.rememberAcrossConversations ?? true },
      },
    };
  }
  const config: Record<string, unknown> = {
    gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
    agents: {
      ownership: "explicit",
      defaults: {
        workspace: join(paths.workspaces, agents[0]!.id),
        systemAgent: { agentId: agents[0]!.id },
        authInheritance: { agentId: agents[0]!.id },
        ...(connection
          ? {
              model: { primary: `${connection.id}/${connection.model}` },
              ...(modelThinkingLevel(connection.thinkingLevel)
                ? {
                    models: {
                      [`${connection.id}/${connection.model}`]: {
                        params: { thinking: connection.thinkingLevel },
                      },
                    },
                  }
                : {}),
            }
          : {}),
      },
      entries,
    },
    memory: {
      search: {
        // A local runtime wins: it is the only embedding provider this install can serve.
        provider: embeddings?.provider ?? (connection?.embeddingModel ? connection.id : "none"),
        ...(embeddings
          ? { model: embeddings.model }
          : connection?.embeddingModel
            ? { model: connection.embeddingModel }
            : {}),
        store: { fts: { tokenizer: "trigram" } },
      },
    },
    plugins: {
      slots: { memory: "memory-core" },
      entries: { "memory-core": { enabled: true }, "active-memory": { enabled: true } },
    },
    tools: { sessions: { visibility: "self" }, agentToAgent: { enabled: false } },
    // Keep the always-present skill directory compact; full skill instructions
    // remain available through on-demand skill reads.
    skills: { limits: { maxSkillsPromptChars: 8_000 } },
  };
  if (connection) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(connection.id))
      throw new Error("Invalid model connection identifier");
    const base = new URL(connection.baseUrl);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) {
      throw new Error("Invalid model endpoint");
    }
    config.models = {
      providers: {
        [connection.id]: {
          baseUrl: connection.baseUrl,
          api: connection.api,
          apiKey: connection.apiKey,
          ...(connection.headers !== undefined
            ? { headers: parseModelHeaders(connection.headers) }
            : {}),
          models: [
            {
              id: connection.model,
              name: connection.model,
              input: modelInputs(connection.input),
              ...modelLimits(connection.contextWindow, connection.maxTokens),
              ...(connection.reasoning !== undefined ? { reasoning: connection.reasoning } : {}),
            },
          ],
        },
      },
    };
  }
  if (embeddings) {
    // The official managed service, described exactly as the setup writes it, but
    // under this application's own state directory.
    const providers =
      (config.models as { providers?: Record<string, unknown> } | undefined)?.providers ?? {};
    config.models = {
      providers: {
        ...providers,
        [embeddings.provider]: {
          baseUrl: embeddings.baseUrl,
          api: "openai-completions",
          timeoutSeconds: 120,
          localService: {
            command: embeddings.command,
            args: embeddings.args,
            healthUrl: embeddings.healthUrl,
            readyTimeoutMs: 30_000,
            idleStopMs: 600_000,
          },
          models: [],
        },
      },
    };
  }
  return config;
}

export function newGatewayToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function writeKernelConfig(
  paths: RuntimePaths,
  config: Record<string, unknown>,
): Promise<void> {
  await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
}
