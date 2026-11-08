import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { CollaborationTool } from "./native-collaboration-broker.js";
import { NATIVE_COLLABORATION_TOOLS } from "./native-collaboration-broker.js";

export interface NativeCollaboration {
  tools: CollaborationTool[];
  execute: NonNullable<AgentRunRequest["executeTool"]>;
  completed: AgentRunRequest["onToolCompleted"];
  onPaused(): void;
}

export function nativeCollaboration(
  request: AgentRunRequest,
  emit: (event: AgentRuntimeEvent) => void,
): NativeCollaboration | undefined {
  if (!request.executeTool) return undefined;
  const tools = request.tools
    .filter((tool) => NATIVE_COLLABORATION_TOOLS.includes(tool.name as never))
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  if (!tools.length) return undefined;
  return {
    tools,
    execute: request.executeTool,
    completed: request.onToolCompleted,
    onPaused: () => emit({ type: "progress", text: "", activity: true }),
  };
}
