import { ChatMarkdown } from "@livingbot/chat-ui/web";
import { I18nProvider } from "@lingui/react";
import { InlineVisualSchema, inlineVisualMarkdown } from "@livingbot/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles.css";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { queryClient } from "../../src/lib/query";
import { BOT, FixtureTranscript } from "./thread-fixture";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = theme;
document.documentElement.style.colorScheme = theme;

const flowchart = [
  "Here is the contribution flow:",
  "",
  "```mermaid",
  "graph LR",
  "  A[Clone repo] --> B[Branch] --> C[Tests] --> D[Pull request]",
  "```",
  "",
  "Each step runs in CI.",
].join("\n");

const sequence = [
  "```mermaid",
  "sequenceDiagram",
  "  accTitle: Approval round trip",
  "  participant U as User",
  "  participant B as Bot",
  "  U->>B: Book the flight",
  "  B-->>U: Needs approval",
  "  U->>B: Approve",
  "  Note over B: Books and reports back",
  "```",
].join("\n");

const invalid = [
  "```mermaid",
  "graph LR",
  "  A[Unclosed --> B",
  "```",
  "",
  "```ts",
  "const ok = true;",
  "```",
].join("\n");

const plain = "No diagram here, only `code` and a fence:\n\n```ts\nconst ok = true;\n```";

const wide = [
  "```mermaid",
  "graph LR",
  "  A[Collect requirements] --> B[Write the spec] --> C[Review the spec] --> D[Build it]",
  "  D --> E[Test it] --> F[Ship it] --> G[Watch the metrics]",
  "```",
].join("\n");

const explanation = inlineVisualMarkdown(
  InlineVisualSchema.parse({
    version: 1,
    kind: "steps",
    title: "How a request becomes a reply",
    description: "The browser sends a request; the service responds.",
    steps: ["Send the question", "Return the answer"].map((title, index) => ({
      title,
      text:
        index === 0
          ? "The browser collects the question and sends it to the service."
          : "The service checks the request and returns the answer to the browser.",
      canvas: {
        height: 220,
        elements: [
          {
            type: "rect",
            x: 24,
            y: 55,
            width: 240,
            height: 100,
            fill: "blueFill",
            stroke: "blueStroke",
          },
          {
            type: "text",
            x: 144,
            y: 105,
            text: "Browser",
            align: "middle",
            size: 22,
            fill: "blueText",
          },
          {
            type: "rect",
            x: 416,
            y: 55,
            width: 240,
            height: 100,
            fill: "tealFill",
            stroke: "tealStroke",
          },
          {
            type: "text",
            x: 536,
            y: 105,
            text: "Service",
            align: "middle",
            size: 22,
            fill: "tealText",
          },
          {
            type: "line",
            x: index === 0 ? 280 : 400,
            y: 105,
            toX: index === 0 ? 400 : 280,
            toY: 105,
            arrow: true,
          },
          {
            type: "text",
            x: 340,
            y: 75,
            text: index === 0 ? "Question" : "Answer",
            align: "middle",
          },
        ],
      },
    })),
  }),
);
const widget = inlineVisualMarkdown(
  InlineVisualSchema.parse({
    version: 1,
    kind: "widget",
    title: "Widget demo",
    description: "An interactive local calculation",
    format: "html",
    loadingMessages: ["Preparing the controls"],
    code: `<style>.controls{display:flex;gap:16px;flex-wrap:wrap}.panel{border:1px solid var(--color-border-secondary);padding:16px;border-radius:12px}</style>
<section class="panel"><h2>A local calculation</h2><div class="controls"><label>Quantity <input id="quantity" type="range" min="1" max="20" value="2"></label><output id="total">6</output><button id="increment">Increment</button><output id="count">0</output><button id="followup">Explain the next stage ↗</button></div><canvas id="plot" width="240" height="80" role="img" aria-label="A blue data bar">Value: 6</canvas><output id="isolation"></output></section>
<script>let count=0;document.getElementById('increment').onclick=()=>{document.getElementById('count').textContent=String(++count)};document.getElementById('quantity').oninput=e=>{document.getElementById('total').textContent=String(Number(e.target.value)*3)};document.getElementById('followup').onclick=()=>sendPrompt('Explain the next stage');let isolated=true;try{void parent.document.body;isolated=false}catch{};try{void window['local'+'Storage'];isolated=false}catch{};document.getElementById('isolation').textContent=isolated?'Isolated':'Not isolated';const context=document.getElementById('plot').getContext('2d');context.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--blueStroke');context.fillRect(0,10,180,40);sendPrompt('This must not enter the composer automatically');</script>`,
  }),
);
const cases: Record<string, string> = {
  flowchart,
  sequence,
  invalid,
  plain,
  wide,
  explanation,
  widget,
};
const initialMarkdown = cases[params.get("case") ?? "flowchart"] ?? flowchart;
const comparison = inlineVisualMarkdown(
  InlineVisualSchema.parse({
    version: 1,
    kind: "comparison",
    title: "Two ways to keep a session",
    description: "Where the state lives",
    columns: [
      {
        title: "Server session",
        subtitle: "Keep the record on the service",
        tone: "blue",
        items: [
          { label: "Browser keeps", text: "A random session identifier" },
          { label: "Sign out", text: "Invalidate the server record" },
        ],
      },
      {
        title: "Signed token",
        subtitle: "Carry a signed claim",
        tone: "teal",
        items: [
          { label: "Browser keeps", text: "A token with claims and an expiry" },
          { label: "Sign out", text: "Plan expiry and revocation explicitly" },
        ],
      },
    ],
  }),
);
const response = `A login checks your identity once; later requests carry a credential.\n\n${explanation}\n\nThe browser and service exchange a request and a response. Where the credential points determines how session state is managed.\n\n${comparison}\n\nThe suitable choice depends on the application and its revocation requirements.`;

function Fixture() {
  const [message, setMessage] = useState({
    markdown: initialMarkdown,
    streaming: params.has("stream"),
  });

  useEffect(() => {
    const update = (event: Event) => {
      setMessage((event as CustomEvent<{ markdown: string; streaming: boolean }>).detail);
    };
    window.addEventListener("rk-diagram-stream-update", update);
    return () => window.removeEventListener("rk-diagram-stream-update", update);
  }, []);

  if (params.get("case") === "response")
    return (
      <FixtureTranscript
        running={false}
        showToolActivity
        messages={[
          {
            id: "question",
            threadId: "thread-1",
            seq: 1,
            role: "user",
            createdAt: "2026-08-16T00:00:00.000Z",
            blocks: [
              { kind: "text", text: "Explain a login and compare two ways to keep the session." },
            ],
          },
          {
            id: "response",
            threadId: "thread-1",
            botId: BOT.botId,
            seq: 2,
            role: "bot",
            createdAt: "2026-08-16T00:00:01.000Z",
            blocks: [{ kind: "text", text: response }],
          },
        ]}
      />
    );
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <div
        data-testid="diagram-fixture"
        className="rounded-2xl bg-muted px-4 py-3"
        style={{ maxWidth: "40rem" }}
      >
        <ChatMarkdown streaming={message.streaming}>{message.markdown}</ChatMarkdown>
      </div>
    </main>
  );
}

void bootstrapI18n("en").then(() =>
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        <Fixture />
      </I18nProvider>
    </QueryClientProvider>,
  ),
);
