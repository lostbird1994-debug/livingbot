import type { AgentToolExecutionObserver } from "@rakazo/adapter-kit";
import { MEMORY_MAINTENANCE_TOOL_NAMES } from "@rakazo/contracts";
import { toolResultTaintsRun } from "@rakazo/core";
import { IMAGE_RETURNING_COMPUTER_TOOLS, MODEL_CANNOT_SEE_MESSAGE } from "./model-vision.js";
import type { RunContext } from "./run-context.js";
import type { ToolHandler } from "./run-tool-gate.js";
import { auditToolCall, gateToolCall } from "./run-tool-gate.js";
import { prepareToolRequest, resolveToolRequest } from "./run-tool-request.js";
import { PAGE_BROWSER_TOOL_NAMES } from "./run-tool-selection.js";
import { computerTools, pageBrowserTool } from "./run-tools-computer.js";
import { fileTools } from "./run-tools-files.js";
import { fleetTools } from "./run-tools-fleet.js";
import { cloudAgentTool, connectorTool, integrationTools } from "./run-tools-integrations.js";
import { memoryTools } from "./run-tools-memory.js";
import { messagingTools } from "./run-tools-messaging.js";
import { preferenceTools } from "./run-tools-preferences.js";
import { purchaseTools } from "./run-tools-purchases.js";
import { secretTools } from "./run-tools-secrets.js";
import { taskTools } from "./run-tools-tasks.js";
import {
  USER_COMPUTER_ACT_TOOL,
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_SHELL_TOOL,
  userComputerAct,
  userComputerObserve,
  userComputerShell,
} from "./run-tools-user-computer.js";
import { argumentGiven } from "./update-bot-patch.js";

const TOOL_HANDLERS = new Map<string, ToolHandler>([
  ...Object.entries(computerTools),
  ...Object.entries(fileTools),
  ...Object.entries(memoryTools),
  ...Object.entries(integrationTools),
  ...Object.entries(taskTools),
  ...Object.entries(messagingTools),
  ...Object.entries(secretTools),
  ...Object.entries(fleetTools),
  [USER_COMPUTER_SHELL_TOOL, userComputerShell],
  [USER_COMPUTER_OBSERVE_TOOL, userComputerObserve],
  [USER_COMPUTER_ACT_TOOL, userComputerAct],
  ...Object.entries(purchaseTools),
  ...Object.entries(preferenceTools),
  ...[...PAGE_BROWSER_TOOL_NAMES].map((name) => [name, pageBrowserTool] as const),
]);

function toolHandler(name: string): ToolHandler {
  return (
    TOOL_HANDLERS.get(name) ?? (name.startsWith("cloud_agent_") ? cloudAgentTool : connectorTool)
  );
}

/** Run one tool call of this run's model: gate it, then hand it to its tool family. */
export async function applyTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  _route?: unknown,
  observer?: AgentToolExecutionObserver,
) {
  try {
    if (ctx.deps.botWorkspace && name === "update_bot") {
      const target = typeof args.bot_id === "string" && args.bot_id ? args.bot_id : ctx.bot.id;
      return await ctx.deps.botWorkspace.edit(
        { spaceId: ctx.run.spaceId, userId: ctx.run.userId }, target,
        () => dispatchTool(ctx, name, args, executionId, observer),
      );
    }
    return await dispatchTool(ctx, name, args, executionId, observer);
  } finally {
    // Editing its own profile returns only what this run wrote; a child's profile is another bot's.
    const ownProfile = name === "update_bot" && !argumentGiven(args.bot_id);
    if (toolResultTaintsRun(name) && !ownProfile) ctx.state.tainted = true;
  }
}

async function dispatchTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  observer: AgentToolExecutionObserver | undefined,
) {
  ctx.context.signal.throwIfAborted();
  if (ctx.source.memoryMaintenance && !MEMORY_MAINTENANCE_TOOL_NAMES.has(name)) {
    return { error: "Memory maintenance may only read memory and save review proposals." };
  }
  if (ctx.state.handedOff) {
    return {
      error: "This stage was handed off. End the turn without more tool calls.",
    };
  }
  if (ctx.tools.disabled.has(name)) {
    return { error: "This tool is disabled for this bot." };
  }
  if (PAGE_BROWSER_TOOL_NAMES.has(name) && !ctx.computer.pageBrowserAllowed) {
    return { error: "Page browser is unavailable on this computer." };
  }
  if (IMAGE_RETURNING_COMPUTER_TOOLS.has(name) && !ctx.computer.acceptsImages) {
    return { error: MODEL_CANNOT_SEE_MESSAGE };
  }
  const request = await resolveToolRequest(ctx, name, args, executionId);
  if ("error" in request) return request;
  const refused = await prepareToolRequest(ctx, request);
  if (refused) return refused;
  const gate = await gateToolCall(ctx, request, observer);
  if ("result" in gate) return gate.result;
  // Product effects and commands acquire the same computer/workspace resource as legacy runs.
  // Reads remain eligible for concurrency; unknown connector effects are conservative.
  const concurrentReads = new Set(["read_file", "list_files", "ask_user", "read_history", "search_history", "read_memory", "search_memory",
    "recall_memory", "list_fleet", "task_catalog", "schedule_list", "scratchpad_list", "board_tickets", "ticket_get",
    "skill_read", "web_search", "web_fetch", "list_secrets", "cloud_agent_status", "purchase_status"]);
  if (!concurrentReads.has(gate.call.name)) {
    await ctx.computer.requireResource?.();
    // A late acquisition updates the context token; preserve its exact fence for pause/cleanup.
    if (ctx.thread.taskBotId) ctx.computer.lease = await ctx.deps.prisma.computerExecutionLease.findFirst({
      where: { runId: ctx.runId, botId: ctx.bot.id, computerId: ctx.computer.stored.id },
    });
  }
  if (!gate.call.applied) return toolHandler(gate.call.name)(ctx, gate.call);
  let outcome: "success" | "failure" = "failure";
  try {
    const result = await toolHandler(gate.call.name)(ctx, gate.call);
    if (!isToolError(result)) outcome = "success";
    return result;
  } finally {
    await auditToolCall(ctx, gate.call.name, outcome, {
      effectId: gate.call.applied.effect.id,
      autoApproved: gate.call.bypassApproval,
    });
  }
}

function isToolError(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
}
