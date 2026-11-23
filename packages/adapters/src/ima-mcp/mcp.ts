/**
 * Minimal stdio MCP server for IMA: newline-delimited JSON-RPC, tools only.
 * LivingBot 2.0 registers this as a local connection, so the endpoint can stay
 * an ordinary script with no framework or runtime dependency.
 */
import { createInterface } from "node:readline";
import {
  type Credentials,
  createImaClient,
  type ImaClient,
  ImaError,
  loadCredentials,
} from "./ima-client.ts";
import type { ToolContext } from "./tools.ts";
import { callTool, TOOLS } from "./tools.ts";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "livingbot-ima";
const SERVER_VERSION = "1.0.0";

type Request = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type Response = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

export type McpOptions = {
  /** Injected in tests; production reads the environment or ~/.config/ima. */
  credentials?: Credentials;
  env?: Record<string, string | undefined>;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  uploadFile?: ToolContext["uploadFile"];
  readFileImpl?: ToolContext["readFileImpl"];
  statImpl?: ToolContext["statImpl"];
};

/**
 * The client is created on the first tool call: listing tools must work while a
 * connection is still unconfigured, so the desktop can show what it offers.
 */
export function createImaMcpHandler(options: McpOptions = {}) {
  let client: ImaClient | undefined;
  const context = async (): Promise<ToolContext> => {
    client ??= createImaClient({
      credentials: options.credentials ?? (await loadCredentials(options.env ?? process.env)),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    return {
      client,
      ...(options.uploadFile ? { uploadFile: options.uploadFile } : {}),
      ...(options.readFileImpl ? { readFileImpl: options.readFileImpl } : {}),
      ...(options.statImpl ? { statImpl: options.statImpl } : {}),
    };
  };

  return async function handle(message: Request): Promise<Response | undefined> {
    const id = message.id ?? null;
    const method = message.method ?? "";
    if (method === "initialize") {
      const requested = message.params?.protocolVersion;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      };
    }
    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        },
      };
    }
    if (method === "tools/call") {
      const name = typeof message.params?.name === "string" ? message.params.name : "";
      const args = message.params?.arguments;
      try {
        const text = await callTool(await context(), name, isRecord(args) ? args : {});
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text }], isError: false },
        };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: messageOf(error) }],
            isError: true,
          },
        };
      }
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (message.id === undefined) return undefined;
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `不支持的方法：${method}` } };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  if (error instanceof ImaError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Entry point: line-delimited requests in, line-delimited responses out. */
export function serve(input = process.stdin, output = process.stdout): void {
  const handle = createImaMcpHandler();
  const write = (response: Response | undefined) => {
    if (response) output.write(`${JSON.stringify(response)}\n`);
  };
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Request;
    try {
      message = JSON.parse(trimmed) as Request;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "消息不是合法 JSON" } });
      return;
    }
    void handle(message)
      .then(write)
      .catch((error: unknown) => {
        write({
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: { code: -32603, message: messageOf(error) },
        });
      });
  });
}
