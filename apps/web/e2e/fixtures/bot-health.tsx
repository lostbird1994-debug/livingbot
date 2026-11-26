import { I18nProvider } from "@lingui/react";
import { createRoot } from "react-dom/client";
import { BotHealthCard } from "../../src/components/BotHealthCard";
import { MarkdownChrome } from "../../src/components/markdown-copy";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { adoptConnection } from "../../src/lib/local-workbench";
import { NativeAdvancedSettings } from "../../src/pages/NativeSystemSettings";
import "../../src/styles.css";

adoptConnection({ origin: location.origin, token: "synthetic-test-connection-token-00000000" });
await bootstrapI18n("zh-CN");
const settings = new URLSearchParams(location.search).get("view") === "settings";
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <MarkdownChrome>
      <main className="mx-auto min-h-dvh max-w-2xl space-y-4 bg-background p-5 text-foreground">
        {settings ? (
          <NativeAdvancedSettings botId="test-bot" />
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border pb-3">
              <span className="font-medium">文档助手</span>
            </div>
            <BotHealthCard botId="test-bot" reportId="test-report" />
          </>
        )}
      </main>
    </MarkdownChrome>
  </I18nProvider>,
);
