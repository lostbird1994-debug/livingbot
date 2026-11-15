import { I18nProvider } from "@lingui/react";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import "../../src/styles.css";
import { FixtureTranscript, reduceThreadEvents } from "./thread-fixture";

const snapshot = reduceThreadEvents([
  {
    type: "thread.message.created",
    payload: {
      messageId: "spreadsheet-reply",
      role: "bot",
      blocks: [
        {
          kind: "file",
          artifactId: "legacy-spreadsheet",
          name: "季度报表.1115（修订版）",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: 14438,
        },
      ],
    },
  },
]);

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <FixtureTranscript messages={snapshot.messages} running={false} showToolActivity={false} />
    </I18nProvider>,
  );
});
