import { I18nProvider } from "@lingui/react";
import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { ComposerError } from "../../src/pages/shell/composer-error";
import "../../src/styles.css";

function TaskFailure() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-8 bg-background p-6 text-foreground">
      <article className="flex-1">Daily report completed.</article>
      <ComposerError
        sendError={null}
        runError="External task cancelled"
        runErrorId="inspection-run"
        runErrorTaskName="Scheduled inventory check"
        onRunErrorPresented={() => {}}
        onOpenModels={() => {}}
        onOpenConnections={() => {}}
        onDismissError={() => {}}
        textareaRef={textareaRef}
      />
    </main>
  );
}

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <TaskFailure />
    </I18nProvider>,
  );
});
