import type { ConnectorTool } from "@livingbot/adapter-kit";
import { InlineVisualSchema, inlineVisualMarkdown, WidgetVisualSchema } from "@livingbot/contracts";
import { z } from "zod";
import { appendInlineVisual } from "./run-progress.js";
import type { ToolHandlers } from "./run-tool-gate.js";
import type { WidgetModule } from "./widget-guidelines.js";
import { WIDGET_MODULES, widgetGuidelines } from "./widget-guidelines.js";

export const VISUAL_GUIDE_VERSION = "2";
const moduleSchema = z
  .object({ module: z.enum(["diagram", "comparison", "steps", "table", "chart"]) })
  .strict();

const common = `LivingBot inline visuals, guide v${VISUAL_GUIDE_VERSION}.
Plan the explanation before drawing. For a teaching question, choose the visual that makes the mechanism understandable: a sequence for exchanges, a decision tree for choices, containment for structure, or steps for changing state. For a question with several distinct parts, make separate focused visuals and place each next to the paragraph explaining it. Do not force the whole answer into one overview. For example, a system walkthrough followed by a choice of approaches may need a sequence, comparison cards and a decision tree. This is a pattern, not a required number of diagrams. Simple facts and short answers need only prose. Respect requests for plain text, spoken replies, or files.
Use show_visual for custom diagrams, comparison cards and step explanations; Mermaid is an alternative for standard graph notation, and render_plot handles numerical charts. Use Markdown tables when readers need aligned values across several options; use comparison cards for a few approaches whose tradeoffs need more room. State the result first, then alternate short prose and relevant visuals. Never invent measurements, privacy guarantees, causal links or missing facts to fill a visual. Mark hypothetical examples as examples. A visual does not verify its content.
Colors are available for meaning, not only status. Keep each role's color consistent across diagrams. Prefer two or three color families per visual. Named blue/teal/purple/coral/amber/rose paints adapt to light and dark appearance; use Fill, Stroke and Text suffixes, such as blueFill, blueStroke, blueText. You may choose any other RGB color by supplying {light:"#RRGGBB",dark:"#RRGGBB"} for a paint, with readable contrast in both modes. Keep ordinary explanatory paragraphs outside the visual. The client supplies typography and page background. Do not provide URLs, HTML, SVG markup, CSS, scripts or actions. Visuals cannot access files, make requests or change app state.
show_visual returns a validated livingbot-visual Markdown fence. Include that returned fence exactly in your reply where the visual belongs; it is not published separately. Do not describe the internal guide loading or show the JSON as an extra code example. If tools are disabled, use Markdown tables and Mermaid instead.`;

const canvas = `Canvas format: {height:80..1200,elements:[...]}, fixed width 680. Coordinates are nonnegative numbers, maximum 1200. Keep shapes inside x=24..656 and y=24..height-24. Use at most 80 elements, few nodes and short labels. Split long text into separate text elements; choose a vertical flow when horizontal labels would crowd. Use text sizes 18..22 normally (minimum14), generous whitespace and consistent box dimensions.
Elements: rect {x,y,width,height}, ellipse {cx,cy,rx,ry}, text {x,y,text,size?,align?:start|middle|end}, line {x,y,toX,toY,arrow?}, path {d}. All elements require type. Each fill/stroke accepts a semantic paint (foreground,mutedForeground,card,muted,border,success,warning,destructive,none), a named color paint (blueFill/blueStroke/blueText, similarly teal,purple,coral,amber,rose), or an explicit light/dark RGB pair. Use the matching Text paint for labels on a colored Fill. Paths accept only SVG path commands and numeric coordinates. No markup or arbitrary attributes.
Example canvas: {"height":160,"elements":[{"type":"rect","x":24,"y":40,"width":240,"height":72},{"type":"text","x":144,"y":76,"text":"Request","align":"middle"},{"type":"line","x":280,"y":76,"toX":390,"toY":76,"arrow":true},{"type":"rect","x":410,"y":40,"width":240,"height":72},{"type":"text","x":530,"y":76,"text":"Response","align":"middle"}]}`;

