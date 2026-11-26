import { I18nProvider } from "@lingui/react";
import type { ThreadMessage } from "@livingbot/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import type { AppTextSize, ChatWidth } from "../../src/lib/reading-prefs";
import { setAppTextSize, setChatWidth } from "../../src/lib/reading-prefs";
import { ResizableSidePanel } from "../../src/pages/ResizableSidePanel";
import "../../src/styles.css";
import { FixtureTranscript } from "./thread-fixture";

const paragraph =
  "这是一段用于验证阅读位置的合成回复。展开侧栏时，应保持正文的换行、段落高度和时间标签位置稳定，收起后也应能继续阅读原来的句子。";
const messages: ThreadMessage[] = Array.from({ length: 12 }, (_, turn) => [
  {
    id: `reading-${turn}-user`,
    threadId: "thread-1",
    seq: turn * 2,
    role: "user" as const,
    blocks: [{ kind: "text" as const, text: `请检查示例项目 ${turn + 1}。` }],
    createdAt: new Date(Date.UTC(2026, 10, 24, 9, turn * 10)).toISOString(),
  },
  {
    id: `reading-${turn}-bot`,
    threadId: "thread-1",
    seq: turn * 2 + 1,
    role: "bot" as const,
    botId: "bot-1",
    blocks: [
      {
        kind: "text" as const,
        text: Array.from(
          { length: 4 },
          (_, index) => `第 ${index + 1} 段：${paragraph.repeat(3)}`,
        ).join("\n\n"),
      },
    ],
    createdAt: new Date(Date.UTC(2026, 10, 24, 9, turn * 10 + 1)).toISOString(),
  },
]).flat();

function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex h-dvh overflow-hidden bg-background">
      <aside className="hidden w-[316px] shrink-0 border-e border-border bg-sidebar md:block" />
      <div className="min-w-0 flex-1">
        <FixtureTranscript
          messages={messages}
          running={false}
          showToolActivity={false}
          header={
            <header className="flex shrink-0 items-center gap-4 border-b border-border p-4">
              <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
                Toggle panel
              </button>
              <select
                aria-label="Chat width"
                defaultValue="default"
                onChange={(event) => setChatWidth(event.target.value as ChatWidth)}
              >
                <option value="narrow">Narrow</option>
                <option value="default">Default</option>
                <option value="wide">Wide</option>
              </select>
              <select
                aria-label="Text size"
                defaultValue="default"
                onChange={(event) => setAppTextSize(event.target.value as AppTextSize)}
              >
                <option value="default">Default</option>
                <option value="largest">Largest</option>
              </select>
            </header>
          }
        />
      </div>
      <ResizableSidePanel open={open} panel={open ? "settings" : "closed"}>
        {open ? (
          <div className="p-5">
            <button type="button" onClick={() => setOpen(false)}>
              Close panel
            </button>
            <p>合成测试侧栏</p>
          </div>
        ) : null}
      </ResizableSidePanel>
    </div>
  );
}

void bootstrapI18n("zh").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <Fixture />
    </I18nProvider>,
  );
});
