import { once } from "node:events";
import { createServer } from "node:http";
import type { AgentRuntimeEvent, AgentToolExecutionObserver } from "@livingbot/adapter-kit";
import { expect, it } from "vitest";
import { PiAgentRuntime } from "./pi-runtime.js";

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return `data: ${JSON.stringify({
    id: "fixture",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

it.each([
  { initial: "", code: 0, expectedCalls: 3 },
  { initial: "ok", code: 0, expectedCalls: 2 },
  { initial: "ok", code: 1, expectedCalls: 3 },
])(
  "updates a shell receipt and only continues for news or failure: $initial / $code",
  async ({ initial, code, expectedCalls }) => {
    let calls = 0;
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    let release: () => void = () => undefined;
    const completion = new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      release = () => resolve({ stdout: "ok", stderr: "", code });
    });
    const server = createServer((request, response) => {
      let requestBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        requestBody += chunk;
      });
      request.on("end", () => {
        if (request.method === "POST" && request.url === "/v1/chat/completions")
          requests.push(JSON.parse(requestBody));
      });
      request.resume();
      // Local tools can probe any listening loopback port; only model calls are counted.
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      calls += 1;
      if (calls === 2) release();
      response.writeHead(200, { "content-type": "text/event-stream" });
      const body =
        calls === 1
          ? chunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "shell-1",
                    type: "function",
                    function: { name: "shell", arguments: '{"command":"long-job"}' },
                  },
                ],
              },
              "tool_calls",
            )
          : calls === 2
            ? chunk({ role: "assistant", content: "Started" }) +
              chunk({ content: " the job." }, "stop")
            : chunk({ role: "assistant", content: "It finished." }, "stop");
      response.end(`${body}data: [DONE]\n\n`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
    const executeTool = async (
      _name: string,
      _args: Record<string, unknown>,
      _executionId: string,
      _route: unknown,
      observer?: AgentToolExecutionObserver,
    ) => {
      observer?.onShellStillRunning?.(completion, { stdout: initial, stderr: "" });
      return { stdout: initial, stderr: "", code: null, running: true };
    };
    const events: AgentRuntimeEvent[] = [];
    try {
      for await (const event of new PiAgentRuntime().run(
        {
          botId: "fixture-bot",
          threadId: "fixture-thread",
          runId: "fixture-run",
          prompt: "Start the long job.",
          instructions: "Fixture",
          history: [],
          tools: [
            {
              name: "shell",
              description: "Run a command",
              inputSchema: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
              },
            },
          ],
          executeTool,
          model: {
            provider: "openai-compatible",
            id: "fixture",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            allowPrivateEndpoint: true,
          },
        },
        { signal: AbortSignal.timeout(15_000) },
      )) {
        events.push(event);
      }
      expect(calls).toBe(expectedCalls);
      expect(requests.at(-1)!.messages.filter((message) => message.role === "user")).toHaveLength(
        1,
      );
      if (expectedCalls === 3) {
        const receipt = requests.at(-1)!.messages.find((message) => message.role === "tool");
        expect(JSON.parse(receipt!.content)).toMatchObject({ stdout: "ok", code });
      }
      expect(
        events.flatMap((event) =>
          event.type === "text" ? [event.text] : event.type === "turn" ? ["<turn>"] : [],
        ),
      ).toEqual(
        expectedCalls === 3
          ? ["Started", " the job.", "<turn>", "It finished."]
          : ["Started", " the job."],
      );
    } finally {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    }
  },
);
