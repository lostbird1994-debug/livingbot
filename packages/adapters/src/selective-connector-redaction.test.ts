import { afterEach, expect, it, vi } from "vitest";
import { McpConnector } from "./mcp-connector.js";
import { McpSession } from "./mcp-transport.js";

afterEach(() => vi.restoreAllMocks());
it("hides legacy launch credentials from the tool offered after a startup failure", async () => {
  const token = "FAKE-TOKEN-0000000000000000";
  vi.spyOn(McpSession.prototype, "connectStdio").mockRejectedValue(
    new Error(`invalid --api-key ${token}`),
  );
  vi.spyOn(McpSession.prototype, "close").mockResolvedValue(undefined);
  const server = {
    id: "server",
    slug: "mail",
    transport: "stdio",
    command: "mail-mcp",
    endpoint: null,
    secretId: null,
    args: ["--api-key", token],
    revision: 1,
  };
  const prisma = {
    mcpServer: { findMany: async () => [], findFirst: async () => null },
    botMcpServer: {
      findMany: async () => [
        {
          botId: "bot",
          serverId: "server",
          spaceId: "space",
          userId: "user",
          allowAllTools: true,
          allowedTools: [],
          server,
        },
      ],
    },
  };
  const connector = new McpConnector(prisma as never, {} as never, {
    stdioEnabled: true,
    allowedCommands: ["mail-mcp"],
  });
  try {
    const tools = await connector.discoverTools({
      spaceId: "space",
      userId: "user",
      botId: "bot",
      signal: new AbortController().signal,
    } as never);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.description).not.toContain(token);
    expect(tools[0]?.description).toContain("[redacted]");
  } finally {
    await connector.close();
  }
});
