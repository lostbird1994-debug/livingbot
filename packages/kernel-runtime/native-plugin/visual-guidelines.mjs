import { readFile } from "node:fs/promises";

const modules = new Set(["diagram", "mockup", "interactive", "art", "chart"]);

// The existing module-selection protocol; guide resources remain optional and local.
export function visualModules(input) {
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      input = input.split(/[\s,]+/);
    }
  }
  if (!Array.isArray(input)) throw new Error("请选择 diagram、mockup、interactive、art 或 chart");
  const selected = [...new Set(input.map((item) => String(item).trim()).filter(Boolean))];
  if (selected.some((item) => !modules.has(item))) throw new Error("不支持这个可视化模块");
  return selected.sort();
}

export async function visualGuidelines(selected) {
  const keys = visualModules(selected);
  try {
    const resource = JSON.parse(
      await readFile(new URL("./resources/visual-guidelines.json", import.meta.url), "utf8"),
    );
    const content = resource.guidelines?.[keys.join(",")];
    if (typeof content === "string" && content.length <= 150_000)
      return `${content}\n\n${resource.adaptation ?? ""}`;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("可视化指南无法读取，请使用会话中可用的绘图方法");
  }
  return readFile(new URL("./skills/livingbot-diagrams/SKILL.md", import.meta.url), "utf8");
}

export function registerVisualGuidelines(api) {
  api.on("before_prompt_build", async () => ({
    appendSystemContext:
      "LivingBot 可视化选择：解释由多个步骤、分支或角色交接构成的流程时，优先主动给出简洁流程图；解释角色之间的消息往来时，优先用时序图。简单问题、用户要求纯文本或当前渠道无法渲染图表时，不要硬画。可用 Mermaid 时输出可渲染的 Mermaid 图，不要把代码块说成已生成的图片；需要创建复杂图表或交互组件前，先按需调用 widget_guidelines 读取对应规范。",
  }));
  api.registerTool(
    {
      name: "widget_guidelines",
      label: "可视化指南",
      description:
        "Read the full design, theme, layout and interaction guidance before creating inline diagrams or widgets. Choose diagram, mockup, interactive, chart or art, or combine them. Read-only; no files are changed and no execution authority is granted.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["modules"],
        properties: {
          modules: {
            anyOf: [
              { type: "array", items: { type: "string", enum: [...modules] } },
              { type: "string" },
            ],
          },
        },
      },
      async execute(_id, args) {
        const content = await visualGuidelines(args.modules);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                type: "visualizer_read_me_result",
                content,
              }),
            },
          ],
        };
      },
    },
    { name: "widget_guidelines", workspaceAccess: false },
  );
}
