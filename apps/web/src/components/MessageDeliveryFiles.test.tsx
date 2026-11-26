// @vitest-environment jsdom

import type { ThreadMessage } from "@livingbot/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageDeliveryFiles } from "./MessageDeliveryFiles";

const api = vi.hoisted(() => ({
  fileInfo: vi.fn(async () => ({ name: "report.md", path: "/Users/test/report.md", size: 2048 })),
}));
vi.mock("../lib/rpc", () => ({ rpc: { threads: api } }));
vi.mock("./ArtifactFileCard", () => ({
  ArtifactFileCard: ({ artifactId, name, size }: { artifactId: string; name: string; size?: number }) => (
    <div data-artifact-id={artifactId}>{name}:{size}</div>
  ),
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.fileInfo.mockClear();
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const sourceText = "来源：`参考文档/合并报表（含调整）/20261031（集团）/10月TB/示例TB.xlsx`；" +
  "明细：`数据源/04 明细（手工）/往来余额表.xlsx`；另见 `/Users/test/source.xlsx`。";
const file = (id: string) => ({
  kind: "file" as const, artifactId: id, name: `${id}.xlsx`,
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 2048,
});
async function render(id: string, blocks: ThreadMessage["blocks"]) {
  await act(async () => root.render(
    <MessageDeliveryFiles target={{ botId: "bot" }} message={{ id, blocks } as ThreadMessage} />,
  ));
}

it("does not create cards or request file metadata from source references in the reply", async () => {
  await render("references", [{ kind: "text", text: sourceText }]);
  expect(host.childElementCount).toBe(0);
  expect(api.fileInfo).not.toHaveBeenCalled();
});

it("renders delivered files with their artifact identity and size while ignoring source references", async () => {
  await render("delivered", [{ kind: "text", text: sourceText }, file("output")]);
  expect([...host.querySelectorAll("[data-artifact-id]")].map((node) => node.getAttribute("data-artifact-id")))
    .toEqual(["output"]);
  expect(host.textContent).toContain("output.xlsx:2048");
  expect(api.fileInfo).not.toHaveBeenCalled();
});

it("keeps cards scoped to the displayed message when changing replies", async () => {
  await render("first", [file("first")]);
  await render("second", [{ kind: "text", text: sourceText }]);
  expect(host.childElementCount).toBe(0);
  await render("third", [file("third")]);
  expect(host.textContent).toBe("third.xlsx:2048");
  expect(host.querySelector('[data-artifact-id="first"]')).toBeNull();
});

it("expands and collapses only the current message's delivered files", async () => {
  await render("many", [file("one"), file("two"), file("three")]);
  expect(host.querySelectorAll("[data-artifact-id]")).toHaveLength(2);
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelectorAll("[data-artifact-id]")).toHaveLength(3);
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelectorAll("[data-artifact-id]")).toHaveLength(2);
});
