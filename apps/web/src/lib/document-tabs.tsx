import { createContext, useCallback, useContext, useState } from "react";
import type { ArtifactTarget } from "./artifact-open";

export type MarkdownDocument = { name: string; target: ArtifactTarget } & (
  | { kind: "artifact"; artifactId: string }
  | { kind: "message"; messageId: string; path: string }
);
export type DocumentTab = MarkdownDocument & { id: string };

const OpenDocumentContext = createContext<((document: MarkdownDocument) => void) | null>(null);
export const DocumentTabsProvider = OpenDocumentContext.Provider;
export const useOpenDocument = () => useContext(OpenDocumentContext);

export function isMarkdownFile(name: string, mimeType?: string) {
  return /\.md$/i.test(name) || mimeType?.split(";", 1)[0]?.trim() === "text/markdown";
}

/** File tabs live only in this chat and never create or change an agent task. */
export function useDocumentTabs(scope: string) {
  const [state, setState] = useState<{
    scope: string;
    opened: DocumentTab[];
    selected: string | null;
  }>({ scope, opened: [], selected: null });
  const current = state.scope === scope ? state : { scope, opened: [], selected: null };
  const open = useCallback(
    (document: MarkdownDocument) => {
      const id = JSON.stringify([
        document.target,
        document.kind,
        document.kind === "artifact" ? document.artifactId : [document.messageId, document.path],
      ]);
      setState((previous) => {
        const opened = previous.scope === scope ? previous.opened : [];
        return {
          scope,
          opened: opened.some((tab) => tab.id === id) ? opened : [...opened, { ...document, id }],
          selected: id,
        };
      });
    },
    [scope],
  );
  const select = useCallback(
    (id: string | null) => {
      setState((previous) =>
        previous.scope === scope
          ? { ...previous, selected: id }
          : { scope, opened: [], selected: null },
      );
    },
    [scope],
  );
  const close = useCallback(
    (id: string) => {
      setState((previous) =>
        previous.scope === scope
          ? {
              ...previous,
              opened: previous.opened.filter((tab) => tab.id !== id),
              selected: previous.selected === id ? null : previous.selected,
            }
          : previous,
      );
    },
    [scope],
  );
  return {
    opened: current.opened,
    selected: current.opened.find((tab) => tab.id === current.selected),
    open,
    select,
    close,
  };
}
