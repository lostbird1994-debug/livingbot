import type { ModelConnection } from "./config.ts";

// Reuses native model-row fields and the machine-readable Models API declarations.
// A model name alone is never evidence of a protocol or a supported effort.
export type ModelCapabilities = {
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  efforts?: string[];
  defaultEffort?: string;
};
export const MODEL_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
    ? value
    : undefined;

export function declaredModelCapabilities(value: unknown): ModelCapabilities {
  const row = record(value);
  const effort = record(row.effort);
  const capabilities = record(row.capabilities);
  const claudeEffort = record(capabilities.effort);
  const levels = Array.isArray(effort.supported_levels)
    ? effort.supported_levels
    : Object.keys(claudeEffort).filter((key) => record(claudeEffort[key]).supported === true);
  const efforts = MODEL_EFFORTS.filter((level) => levels.includes(level));
  const thinking = record(capabilities.thinking).supported;
  const images = record(capabilities.image_input).supported;
  const input =
    Array.isArray(row.input_modalities) && row.input_modalities.includes("text")
      ? row.input_modalities.includes("image")
        ? ["text", "image"]
        : ["text"]
      : typeof images === "boolean"
        ? images
          ? ["text", "image"]
          : ["text"]
        : undefined;
  return {
    ...(efforts.length ? { efforts, reasoning: true } : {}),
    ...(typeof thinking === "boolean" ? { reasoning: thinking } : {}),
    ...(typeof effort.default_level === "string" &&
    efforts.includes(effort.default_level as (typeof MODEL_EFFORTS)[number])
      ? { defaultEffort: effort.default_level }
      : {}),
    ...(positive(row.context_window ?? row.max_input_tokens)
      ? { contextWindow: positive(row.context_window ?? row.max_input_tokens) }
      : {}),
    ...(positive(row.max_output_tokens ?? row.max_tokens)
      ? { maxTokens: positive(row.max_output_tokens ?? row.max_tokens) }
      : {}),
    ...(input ? { input: input as ("text" | "image")[] } : {}),
  };
}

/** Read only the configured endpoint; never follow redirects carrying credentials. */
export async function discoverModelCapabilities(
  connection: Pick<ModelConnection, "baseUrl" | "model" | "api" | "apiKey" | "headers">,
  fetcher: typeof fetch = fetch,
): Promise<ModelCapabilities> {
  const url = new URL(`${connection.baseUrl.replace(/\/$/, "")}/models`);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid model endpoint");
  const headers = new Headers(connection.headers);
  if (connection.apiKey) {
    if (connection.api === "anthropic-messages") headers.set("x-api-key", connection.apiKey);
    else headers.set("authorization", `Bearer ${connection.apiKey}`);
  }
  if (connection.api === "anthropic-messages" && !headers.has("anthropic-version"))
    headers.set("anthropic-version", "2023-06-01");
  const response = await fetcher(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || !response.body) throw new Error("Model discovery unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_048_576) throw new Error("Model catalog exceeds limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const rows = record(JSON.parse(Buffer.concat(chunks).toString("utf8"))).data;
  const row = Array.isArray(rows)
    ? rows.find((item) => record(item).id === connection.model)
    : undefined;
  return declaredModelCapabilities(row);
}
