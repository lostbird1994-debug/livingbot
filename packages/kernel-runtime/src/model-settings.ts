import { parseModelHeaders } from "../../contracts/src/model-headers.ts";
import type { ModelConnection } from "./config.ts";
import { modelInputs, modelLimits, modelThinkingLevel } from "./config.ts";
import type { GatewayRequests } from "./contracts.ts";
import type { ModelCapabilities } from "./model-capabilities.ts";
import { discoverModelCapabilities, MODEL_EFFORTS } from "./model-capabilities.ts";

export type ModelSettings = {
  configured: boolean;
  id: string;
  baseUrl: string;
  api: ModelConnection["api"];
  model: string;
  hasKey: boolean;
  input: ("text" | "image")[];
  headerNames?: string[];
  reasoning?: boolean;
  thinkingLevel?: string | null;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevels?: string[];
};

type NativeModel = {
  id: string;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  api?: ModelConnection["api"];
  baseUrl?: string;
  [field: string]: unknown;
};
type NativeProvider = {
  baseUrl?: string;
  api?: ModelConnection["api"];
  apiKey?: unknown;
  headers?: Record<string, unknown>;
  maxTokens?: number;
  models?: NativeModel[];
};
type NativeConfig = {
  agents?: {
    defaults?: {
      model?: string | { primary?: string };
      models?: Record<string, { params?: Record<string, unknown> }>;
    };
  };
  models?: { providers?: Record<string, NativeProvider> };
};

/** Credentials stay in the native configuration; read responses contain no key. */
export class OpenClawModelSettings {
  private readonly gateway: GatewayRequests;
  private readonly fetcher: typeof fetch;
  constructor(gateway: GatewayRequests, fetcher: typeof fetch = fetch) {
    this.gateway = gateway;
    this.fetcher = fetcher;
  }

  private snapshot() {
    return this.gateway.request<{
      hash: string;
      config: NativeConfig;
    }>("config.get", {});
  }

  async read(): Promise<ModelSettings> {
    const { config } = await this.snapshot();
    const selection = config.agents?.defaults?.model;
    const primary = typeof selection === "string" ? selection : (selection?.primary ?? "");
    const slash = primary.indexOf("/");
    const id = slash > 0 ? primary.slice(0, slash) : "local";
    const provider = config.models?.providers?.[id];
    const row = provider?.models?.find((item) => item.id === primary.slice(slash + 1));
    const thinking = config.agents?.defaults?.models?.[primary]?.params?.thinking;
    return {
      configured: Boolean(provider && slash > 0),
      id,
      baseUrl: row?.baseUrl ?? provider?.baseUrl ?? "",
      api: row?.api ?? provider?.api ?? "openai-completions",
      model: slash > 0 ? primary.slice(slash + 1) : "",
      hasKey: Boolean(provider?.apiKey),
      input: row?.input?.includes("image") ? ["text", "image"] : ["text"],
      headerNames: Object.keys(provider?.headers ?? {}),
      reasoning: row?.reasoning ?? false,
      ...(supportedEfforts(row) ? { thinkingLevels: supportedEfforts(row) } : {}),
      thinkingLevel:
        thinking === false || thinking === "disabled"
          ? "off"
          : typeof thinking === "string"
            ? thinking
            : null,
      ...modelLimits(row?.contextWindow, row?.maxTokens ?? provider?.maxTokens),
    };
  }

