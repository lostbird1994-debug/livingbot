// Per-session stdio MCP transport. Credentials are supplied by the native host in env.

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const config = JSON.parse(process.env.RAKAZO_COLLABORATION ?? "{}");
const url = new URL(config.url);
if (
  url.protocol !== "http:" ||
  url.hostname !== "127.0.0.1" ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  !/^[a-f0-9]{64}$/.test(config.clientToken ?? "")
)
  throw Error("Invalid collaboration transport");
const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${config.clientToken}`,
};
const prefix = randomUUID();
async function rpc(method, params = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    redirect: "error",
    body: JSON.stringify({ method, params, sessionKey: config.sessionKey, runId: config.runId }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!response.ok) throw Error("LivingBot collaboration transport unavailable");
  return response.json();
}
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
async function handle(message) {
  if (message.method === "notifications/cancelled" && message.params?.requestId !== undefined) {
    try {
      await rpc("tools/cancel", { id: `${prefix}:${message.params.requestId}` });
    } catch {}
    return;
  }
  if (message.id === undefined) return;
  try {
    let result;
    if (message.method === "initialize")
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "rakazo-collaboration", version: "1.0.0" },
      };
    else if (message.method === "ping") result = {};
    else if (message.method === "tools/list") {
      result = await rpc("tools/list");
    } else if (message.method === "tools/call") {
      const value = await rpc("tools/call", {
        id: `${prefix}:${message.id}`,
        name: message.params?.name,
        args: message.params?.arguments ?? {},
      });
      result = {
        content: [{ type: "text", text: JSON.stringify(value) }],
        ...(value?.error ? { isError: true } : {}),
      };
    } else throw Error("Unsupported MCP method");
    send({ jsonrpc: "2.0", id: message.id, result });
  } catch {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32000,
        message: "LivingBot collaboration call failed; do not assume delivery",
      },
    });
  }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (line.length > 256_000) return;
  try {
    void handle(JSON.parse(line));
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
  }
});
