import { createInterface } from "node:readline";
import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// Synthetic protocol peer only. It never authenticates or calls a real model.
const lines = createInterface({ input: process.stdin });
const pending = new Map();
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
for await (const line of lines) {
  const message = JSON.parse(line);
  await appendFile(process.argv[2], `${JSON.stringify({ pid: process.pid, ...message })}\n`, { mode: 0o600 });
  let result = {};
  if (message.method === "initialize") result = {
    protocolVersion: 1, agentInfo: { name: "synthetic-delegate", version: "1.0.0" },
    agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } }, authMethods: [],
  };
  if (message.method === "session/new") result = { sessionId: randomUUID() };
  if (message.method === "session/prompt") {
    if (JSON.stringify(message.params.prompt).includes("WAIT-FOR-CANCEL")) {
      const timer = setTimeout(() => {
        pending.delete(message.params.sessionId);
        send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }, 30_000);
      pending.set(message.params.sessionId, { id: message.id, timer });
      continue;
    }
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: message.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "SYNTHETIC-ACP-RESULT-4382" } },
    } });
    result = { stopReason: "end_turn" };
  }
  if (message.method === "session/cancel") {
    const prompt = pending.get(message.params.sessionId);
    if (prompt) {
      clearTimeout(prompt.timer);
      pending.delete(message.params.sessionId);
      send({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "cancelled" } });
    }
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result });
}
for (const prompt of pending.values()) clearTimeout(prompt.timer);
