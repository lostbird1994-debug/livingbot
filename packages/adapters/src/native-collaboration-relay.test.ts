import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NativeCollaborationBroker } from "./native-collaboration-broker.js";

describe("native collaboration stdio MCP relay", () => {
  it("lists only granted tools and waits for the actual host tool result", async () => {
    const broker = new NativeCollaborationBroker();
    const sessionKey = `agent:codex:rakazo:${"a".repeat(64)}`;
    const runId = `rakazo-${"b".repeat(64)}`;
    const tools = [
      {
        name: "message_bot",
        description: "Message teammate",
        inputSchema: { type: "object", properties: { message: { type: "string" } } },
      },
    ];
    const grant = broker.register({ sessionKey, runId, tools });
    let called!: () => void;
    const callSeen = new Promise<void>((resolve) => {
      called = resolve;
    });
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      try {
        broker.client({ ...body, clientToken: req.headers.authorization?.replace(/^Bearer /, "") });
        const result =
          body.method === "tools/cancel"
            ? broker.cancel(body.sessionKey, body.runId, body.params.id)
            : body.method === "tools/list"
              ? { tools: broker.tools(body.sessionKey, body.runId).tools }
              : broker.call(body.sessionKey, body.runId, body.params);
        if (body.method === "tools/call") called();
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(await result));
      } catch {
        res.writeHead(403);
        res.end("{}");
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing test server");
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./native-collaboration-relay.mjs", import.meta.url))],
      {
        env: {
          ...process.env,
          RAKAZO_COLLABORATION: JSON.stringify({
            ...grant,
            sessionKey,
            runId,
            url: `http://127.0.0.1:${address.port}/collaboration`,
          }),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const replies = new Map<number, (reply: any) => void>();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const reply = JSON.parse(line);
      replies.get(reply.id)?.(reply);
    });
    const rpc = (id: number, method: string, params?: unknown) =>
      new Promise<any>((resolve) => {
        replies.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    try {
      expect((await rpc(1, "initialize")).result.capabilities).toEqual({ tools: {} });
      expect((await rpc(2, "tools/list")).result.tools).toEqual(tools);
      const pending = rpc(3, "tools/call", {
        name: "message_bot",
        arguments: { message: "hello" },
      });
      await callSeen;
      const [call] = broker.poll({ sessionKey, runId }).calls;
      expect(call).toMatchObject({ name: "message_bot", args: { message: "hello" } });
      broker.resolve({
        sessionKey,
        runId,
        id: call!.id,
        result: { delivered: true, marker: "from-host" },
      });
      expect((await pending).result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({ delivered: true, marker: "from-host" }),
        },
      ]);
      expect((await rpc(4, "tools/call", { name: "shell", arguments: {} })).error).toBeDefined();
      const secondSeen = new Promise<void>((resolve) => {
        called = resolve;
      });
      const cancelled = rpc(5, "tools/call", {
        name: "message_bot",
        arguments: { message: "cancel me" },
      });
      await secondSeen;
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 5 },
        }) + "\n",
      );
      expect((await cancelled).result.isError).toBe(true);
      expect(broker.poll({ sessionKey, runId }).calls).toEqual([]);
    } finally {
      broker.close({ sessionKey, runId });
      child.kill("SIGTERM");
      lines.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