const guides = {
  diagram: `${canvas}\nCall show_visual with {version:1,kind:"diagram",title,description,canvas}. Title and description describe the visual for accessibility.
Choose a layout from the meaning:
- Sequence: place 2..4 participant boxes across the top; draw a vertical lifeline under each. Stack labeled horizontal request and response arrows in chronological order. Keep arrow labels above the line and short; add a small processing box on a lifeline for local work. Do not replace a back-and-forth exchange with a one-way chain of role boxes.
- Decision: put one short question above labeled branches. Use 2..3 outcome boxes, clear Yes/No or condition labels, and arrows from the condition to the recommendation. Include only criteria supported by the question.
- Structure: use nested boxes for containment and labeled connectors for dependencies. Keep each role the same color across the answer.
- Process: use aligned boxes with consistent heights and 24px internal padding; leave about 48px for connectors and labels. Split diagrams with more than 5 main nodes instead of shrinking text.
Mermaid remains useful for graph notation or ER diagrams; provide accTitle and avoid custom theme directives.`,
  comparison: `Call show_visual with {version:1,kind:"comparison",title,description,columns:[{title,subtitle?,tone?,items:[{label,text},...]}]}. Use 2..4 columns and 1..8 concise items per column. tone may be blue,teal,purple,coral,amber,rose. Use the same labels in each column so readers can compare matching tradeoffs. These are real responsive cards: side by side when space allows, stacked on a phone. Leave the recommendation and longer explanation in normal prose. Use a Markdown table instead when aligned numerical values are the important part.`,
  steps: `${canvas}\nFor explaining changing state or successive stages, call show_visual with {version:1,kind:"steps",title,description,steps:[{title,text,canvas},...]}. Provide 2..6 steps. Each step needs a short title, plain explanation and complete canvas. Keep the same positions for objects that persist across steps. Users choose a step in a local control; this never sends a message or calls a tool. Keep total JSON below 9,000 characters.`,
  table:
    "Write tables directly in response Markdown: one header, separator row and one row per option. Keep 2..5 useful columns. Use concise cells, consistent units, and explicit unknowns. Put your recommendation and its reason in prose. The client handles scrolling, sorting, copying, expansion and CSV export; do not draw a table on a canvas.",
  chart:
    "Use the existing render_plot tool for numerical data; call it with {help:true} for its validated chart guide. Use actual supplied or sourced data, label units and distinguish forecasts. Never replace a numerical chart with decorative hand-positioned bars. If render_plot is unavailable, provide a Markdown data table.",
};

export function visualGuidelines(module: keyof typeof guides) {
  return `${common}\n\n${guides[module]}`;
}

export function prepareInlineVisual(args: unknown) {
  const parsed = InlineVisualSchema.safeParse(args);
  if (!parsed.success)
    return {
      error: "Invalid visual specification.",
      issues: parsed.error.issues.slice(0, 6).map(({ path, message }) => ({ path, message })),
    };
  const markdown = inlineVisualMarkdown(parsed.data);
  if (markdown.length > 10_000)
    return {
      error:
        "Visual is too large. Simplify it to fewer elements or steps (maximum 10,000 characters).",
    };
  return {
    version: VISUAL_GUIDE_VERSION,
    markdown,
    delivery:
      "Include this fence exactly in your reply, between explanatory paragraphs. It has not been published separately.",
  };
}

export const inlineVisualToolDefinitions: ConnectorTool[] = [
  {
    name: "widget_guidelines",
    readOnly: true,
    description:
      "Load required design context before show_widget. Choose diagram, mockup, interactive, chart or art; combine modules for mixed content. Internal setup; do not narrate it.",
    inputSchema: z.toJSONSchema(
      z
        .object({
          modules: z.union([z.array(z.enum(WIDGET_MODULES)).min(1).max(5), z.string().max(200)]),
        })
        .strict(),
    ),
  },
  {
    name: "show_widget",
    readOnly: true,
    description:
      "Show a raw SVG or interactive HTML/JavaScript fragment inline immediately. Read widget_guidelines first. Use separate calls with connecting prose for distinct ideas. Do not repeat code or a fence in the final answer.",
    inputSchema: z.toJSONSchema(
      z
        .object({
          title: z.string().min(1).max(100),
          widget_code: z.string().min(1).max(64_000),
          loading_messages: z.union([
            z.array(z.string().min(1).max(100)).min(1).max(4),
            z.string().max(500),
          ]),
        })
        .strict(),
    ),
  },
  {
    name: "visual_guidelines",
    readOnly: true,
    description:
      "Read the design and layout guide before an inline visual. Choose diagram, comparison, steps, table or chart. Internal setup; do not narrate this call.",
    inputSchema: z.toJSONSchema(moduleSchema),
  },
  {
    name: "show_visual",
    readOnly: true,
    description:
      "Prepare an inline diagram, responsive comparison cards or interactive step explainer. Read visual_guidelines first. Use separate calls for distinct ideas, placing each returned Markdown fence near its explanation; no file, network or computer needed.",
    inputSchema: z.toJSONSchema(InlineVisualSchema),
  },
];