  async save(input: Record<string, unknown>): Promise<ModelSettings> {
    const id = input.id;
    const model = input.model;
    const api = input.api;
    const base = typeof input.baseUrl === "string" ? URL.parse(input.baseUrl) : null;
    if (
      typeof id !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(id) ||
      typeof model !== "string" ||
      !model.trim() ||
      model !== model.trim() ||
      model.length > 256 ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls in identifiers.
      /[\u0000-\u001f\u007f]/u.test(model) ||
      !["openai-completions", "openai-responses", "anthropic-messages"].includes(String(api)) ||
      !base ||
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      throw new Error("请检查模型名称、接口格式和服务地址");
    }
    if (
      input.apiKey !== undefined &&
      (typeof input.apiKey !== "string" ||
        input.apiKey.length > 8192 ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls in secrets.
        /[\u0000-\u001f\u007f]/u.test(input.apiKey))
    )
      throw new Error("密钥格式不正确");
    const snapshot = await this.snapshot();
    if (!snapshot.hash) throw new Error("无法获取配置版本，请重试");
    const current = snapshot.config.models?.providers?.[id];
    const currentRow = current?.models?.find((item) => item.id === model);
    const modalities =
      input.input === undefined ? (currentRow?.input ?? ["text"]) : modelInputs(input.input);
    const limits = modelLimits(
      input.contextWindow === undefined ? currentRow?.contextWindow : input.contextWindow,
      input.maxTokens === undefined
        ? (currentRow?.maxTokens ?? current?.maxTokens)
        : input.maxTokens,
    );
    if (input.reasoning !== undefined && typeof input.reasoning !== "boolean") {
      throw new Error("请选择模型是否支持思考");
    }
    let thinkingLevel = modelThinkingLevel(input.thinkingLevel);
    const headers = input.headers === undefined ? undefined : parseModelHeaders(input.headers);
    const suppliedKey = typeof input.apiKey === "string" && input.apiKey.length > 0;
    const baseUrl = base.href.replace(/\/$/, "");
    if (current && baseUrl !== (currentRow?.baseUrl ?? current.baseUrl)?.replace(/\/$/, "")) {
      if (current.apiKey && !suppliedKey) throw new Error("更换服务地址时请重新输入密钥");
      if (Object.keys(current.headers ?? {}).length && headers === undefined) {
        throw new Error("更换服务地址时请重新输入或清除自定义请求头");
      }
    }
    const sameConnection =
      baseUrl === (currentRow?.baseUrl ?? current?.baseUrl)?.replace(/\/$/, "") &&
      api === (currentRow?.api ?? current?.api);
    // Compatibility is scoped to this endpoint, protocol and exact model, not its name.
    const retained = sameConnection ? currentRow : undefined;
    const discovered: ModelCapabilities =
      input.discover === true
        ? await discoverModelCapabilities(
            {
              baseUrl,
              model,
              api: api as ModelConnection["api"],
              apiKey: suppliedKey
                ? (input.apiKey as string)
                : typeof current?.apiKey === "string"
                  ? current.apiKey
                  : "",
              headers: headers ?? (current?.headers as Record<string, string> | undefined),
            },
            this.fetcher,
          ).catch(() => {
            if (input.requireDiscovery === true)
              throw new Error("暂时无法读取模型能力，请稍后重试");
            return {};
          })
        : {};
    const row: NativeModel = {
      ...currentRow,
      id: model,
      name: currentRow?.name ?? model,
      input: modalities,
      ...limits,
      ...(currentRow?.api !== undefined ? { api: api as ModelConnection["api"] } : {}),
      ...(currentRow?.baseUrl !== undefined ? { baseUrl } : {}),
      ...(discovered.reasoning !== undefined ? { reasoning: discovered.reasoning } : {}),
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      ...(discovered.efforts
        ? {
            compat: {
              ...asRecord(retained?.compat),
              supportsReasoningEffort: true,
              supportedReasoningEfforts: discovered.efforts,
            },
          }
        : {}),
    };
    if (!sameConnection && !discovered.efforts) {
      delete row.compat;
      delete row.thinkingLevelMap;
    }
    const efforts = supportedEfforts(row);
    if (
      row.reasoning &&
      efforts &&
      thinkingLevel &&
      thinkingLevel !== "off" &&
      !efforts.includes(thinkingLevel)
    )
      throw new Error("服务不支持所选思考强度，请刷新后选择支持的等级");
    if (
      input.discover === true &&
      row.reasoning &&
      efforts === undefined &&
      asRecord(row.compat).supportsReasoningEffort === undefined
    ) {
      // With no declaration or explicit level, "default" means the server's default.
      // Native generic reasoning otherwise injects medium. Do not guess support.
      const requested =
        thinkingLevel === undefined
          ? snapshot.config.agents?.defaults?.models?.[`${id}/${model}`]?.params?.thinking
          : thinkingLevel;
      row.compat = {
        ...asRecord(row.compat),
        supportsReasoningEffort: typeof requested === "string" && requested !== "off",
      };
    }
    if (row.reasoning && efforts?.length) {
      const savedThinking =
        snapshot.config.agents?.defaults?.models?.[`${id}/${model}`]?.params?.thinking;
      if (
        thinkingLevel === null ||
        (thinkingLevel === undefined &&
          input.discover === true &&
          (typeof savedThinking !== "string" || !["off", ...efforts].includes(savedThinking)))
      )
        thinkingLevel =
          discovered.defaultEffort ??
          (efforts.includes("medium") ? "medium" : efforts.includes("high") ? "high" : efforts[0]);
      if (discovered.efforts)
        row.thinkingLevelMap = {
          ...asRecord(retained?.thinkingLevelMap),
          ...Object.fromEntries(
            MODEL_EFFORTS.map((level) => {
              const mapped = asRecord(retained?.thinkingLevelMap)[level];
              return [
                level,
                efforts.includes(level)
                  ? level
                  : typeof mapped === "string" && efforts.includes(mapped)
                    ? mapped
                    : null,
              ];
            }),
          ),
        };
    }
    if (
      (discovered.contextWindow !== undefined && limits.contextWindow > discovered.contextWindow) ||
      (discovered.maxTokens !== undefined && limits.maxTokens > discovered.maxTokens)
    )
      throw new Error("上下文或输出限制超过服务声明的模型上限");
    const rows = current?.models?.some((item) => item.id === model)
      ? current.models.map((item) => (item.id === model ? row : item))
      : [...(current?.models ?? []), row];
    const provider = {
      baseUrl,
      api,
      ...(suppliedKey ? { apiKey: input.apiKey } : {}),
      ...(headers !== undefined ? { headers } : {}),
      models: rows,
    };
    try {
      await this.gateway.request("config.patch", {
        baseHash: snapshot.hash,
        raw: JSON.stringify({
          models: { providers: { [id]: provider } },
          agents: {
            defaults: {
              model: { primary: `${id}/${model}` },
              ...(thinkingLevel !== undefined
                ? {
                    models: {
                      [`${id}/${model}`]: { params: { thinking: thinkingLevel } },
                    },
                  }
                : {}),
            },
          },
        }),
        replacePaths: [
          `models.providers.${id}.models`,
          ...(headers !== undefined ? [`models.providers.${id}.headers`] : []),
        ],
        response: "summary",
      });
      const saved = await this.read();
      if (
        !saved.configured ||
        saved.id !== id ||
        saved.model !== model ||
        saved.baseUrl !== baseUrl ||
        saved.api !== api ||
        saved.contextWindow !== limits.contextWindow ||
        saved.maxTokens !== limits.maxTokens ||
        saved.input.includes("image") !== modalities.includes("image") ||
        (input.reasoning !== undefined && saved.reasoning !== input.reasoning) ||
        (thinkingLevel !== undefined && saved.thinkingLevel !== thinkingLevel) ||
        (headers !== undefined &&
          JSON.stringify(saved.headerNames?.slice().sort()) !==
            JSON.stringify(Object.keys(headers).sort()))
      ) {
        throw new Error("Native readback mismatch");
      }
      return saved;
    } catch {
      throw new Error("模型配置尚未确认保存，请重新查看后重试");
    }
  }

  async discover(): Promise<ModelSettings> {
    const current = await this.read();
    if (!current.configured) throw new Error("请先保存模型连接");
    return this.save({
      id: current.id,
      model: current.model,
      api: current.api,
      baseUrl: current.baseUrl,
      discover: true,
      requireDiscovery: true,
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function supportedEfforts(row: NativeModel | undefined): string[] | undefined {
  const compat = asRecord(row?.compat);
  if (compat.supportsReasoningEffort === false) return [];
  const efforts = compat.supportedReasoningEfforts;
  return Array.isArray(efforts)
    ? MODEL_EFFORTS.filter((level) => efforts.includes(level))
    : undefined;
}
