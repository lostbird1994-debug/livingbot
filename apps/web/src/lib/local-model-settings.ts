import type {
  Me,
  ModelCatalogEntry,
  ModelConnectInput,
  ModelCredential,
  ModelRoleChoice,
  ModelRoleView,
} from "@livingbot/contracts";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  ModelConnectInputSchema,
  ModelRoleUpdateSchema,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@livingbot/contracts";
import type { ModelSettings } from "../../../../packages/kernel-runtime/src/model-settings";

export const LOCAL_MODEL_CONTEXT_WINDOW = DEFAULT_MODEL_CONTEXT_WINDOW;

export type LocalModelSettingsConnection = {
  origin: string;
  token: string;
};

export type LocalModelSettingsRequest = <T>(
  connection: LocalModelSettingsConnection,
  path: string,
  init?: RequestInit,
) => Promise<T>;

function unsupported(procedure: string): never {
  throw new Error(`本机模型服务暂不支持 ${procedure}`);
}

function modelEntry(settings: ModelSettings): ModelCatalogEntry[] {
  return [
    {
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      providerName: "OpenAI-compatible",
      id: settings.configured ? settings.model : "",
      label: settings.configured ? settings.model : "OpenAI-compatible",
      billing: "provider",
      auth: "api-key",
      images: settings.input.includes("image"),
      ...(!settings.configured ? { placeholder: true } : {}),
    },
  ];
}

function credential(settings: ModelSettings): ModelCredential | null {
  if (!settings.configured || !settings.model) return null;
  return {
    id: `local:${settings.id}`,
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    label: settings.id,
    hasKey: settings.hasKey,
    isDefault: true,
    baseUrl: settings.baseUrl,
    apiProtocol:
      settings.api === "openai-responses"
        ? "responses"
        : settings.api === "anthropic-messages"
          ? "anthropic-messages"
          : "chat-completions",
    modelId: settings.model,
    contextWindow: settings.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
    maxTokens: settings.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
    headerNames: settings.headerNames,
    reasoning: settings.reasoning,
    thinkingLevel: settings.thinkingLevel as ModelCredential["thinkingLevel"],
    thinkingLevels: settings.thinkingLevels as ModelCredential["thinkingLevels"],
    supportsImages: settings.input.includes("image"),
    enabledModelIds: [settings.model],
    authKind: "openai_compatible",
  };
}

function roleView(settings: ModelSettings): ModelRoleView {
  const saved = credential(settings);
  return {
    primary: saved
      ? {
          provider: saved.provider,
          modelId: settings.model,
          credentialId: saved.id,
          ...(saved.thinkingLevel != null ? { thinkingLevel: saved.thinkingLevel } : {}),
        }
      : null,
    backups: [],
  };
}

/** Merge into bootstrap.me AND the me RPC result; no cached config or secret reads in the browser. */
export async function readLocalModelDefaults(
  connection: LocalModelSettingsConnection,
  request: LocalModelSettingsRequest,
): Promise<Pick<Me, "needsModel" | "defaultProvider" | "defaultModel">> {
  const settings = await request<ModelSettings>(connection, "/api/model-settings");
  return {
    needsModel: !settings.configured,
    defaultProvider: settings.configured ? OPENAI_COMPATIBLE_PROVIDER_ID : null,
    defaultModel: settings.configured ? settings.model : null,
  };
}

function saveInput(input: ModelConnectInput, current: ModelSettings): Record<string, unknown> {
  if (input.provider !== OPENAI_COMPATIBLE_PROVIDER_ID) {
    return unsupported("models.connect (only the native compatible provider is available)");
  }
  if (
    input.accountId !== undefined ||
    input.gatewayId !== undefined ||
    input.maxImagesPerPrompt != null ||
    input.enabledModelIds?.some((id) => id !== input.modelId)
  ) {
    return unsupported("models.connect options not represented by /api/model-settings");
  }
  const saved = credential(current);
  if (input.credentialId && input.credentialId !== saved?.id) {
    throw new Error("模型连接已变化，请重新打开设置");
  }
  if (current.configured && input.credentialId === null) {
    return unsupported("添加多个模型连接；请编辑当前连接");
  }
  if (input.makeDefault === false && !saved) return unsupported("保存连接但不切换默认模型");
  const baseUrl = input.baseUrl?.trim();
  const model = input.modelId?.trim();
  if (!baseUrl || !model) throw new Error("服务地址和模型名称不能为空");
  const endpoint = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("请检查模型服务地址");
  // Unlike the legacy remote API, native save keeps paths exactly as entered.
  // Never reuse a stored secret on another endpoint without an explicit replacement.
  if (
    current.hasKey &&
    !input.apiKey &&
    endpoint.href.replace(/\/$/, "") !== current.baseUrl.replace(/\/$/, "")
  ) {
    throw new Error("更换服务地址时请重新输入密钥");
  }
  if (
    current.headerNames?.length &&
    input.headers === undefined &&
    endpoint.href.replace(/\/$/, "") !== current.baseUrl.replace(/\/$/, "")
  ) {
    throw new Error("更换服务地址时请重新输入或清除自定义请求头");
  }
  const api =
    input.apiProtocol === "responses"
      ? "openai-responses"
      : input.apiProtocol === "anthropic-messages"
        ? "anthropic-messages"
        : "openai-completions";
  return {
    discover: true,
    id: current.configured ? current.id : "local",
    baseUrl,
    api,
    model,
    input:
      input.supportsImages === undefined
        ? current.input
        : input.supportsImages
          ? ["text", "image"]
          : ["text"],
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.headers !== undefined ? { headers: input.headers } : {}),
    ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
  };
}

