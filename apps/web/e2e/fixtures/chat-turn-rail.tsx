import { I18nProvider } from "@lingui/react";
import type { ThreadMessage } from "@livingbot/contracts";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import "../../src/styles.css";
import { FixtureTranscript } from "./thread-fixture";

/** `null` stands for a turn the naming call has not reached: it shows its own opening words. */
const TURNS: Array<[string | null, string, string]> = Array.from(
  { length: 28 },
  (_, index) => [
    index === 8 ? null : `示例主题 ${index + 1}`,
    `请整理虚构项目 ${index + 1} 的测试清单。`,
    `示例项目 ${index + 1} 的清单已整理：检查输入、核验输出、记录结果。所有内容均为合成测试数据。`,
  ],
);

const BASE = Date.parse("2026-11-24T09:00:00.000Z");
const messages: ThreadMessage[] = TURNS.flatMap(([title, ask, answer], index) => {
  const createdAt = new Date(BASE + index * 240_000).toISOString();
  return [
    {
      id: `turn-${index + 1}-user`,
      threadId: "thread-1",
      seq: index * 2,
      role: "user" as const,
      blocks: [{ kind: "text" as const, text: ask }],
      ...(title ? { turnTitle: title } : {}),
      createdAt,
    },
    {
      id: `turn-${index + 1}-bot`,
      threadId: "thread-1",
      seq: index * 2 + 1,
      role: "bot" as const,
      botId: "bot-1",
      blocks: [{ kind: "text" as const, text: answer }],
      createdAt: new Date(BASE + index * 240_000 + 60_000).toISOString(),
    },
  ];
});

const header = (
  <div className="flex items-center px-[22px] py-3 text-[15px] font-medium text-foreground">
    示例助手
  </div>
);

// The fixture's own theme, so the margin column reads the way it does in the app it ships in.
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") ?? "light";

void bootstrapI18n("zh").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <FixtureTranscript
        messages={messages}
        running={false}
        showToolActivity={false}
        header={header}
      />
    </I18nProvider>,
  );
});
