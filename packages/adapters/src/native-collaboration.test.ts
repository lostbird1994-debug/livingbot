import type { AgentRunRequest } from "@livingbot/adapter-kit";
import { expect, it, vi } from "vitest";
import { nativeCollaboration } from "./native-collaboration.js";

it("keeps the credential-aware shell behind the original host gate without transferring credentials", async () => {
  const executeTool = vi.fn(async () => ({ code: 0, stdout: "redacted result" }));
  const onToolCompleted = vi.fn();
  const request = {
    tools: [
      { name: "shell", description: "Execute commands", inputSchema: { type: "object" } },
      { name: "read_file", description: "Read", inputSchema: { type: "object" } },
      { name: "attach_file", description: "Publish stable attachment", inputSchema: { type: "object" } },
    ], executeTool, onToolCompleted,
  } as unknown as AgentRunRequest;
  const grant = nativeCollaboration(request, () => {}, "kernel")!;
  expect(grant.tools.map(tool => tool.name)).toEqual(["rakazo_shell", "attach_file"]);
  expect(grant.nativeTools).toEqual(["exec", "process", "read", "grep"]);
  await grant.execute("rakazo_shell", { command: "a task" }, "execution");
  expect(executeTool).toHaveBeenCalledWith("shell", { command: "a task" }, "execution");
  await grant.completed?.({ name: "rakazo_shell", executionId: "execution", durationMs: 7 });
  expect(onToolCompleted).toHaveBeenCalledWith({ name: "shell", executionId: "execution", durationMs: 7 });
});

it("does not grant filesystem, process or cross-agent tools absent from the Bot's catalog", () => {
  const request = { tools: [
    { name: "read_memory", description: "Read private memory", inputSchema: { type: "object" } },
  ], executeTool: vi.fn() } as unknown as AgentRunRequest;
  expect(nativeCollaboration(request, () => {}, "kernel")!.nativeTools)
    .toEqual(["memory_search", "memory_get"]);
});

it("routes dynamic MCP and installed tools through a declared tool while preserving host authorization", async () => {
  const executeTool = vi.fn(async () => ({ synthetic: true }));
  const onToolCompleted = vi.fn();
  const request = { tools: [
    { name: "mcp__example__read", description: "Read one synthetic record", inputSchema: { type: "object" } },
    { name: "installed__example__lookup", description: "Lookup", inputSchema: { type: "object" } },
  ], executeTool, onToolCompleted } as unknown as AgentRunRequest;
  const grant = nativeCollaboration(request, () => {}, "kernel")!;
  expect(grant.tools.map(tool => tool.name)).toEqual(["rakazo_connected_tool"]);
  await grant.execute("rakazo_connected_tool", { name: "mcp__example__read", arguments: { id: "one" } }, "call");
  expect(executeTool).toHaveBeenCalledWith("mcp__example__read", { id: "one" }, "call");
  await grant.completed?.({ name: "rakazo_connected_tool", executionId: "call", durationMs: 3 });
  expect(onToolCompleted).toHaveBeenCalledWith({
    name: "mcp__example__read", executionId: "call", durationMs: 3,
  });
  expect(await grant.execute("rakazo_connected_tool", { name: "exec", arguments: {} }, "blocked"))
    .toHaveProperty("error");
  expect(executeTool).toHaveBeenCalledTimes(1);
});
