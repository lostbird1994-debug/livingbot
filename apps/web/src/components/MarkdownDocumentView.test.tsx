// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DocumentTab } from "../lib/document-tabs";
import type { RpcClient } from "../lib/rpc";
import { MarkdownDocumentView } from "./MarkdownDocumentView";

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray) => strings.join("");
  return { useLingui: () => ({ t }) };
});
vi.mock("@livingbot/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <div data-markdown>{children}</div>,
}));
const get = vi.fn();
const filePreview = vi.fn();
const rpc = { artifacts: { get }, threads: { filePreview } } as unknown as RpcClient;
const file: DocumentTab = {
  id: "a",
  kind: "artifact",
  name: "notes.md",
  artifactId: "a",
  target: { botId: "bot", taskSessionId: "task" },
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  get.mockReset();
  filePreview.mockReset();
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("loads an attachment using its complete task scope", async () => {
  get.mockResolvedValue({ contentBase64: btoa("# Report") });
  await act(async () => root.render(<MarkdownDocumentView document={file} rpc={rpc} />));
  expect(host.querySelector("[role=tabpanel]")?.getAttribute("aria-label")).toBe("notes.md");
  expect(host.textContent).toBe("# Report");
  expect(get).toHaveBeenCalledWith(
    { botId: "bot", taskSessionId: "task", artifactId: "a" },
    expect.anything(),
  );
});

it("reads a message-linked file through the authorized preview endpoint", async () => {
  filePreview.mockResolvedValue({ name: "notes.md", text: "中文说明" });
  await act(async () =>
    root.render(
      <MarkdownDocumentView
        document={{
          id: "local",
          kind: "message",
          name: "notes.md",
          target: { groupId: "group" },
          messageId: "m",
          path: "/Users/test/notes.md",
        }}
        rpc={rpc}
      />,
    ),
  );
  expect(host.textContent).toBe("中文说明");
  expect(filePreview).toHaveBeenCalledWith(
    { groupId: "group", messageId: "m", path: "/Users/test/notes.md" },
    expect.anything(),
  );
  expect(get).not.toHaveBeenCalled();
});

it("ignores late bytes when another document is selected", async () => {
  let resolve!: (value: { contentBase64: string }) => void;
  get.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  get.mockResolvedValueOnce({ contentBase64: btoa("second") });
  await act(async () => root.render(<MarkdownDocumentView document={file} rpc={rpc} />));
  expect(host.querySelector("[role=status]")).not.toBeNull();
  await act(async () =>
    root.render(
      <MarkdownDocumentView document={{ ...file, id: "b", artifactId: "b" }} rpc={rpc} />,
    ),
  );
  await act(async () => resolve({ contentBase64: btoa("stale first") }));
  expect(host.textContent).toBe("second");
});

it("offers retry after a load failure", async () => {
  get
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce({ contentBase64: btoa("retried") });
  await act(async () => root.render(<MarkdownDocumentView document={file} rpc={rpc} />));
  expect(host.querySelector("[role=alert]")).not.toBeNull();
  await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toBe("retried");
});
