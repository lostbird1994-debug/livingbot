/**
 * IMA OpenAPI transport: credential discovery, one POST helper, and the
 * {code,msg,data} envelope turned into either data or a message the model can
 * repeat to the user.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_URL = "https://ima.qq.com";
const DEFAULT_TIMEOUT_MS = 60_000;

export class ImaError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "ImaError";
    this.code = code;
  }
}

export type Credentials = { clientId: string; apiKey: string };

async function readCredentialFile(name: string): Promise<string> {
  try {
    return (await readFile(join(homedir(), ".config", "ima", name), "utf8")).trim();
  } catch {
    return "";
  }
}

/**
 * Environment first (a connection can hold its own pair), then the shared
 * IMA CLI location. Values are only ever used as request headers.
 */
export async function loadCredentials(
  env: Record<string, string | undefined> = process.env,
): Promise<Credentials> {
  const clientId = (env.IMA_CLIENT_ID ?? "").trim() || (await readCredentialFile("client_id"));
  const apiKey = (env.IMA_API_KEY ?? "").trim() || (await readCredentialFile("api_key"));
  if (!clientId || !apiKey) {
    const missing = [!clientId && "client_id", !apiKey && "api_key"].filter(Boolean).join("、");
    throw new ImaError(
      `未找到 IMA 凭证（${missing}）。请设置 IMA_CLIENT_ID 和 IMA_API_KEY 环境变量，或把凭证放在 ~/.config/ima/ 下。`,
    );
  }
  return { clientId, apiKey };
}

export type ImaClient = {
  call(path: string, body: unknown): Promise<Record<string, unknown>>;
};

export function createImaClient(options: {
  credentials: Credentials;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): ImaClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async call(path, body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "ima-openapi-clientid": options.credentials.clientId,
            "ima-openapi-apikey": options.credentials.apiKey,
          },
          body: JSON.stringify(body ?? {}),
          signal: controller.signal,
        });
        const text = await response.text();
        let payload: unknown;
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          throw new ImaError(`IMA 返回了无法解析的内容（HTTP ${response.status}）`);
        }
        const record = isRecord(payload) ? payload : {};
        const code = typeof record.code === "number" ? record.code : undefined;
        if (code !== undefined && code !== 0) {
          // Keep IMA's wording, but name the fix for the failure users hit most.
          const message =
            typeof record.msg === "string" && record.msg ? record.msg : `IMA 返回错误码 ${code}`;
          const hint =
            code === 200002 || code === 20004
              ? "（IMA 拒绝了当前凭证，请确认 Client ID 与 API Key 有效且未过期）"
              : "";
          throw new ImaError(`${message}${hint}`, code);
        }
        if (!response.ok) {
          throw new ImaError(
            typeof record.msg === "string" && record.msg
              ? record.msg
              : `IMA 请求失败（HTTP ${response.status}）`,
          );
        }
        const data = record.data;
        return isRecord(data) ? data : {};
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new ImaError(`IMA 请求超时（${timeoutMs} 毫秒）`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
