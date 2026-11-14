import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@livingbot/chat-ui/web";
import { Button, Spinner } from "@livingbot/ui-web";
import { useEffect, useState } from "react";
import { decodeArtifactBase64 } from "../lib/artifact-open";
import type { DocumentTab } from "../lib/document-tabs";
import type { RpcClient } from "../lib/rpc";
import { errorText } from "../lib/user-error";

export function MarkdownDocumentView({ document, rpc }: { document: DocumentTab; rpc: RpcClient }) {
  const { t } = useLingui();
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; text: string } | { status: "error"; message: string }
  >({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    async function load() {
      if (document.kind === "message") {
        const result = await rpc.threads.filePreview(
          {
            ...document.target,
            messageId: document.messageId,
            path: document.path,
          },
          { signal: controller.signal },
        );
        return result.text;
      }
      const artifact = await rpc.artifacts.get(
        {
          ...document.target,
          artifactId: document.artifactId,
        },
        { signal: controller.signal },
      );
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(
          decodeArtifactBase64(artifact.contentBase64),
        );
      } catch {
        throw new Error(t`This file is not valid UTF-8 text.`);
      }
    }
    void load()
      .then((text) => {
        if (!controller.signal.aborted) setState({ status: "ready", text });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({ status: "error", message: errorText(error, t`Could not load this file.`) });
      });
    return () => controller.abort();
  }, [document, rpc, retry, t]);

  return (
    <section
      role="tabpanel"
      aria-label={document.name}
      className="relative flex min-h-0 flex-1 flex-col overflow-auto bg-background"
    >
      {state.status === "loading" ? (
        <div className="grid flex-1 place-items-center">
          <Spinner aria-label={t`Loading preview…`} />
        </div>
      ) : state.status === "error" ? (
        <div className="m-6 space-y-3">
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRetry((value) => value + 1)}
          >{t`Retry`}</Button>
        </div>
      ) : (
        <article className="mx-auto w-full max-w-3xl break-words px-6 py-8 text-foreground sm:px-10 sm:py-12">
          <ChatMarkdown>{state.text}</ChatMarkdown>
        </article>
      )}
    </section>
  );
}