export type LocalModelSettingsResult = { handled: false } | { handled: true; value: unknown };

/**
 * Donors: original useModelSettings/modelConnectRequest and workbench-web/ModelSettings.
 * The native endpoint supports one active connection, not a credential registry.
 * Dispatch before the parent's fallback; all models.* gaps fail here explicitly.
 */
export async function handleLocalModelSettings(
  procedure: string,
  input: unknown,
  connection: LocalModelSettingsConnection,
  request: LocalModelSettingsRequest,
): Promise<LocalModelSettingsResult> {
  const path = procedure.replace(/^\//, "").replaceAll("/", ".");
  if (!path.startsWith("models.")) return { handled: false };
  const payload = (input ?? {}) as Record<string, unknown>;
  if (
    (path === "models.role" || path === "models.forRole" || path === "models.setRole") &&
    payload.role !== "main"
  )
    return unsupported("审批模型");
  if (path === "models.list" || path === "models.forRole") {
    const settings = await request<ModelSettings>(connection, "/api/model-settings");
    return { handled: true, value: modelEntry(settings) };
  }
  if (path === "models.credentials") {
    const settings = await request<ModelSettings>(connection, "/api/model-settings");
    const value = credential(settings);
    return { handled: true, value: value ? [value] : [] };
  }
  if (path === "models.role" || path === "models.backups") {
    const settings = await request<ModelSettings>(connection, "/api/model-settings");
    return { handled: true, value: path === "models.backups" ? [] : roleView(settings) };
  }
  if (path === "models.connect") {
    const parsed = ModelConnectInputSchema.safeParse(input);
    if (!parsed.success) throw new Error("请检查模型连接设置");
    const current = await request<ModelSettings>(connection, "/api/model-settings");
    const saved = await request<ModelSettings>(connection, "/api/model-settings", {
      method: "POST",
      body: JSON.stringify(saveInput(parsed.data, current)),
    });
    const value = credential(saved);
    if (!value) throw new Error("本机服务未返回已保存的模型");
    return { handled: true, value };
  }
  if (path === "models.probeOpenAiCompatible") {
    const current = await request<ModelSettings>(connection, "/api/model-settings");
    if (
      !current.configured ||
      String(payload.baseUrl).replace(/\/$/, "") !== current.baseUrl.replace(/\/$/, "") ||
      (payload.apiKey && payload.apiKey !== "") ||
      payload.headers !== undefined ||
      (payload.credentialId !== undefined && payload.credentialId !== `local:${current.id}`) ||
      (payload.apiProtocol !== undefined &&
        payload.apiProtocol !== credential(current)?.apiProtocol)
    )
      throw new Error("请先保存当前连接再刷新模型能力");
    const saved = await request<ModelSettings>(connection, "/api/model-settings/discover", {
      method: "POST",
    });
    return { handled: true, value: { models: [saved.model] } };
  }
  if (path === "models.setDefault" || path === "models.setRole") {
    if (path === "models.setRole") {
      const patch = ModelRoleUpdateSchema.safeParse(payload);
      if (!patch.success) throw new Error("请检查主模型设置");
      if (patch.data.backups?.length) return unsupported("备用模型");
      if (patch.data.primary === null) return unsupported("清除本机主模型");
    }
    const current = await request<ModelSettings>(connection, "/api/model-settings");
    const view = roleView(current);
    const choice = (path === "models.setRole" ? payload.primary : payload) as
      | ModelRoleChoice
      | undefined;
    if (
      !view.primary ||
      (choice &&
        (choice.provider !== view.primary.provider ||
          choice.modelId !== view.primary.modelId ||
          (choice.credentialId !== undefined && choice.credentialId !== view.primary.credentialId)))
    ) {
      return unsupported("选择未保存的模型；请先编辑当前连接");
    }
    if (
      choice &&
      choice.thinkingLevel !== undefined &&
      choice.thinkingLevel !== current.thinkingLevel
    ) {
      const saved = await request<ModelSettings>(connection, "/api/model-settings", {
        method: "POST",
        body: JSON.stringify({
          id: current.id,
          model: current.model,
          api: current.api,
          baseUrl: current.baseUrl,
          thinkingLevel: choice.thinkingLevel,
        }),
      });
      return { handled: true, value: path === "models.setRole" ? roleView(saved) : { ok: true } };
    }
    // The native endpoint always saves the default. An unchanged selection is
    // already persisted; do not rewrite config and restart the gateway for it.
    return { handled: true, value: path === "models.setRole" ? view : { ok: true } };
  }
  if (
    path === "models.probeOpenAiCompatible" ||
    path === "models.probeCatalog" ||
    path === "models.disconnect" ||
    path === "models.rename" ||
    path === "models.setBackups" ||
    path === "models.beginOAuth"
  ) {
    return unsupported(path);
  }
  return unsupported(path);
}
