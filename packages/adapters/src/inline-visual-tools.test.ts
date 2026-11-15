import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { BUILTIN_TOOL_NAMES, parseInlineVisual } from "@livingbot/contracts";
import { toolRequiresApproval, toolResultTaintsRun } from "@livingbot/core";
import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { inlineVisualTools, prepareInlineVisual } from "./inline-visual-tools.js";
import { nativeCollaboration } from "./native-collaboration.js";
import { parametersFor } from "./pi-runtime-tool-parameters.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";

const diagram = {
  version: 1,
  kind: "diagram",
  title: "Question",
  description: "A simple explanation",
  canvas: { height: 100, elements: [{ type: "text", x: 24, y: 40, text: "Answer" }] },
};

describe("inline visual tools", () => {
  it("offers the same validated tool schema to model and native runtimes", () => {
    const tool = builtinAgentTools.find((item) => item.name === "show_visual")!;
    const piTool = {
      name: tool.name,
      description: tool.description,
      parameters: parametersFor(tool),
    };
    const args = validateToolArguments(
      piTool as never,
      { type: "toolCall", id: "visual-1", name: tool.name, arguments: diagram } as never,
    );
    const result = prepareInlineVisual(args);
    expect(result).not.toHaveProperty("error");
    if (typeof result.markdown !== "string") throw new Error("Missing visual fence");
    expect(parseInlineVisual(result.markdown.split("\n")[1]!)).toEqual(diagram);
    const native = nativeCollaboration(
      { tools: [tool], executeTool: async () => result } as never,
      () => {},
    );
    expect(native?.tools.find((item) => item.name === "show_visual")?.inputSchema).toEqual(
      tool.inputSchema,
    );
  });

  it("needs no computer, credentials or durable state", async () => {
    const result = await inlineVisualTools.show_visual!(
      { source: {} } as never,
      { args: diagram } as never,
    );
    expect(result).toHaveProperty("markdown");
    for (const name of ["show_visual", "visual_guidelines"]) {
      expect(BUILTIN_TOOL_NAMES).toContain(name);
      expect(toolRequiresApproval(name, false)).toBe(false);
      expect(toolResultTaintsRun(name)).toBe(false);
    }
  });

  it("refuses a stale native visual call on an unsupported channel", async () => {
    await expect(
      inlineVisualTools.show_visual!(
        { source: { messagingChannelRun: true } } as never,
        { args: diagram } as never,
      ),
    ).resolves.toHaveProperty("error");
  });

  it("returns repairable errors and keeps results within the runtime tool budget", () => {
    expect(
      prepareInlineVisual({
        ...diagram,
        canvas: { ...diagram.canvas, elements: [{ type: "script" }] },
      }),
    ).toHaveProperty("error");
    const canvas = {
      height: 100,
      elements: Array.from({ length: 80 }, () => ({
        type: "text",
        x: 24,
        y: 40,
        text: "x".repeat(100),
      })),
    };
    expect(prepareInlineVisual({ ...diagram, canvas })).toHaveProperty("error");
  });

  it("withholds app-only visuals on voice and messaging channels", () => {
    const base = {
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
    };
    expect(selectBuiltinToolsForRun(base).some((tool) => tool.name === "show_widget")).toBe(true);
    expect(selectBuiltinToolsForRun(base).some((tool) => tool.name === "show_visual")).toBe(false);
    expect(
      selectBuiltinToolsForRun({ ...base, disabledBuiltinTools: ["show_widget"] }).some(
        (tool) => tool.name === "show_visual",
      ),
    ).toBe(true);
    expect(
      selectBuiltinToolsForRun({ ...base, messagingChannelRun: true }).some(
        (tool) => tool.name === "show_visual",
      ),
    ).toBe(false);
    expect(
      selectBuiltinToolsForRun({ ...base, voiceCall: true }).some(
        (tool) => tool.name === "show_visual",
      ),
    ).toBe(false);
    expect(
      selectBuiltinToolsForRun({ ...base, disabledBuiltinTools: ["show_visual"] }).some(
        (tool) => tool.name === "show_visual",
      ),
    ).toBe(false);
  });
});