export const inlineVisualTools: ToolHandlers = {
  async widget_guidelines(_ctx, call) {
    let selected = call.args.modules;
    if (typeof selected === "string") {
      const text = selected;
      try {
        selected = JSON.parse(text);
      } catch {
        selected = text.split(",").map((part) => part.trim());
      }
    }
    if (
      !Array.isArray(selected) ||
      selected.length === 0 ||
      selected.length > 5 ||
      selected.some((module) => !WIDGET_MODULES.includes(module))
    )
      return { error: "Choose one or more of diagram, mockup, interactive, chart, art." };
    return { version: "1", guide: widgetGuidelines(selected as WidgetModule[]) };
  },
  async show_widget(ctx, call) {
    if (ctx.source.messagingChannelRun || ctx.source.voiceCall)
      return { error: "This channel requires a prose reply." };
    let messages = call.args.loading_messages;
    if (typeof messages === "string") {
      try {
        messages = JSON.parse(messages);
      } catch {
        messages = [messages];
      }
    }
    const code = typeof call.args.widget_code === "string" ? call.args.widget_code : "";
    const parsed = WidgetVisualSchema.safeParse({
      version: 1,
      kind: "widget",
      title: call.args.title,
      description: call.args.title,
      code,
      format: code.trim().startsWith("<svg") ? "svg" : "html",
      loadingMessages: messages,
    });
    if (!parsed.success)
      return {
        error: "Invalid widget.",
        issues: parsed.error.issues.slice(0, 6).map(({ path, message }) => ({ path, message })),
      };
    const markdown = inlineVisualMarkdown(parsed.data);
    if (markdown.length > 96_000)
      return { error: "Widget source is too large after encoding. Split it into smaller widgets." };
    await appendInlineVisual(ctx, markdown);
    return {
      shown: true,
      title: parsed.data.title,
      delivery:
        "Already inserted into your reply. Continue the explanation without repeating code, fence or a file link.",
    };
  },
  async visual_guidelines(_ctx, call) {
    const parsed = moduleSchema.safeParse(call.args);
    return parsed.success
      ? { version: VISUAL_GUIDE_VERSION, guide: visualGuidelines(parsed.data.module) }
      : { error: "Choose diagram, comparison, steps, table or chart." };
  },
  async show_visual(ctx, call) {
    if (ctx.source.messagingChannelRun || ctx.source.voiceCall)
      return { error: "This channel needs a prose explanation instead of an inline visual." };
    return prepareInlineVisual(call.args);
  },
};

export const RESPONSE_PRESENTATION_INSTRUCTION = `Choose a helpful presentation proactively. Teaching and system explanations should normally include a visual that explains the mechanism. For several distinct questions, plan separate focused visuals: exchanges as a sequence, choices as a decision tree, tradeoffs as comparison cards or a table. Place each visual beside its short explanation instead of putting one overview at the start and leaving the rest as a wall of text. Read the relevant visual_guidelines module before drawing; use show_visual and insert each returned fence exactly into the reply. Use consistent, readable colors to distinguish roles and concepts. Use steps for changing state and render_plot for actual numerical data. Simple questions need only prose; respect the user's requested format and use prose for messaging or voice. Use Markdown/Mermaid if visual tools are unavailable. Never invent facts to complete a visual; keep the conclusion understandable in prose.`;
export const MESSAGING_PRESENTATION_INSTRUCTION =
  "Use concise prose and compact lists in messaging channels; keep the answer understandable without app-only visuals.";

export const WIDGET_PRESENTATION_INSTRUCTION = `Use inline visuals proactively when they help people understand. Teaching/explanation requests should include a suitable diagram, illustration or local interactive example, except for a simple word definition or an explicit plain-text request. Architecture and system questions benefit from relationships or exchanges drawn clearly; data comparisons may need a chart. A specification naming a visual, such as a comparison card, form mockup or timeline, asks to see it even without a drawing verb. Respect file/artifact requests and use a connected tool when that better fits the task.
Load widget_guidelines for all relevant modules: diagram, mockup, interactive, chart or art. Then show_widget can render unrestricted SVG shapes or local HTML/CSS/JavaScript controls, calculations and charts in an isolated frame. For multi-part explanations, use separate focused widgets and ordinary connecting prose between calls, not a single dense overview or several widgets without explanation. The tool inserts each visual directly into the reply; do not echo its code, fence, internal setup, or invent a download/file location. Keep conclusions readable in normal prose, avoid unsupported factual claims, use theme-readable colors and stable role colors. Ordinary tables remain Markdown. Simple answers need no visual. Messaging and voice need self-contained prose.`;
