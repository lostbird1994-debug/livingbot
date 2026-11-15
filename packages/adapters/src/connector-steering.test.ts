import type { AdapterContext } from "@livingbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { InstalledConnectorProvider } from "./installed-connectors.js";
import { claimRunSteering } from "./run-turn-images.js";

describe("connectors selected in a mid-run message", () => {
  it.each(["user", "member"] as const)(
    "loads the selected CLI skill by name only for %s steering",
    async (origin) => {
      const prisma = {
        agentSkill: { findMany: vi.fn().mockResolvedValue([{ id: "cli-1", name: "Files CLI" }]) },
        message: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      const context = {
        operationId: "run-1",
        traceId: "trace-1",
        runId: "run-1",
        botId: "bot-1",
        userId: "user-1",
        spaceId: "space-1",
        signal: new AbortController().signal,
        connectorScope: [] as string[],
      };
      const messages = await claimRunSteering(
        {
          prisma,
          events: {
            claimSteering: async () => [
              {
                id: "steer-1",
                messageId: "message-1",
                text: "Continue",
                blocks: [],
                origin,
                connectorScope: ["cli-1"],
              },
            ],
          },
        } as never,
        {
          runId: "run-1",
          threadId: "thread-1",
          botId: "bot-1",
          leaseOwner: "worker-1",
          leaseFence: 1,
        },
        [],
        context,
        [],
        { hasImages: false },
      );
      if (origin === "member") {
        expect(context.connectorScope).toEqual([]);
        expect(prisma.agentSkill.findMany).not.toHaveBeenCalled();
        expect(messages[0]?.text).toBe("Continue");
        return;
      }
      expect(context.connectorScope).toEqual(["cli-1"]);
      expect(messages[0]?.text).toContain('["Files CLI"]');
      expect(messages[0]?.text).toContain("skill_read");
      expect(messages[0]?.text).not.toContain("installed_search_tools");
      expect(prisma.agentSkill.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { in: ["cli-1"] }, userId: "user-1" }),
        }),
      );
    },
  );

  it.each(["user", "member", "webhook"] as const)(
    "discovers authorized sources without requiring selection for %s steering",
    async (origin) => {
      const install = {
        id: "files-api",
        name: "Files",
        kind: "api",
        source: "https://files.example.test",
        secretId: null,
        config: {
          auth: { type: "none" },
          operations: [
            {
              id: "upload",
              method: "POST",
              path: "/files",
              inputSchema: { type: "object" },
            },
          ],
        },
      };
      const prisma = {
        capabilityInstall: { findMany: vi.fn().mockResolvedValue([install]) },
        agentSkill: { findMany: vi.fn().mockResolvedValue([]) },
        message: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      const context = {
        operationId: "run-1",
        traceId: "trace-1",
        runId: "run-1",
        botId: "bot-1",
        userId: "user-1",
        spaceId: "space-1",
        signal: new AbortController().signal,
        connectorScope: [] as string[],
      };
      const provider = new InstalledConnectorProvider(prisma as never, {} as never);
      // These are the tools fixed at the beginning of the model run.
      const initialTools = await provider.discoverTools(context as AdapterContext);
      const search = initialTools.find((tool) => tool.name === "installed_search_tools")!;
      const execute = initialTools.find((tool) => tool.name === "installed_execute_tool")!;
      const call = {
        tool: execute.name,
        executionId: "upload-1",
        route: execute.route,
        args: { id: "files-api:upload", arguments: {} },
      };
      await expect(provider.resolveCall(call, context as AdapterContext)).resolves.toMatchObject({
        tool: { name: "upload" },
      });

      const messages = await claimRunSteering(
        {
          prisma,
          events: {
            claimSteering: async () => [
              {
                id: "steer-1",
                messageId: "message-1",
                text: "Use the selected connection",
                blocks: [{ kind: "text", text: "Use the selected connection" }],
                connectorScope: [install.id],
                origin,
              },
            ],
          },
        } as never,
        {
          runId: "run-1",
          threadId: "thread-1",
          botId: "bot-1",
          leaseOwner: "worker-1",
          leaseFence: 1,
        },
        [],
        context,
        [],
        { hasImages: false },
      );

      expect(messages[0]?.text.startsWith("Use the selected connection")).toBe(true);
      expect(context.connectorScope).toEqual(origin === "user" ? [install.id] : []);
      const results = [];
      for await (const event of provider.execute(
        {
          tool: search.name,
          route: search.route,
          args: { query: "upload" },
          executionId: "search-1",
        },
        context as AdapterContext,
      ))
        results.push(event);
      expect(results).toMatchObject([
        { type: "result", data: { tools: [{ id: "files-api:upload" }] } },
      ]);
      await expect(provider.resolveCall(call, context as AdapterContext)).resolves.toMatchObject({
        call: { tool: "upload", route: { resourceId: "files-api" } },
        tool: { readOnly: false },
      });
      expect(prisma.capabilityInstall.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: "user-1" }),
        }),
      );
    },
  );
});
