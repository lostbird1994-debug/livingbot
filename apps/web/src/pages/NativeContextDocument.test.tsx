// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ updateContextDocument: vi.fn() }));
vi.mock("../lib/space-rpc", () => ({ useSpaceRpc: () => ({ memory: api }) }));
vi.mock("@livingbot/ui-web", () => ({
  Button: ({
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));

import { contextDocumentLabel, NativeContextDocument } from "./NativeContextDocument";

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const onSaved = vi.fn(async () => {});
const doc = {
  name: "AGENTS.md",
  scope: "bot" as const,
  content: "Full source beyond loaded excerpt",
  excerpt: "Full",
  totalChars: 32,
  shownChars: 4,
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  root = createRoot(host);
  api.updateContextDocument.mockReset();
  onSaved.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(<NativeContextDocument botId="synthetic" document={doc} onSaved={onSaved} />),
  );
}
async function click(text: string) {
  const b = [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
  await act(async () => b.click());
}
async function type(value: string) {
  const el = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("saves the complete source against its exact preimage with the original filename", async () => {
  api.updateContextDocument.mockResolvedValue({ ok: true });
  await render();
  await click("编辑");
  expect(host.querySelector("textarea")!.value).toBe(doc.content);
  await type("Changed full source");
  await click("保存");
  expect(api.updateContextDocument).toHaveBeenCalledWith({
    botId: "synthetic",
    scope: "bot",
    name: "AGENTS.md",
    content: "Changed full source",
    expectedContent: doc.content,
  });
  expect(onSaved).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Changed full source");
});
it("keeps the draft when saving fails", async () => {
  api.updateContextDocument.mockRejectedValue(Error("Save rejected"));
  await render();
  await click("编辑");
  await type("Keep my draft");
  await click("保存");
  expect(host.querySelector("textarea")!.value).toBe("Keep my draft");
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(onSaved).not.toHaveBeenCalled();
});
it("cancels without writing and annotates only display labels", async () => {
  await render();
  await click("编辑");
  await type("Discard");
  await click("取消");
  expect(api.updateContextDocument).not.toHaveBeenCalled();
  expect(contextDocumentLabel("AGENTS.md")).toBe("AGENTS.md（指令）");
  expect(contextDocumentLabel("工作区共享/MEMORY.md")).toBe("MEMORY.md（记忆）");
  expect(host.textContent).not.toContain("4 / 32");
});
