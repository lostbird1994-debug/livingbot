import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { CollaborationTool } from "./native-collaboration-broker.js";
import {
  isNativeKernelExcludedTool, isNativeKernelHostTool, NATIVE_COLLABORATION_TOOLS,
} from "./native-collaboration-broker.js";

// Engine-level ceiling for managed Rakazo agents. The session grant below still
// narrows these to the tools actually enabled for this Bot and channel.
export const NATIVE_KERNEL_TOOL_ALLOWLIST = [
  "exec", "process", "read", "grep", "ls", "find", "write", "edit", "apply_patch",
  "web_search", "web_fetch", "memory_search", "memory_get", "rakazo-collaboration",
];

export interface NativeCollaboration {
  toolMode?: "kernel";
  nativeTools?: string[];
  privateContextAllowed?: boolean;
  tools: CollaborationTool[];
  execute: NonNullable<AgentRunRequest["executeTool"]>;
  completed: AgentRunRequest["onToolCompleted"];
  onPaused(): void;
}

export function nativeCollaboration(
  request: AgentRunRequest,
  emit: (event: AgentRuntimeEvent) => void,
  toolMode?: "kernel",
): NativeCollaboration | undefined {
  if (!request.executeTool) return undefined;
  const tools = request.tools
    .filter((tool) => toolMode === "kernel"
      ? isNativeKernelHostTool(tool.name) || tool.name === "shell"
      : NATIVE_COLLABORATION_TOOLS.includes(tool.name as never))
    .map(({ name, description, inputSchema }) => ({
      name: toolMode === "kernel" && name === "shell" ? "rakazo_shell" : name,
      description: toolMode === "kernel" && name === "shell"
        ? `Run a command with this Bot's managed credential environment and product computer permissions. Credentials are injected and redacted by Rakazo. Use native exec for ordinary local commands. ${description}`
        : description,
      inputSchema,
    }));
  const connected = toolMode === "kernel" ? request.tools.filter(tool =>
    !isNativeKernelHostTool(tool.name) && !isNativeKernelExcludedTool(tool.name)) : [];
  if (connected.length) tools.push({
    name: "rakazo_connected_tool",
    description: "Call one of this Bot's connected tools. Each call keeps its original Rakazo permissions, approval and connector route. Available names and argument schemas:\n" +
      JSON.stringify(connected.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))),
    inputSchema: {
      type: "object", properties: {
        name: { type: "string", enum: connected.map(tool => tool.name) },
        arguments: { type: "object", additionalProperties: true },
      }, required: ["name", "arguments"], additionalProperties: false,
    },
  });
  if (!tools.length && toolMode !== "kernel") return undefined;
  const offered = new Set(request.tools.map(tool => tool.name));
  const nativeTools = [
    ...(offered.has("shell") ? ["exec", "process"] : []),
    ...(offered.has("read_file") ? ["read", "grep"] : []),
    ...(offered.has("list_files") ? ["ls", "find"] : []),
    ...(offered.has("write_file") ? ["write", "edit", "apply_patch"] : []),
    ...(offered.has("web_search") ? ["web_search"] : []),
    ...(offered.has("web_fetch") ? ["web_fetch"] : []),
    ...(request.privateContextAllowed !== false &&
      (offered.has("read_memory") || offered.has("search_memory")) ? ["memory_search", "memory_get"] : []),
  ];
  const executedNames = new Map<string, string>();
  return {
    ...(toolMode ? { toolMode, nativeTools, privateContextAllowed: request.privateContextAllowed !== false } : {}),
    tools,
    execute: (name, args, executionId, ...rest) => {
      const actualName = toolMode === "kernel" && name === "rakazo_shell" ? "shell" : name;
      if (toolMode === "kernel" && name === "rakazo_connected_tool") {
        if (typeof args.name !== "string" || !connected.some(tool => tool.name === args.name) ||
          !args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments))
          return Promise.resolve({ error: "Connected tool is unavailable in this Bot's active run." });
        executedNames.set(executionId, args.name);
        return request.executeTool!(args.name, args.arguments as Record<string, unknown>, executionId, ...rest);
      }
      executedNames.set(executionId, actualName);
      return request.executeTool!(actualName, args, executionId, ...rest);
    },
    completed: request.onToolCompleted ? completion => request.onToolCompleted!({
      ...completion, name: executedNames.get(completion.executionId) ??
        (toolMode === "kernel" && completion.name === "rakazo_shell" ? "shell" : completion.name),
    }) : undefined,
    onPaused: () => emit({ type: "progress", text: "", activity: true }),
  };
}
