// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Interaction, InteractionAnswer } from "../../../workbench/src/contracts.ts";
import { InteractionCard } from "./InteractionCard";

const prompt: Interaction = {
  id: "approval:example",
  engineId: "example",
  kind: "approval",
  taskId: "task",
  conversationId: "chat",
  sessionKey: "synthetic",
  runId: "run",
  generation: 1,
  title: "printf 'hello world' && ls /example/workspace",
  questions: [],
  decisions: ["allow-once", "deny"],
  status: "pending",
  createdAt: 1,
  expiresAt: 9999999999999,
};
let container: HTMLDivElement;
let root: Root;
const resolveInteraction =
  vi.fn<(taskId: string, id: string, answer: InteractionAnswer) => Promise<Interaction>>();
const onResolved = vi.fn();
const onDraftChange = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  resolveInteraction.mockResolvedValue({
    ...prompt,
    status: "answered",
    answer: { decision: "allow-once" },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(value = prompt) {
  await act(async () =>
    root.render(
      <InteractionCard
        prompt={value}
        client={{ resolveInteraction }}
        onResolved={onResolved}
        onDraftChange={onDraftChange}
      />,
    ),
  );
}
function button(label: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent === label);
}

it("shows the exact command and only native decisions, with a single-use primary action", async () => {
  await render();
  expect(container.querySelector("header")?.textContent).toContain("运行本机命令");
  expect(container.querySelector("details")?.open).toBe(true);
  expect(container.querySelector("summary")?.textContent).toBe("待执行命令");
  expect(container.querySelector("pre code")?.textContent).toBe(prompt.title);
  expect(button("始终允许")).toBeUndefined();
  await act(async () => button("允许这次")!.click());
  expect(resolveInteraction).toHaveBeenCalledTimes(1);
  expect(resolveInteraction).toHaveBeenCalledWith("task", "approval:example", {
    decision: "allow-once",
    resolutionId: expect.any(String),
  });
  expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ status: "answered" }));
});

it("shows only native context and translated native risk enums, retaining the exact command in details", async () => {
  const command = "example --exact-command";
  await render({
    ...prompt,
    approval: {
      taskTitle: "检查示例项目",
      command,
      host: "gateway",
      cwd: "/example/workspace",
      warningText: "Native confirmation required",
      commandAnalysis: {
        commandCount: 1,
        nestedCommandCount: 0,
        riskKinds: ["inline-eval", "future-native-risk"],
        warningLines: ["Contains inline-eval: example --eval"],
      },
    },
  });
  expect(container.querySelector("header")?.textContent).toBe("运行本机命令");
  expect(container.textContent).toContain("所属任务：检查示例项目");
  expect(container.textContent).toContain("工作目录：/example/workspace");
  expect(container.textContent).toContain("执行提示：Native confirmation required");
  expect(container.textContent).toContain("内核识别：将直接运行一段代码、future-native-risk");
  expect(container.textContent).toContain("Contains inline-eval: example --eval");
  expect(container.querySelector("details")?.open).toBe(true);
  expect(container.querySelector("details pre code")?.textContent).toBe(command);
  expect(container.querySelector("details")?.textContent).not.toContain(
    "Native confirmation required",
  );
});

it.each([
  ["node", "运行节点命令"],
  ["sandbox", "运行沙箱命令"],
])("labels the native %s host without guessing the command's purpose", async (host, operation) => {
  await render({ ...prompt, approval: { host } });
  expect(container.querySelector("header")?.textContent).toBe(operation);
  expect(container.querySelector("pre code")?.textContent).toBe(prompt.title);
});

it("collapses answered approvals into a disclosure while retaining the full original command", async () => {
  const title = `cat /example/${"nested/".repeat(40)}report.txt`;
  await render({ ...prompt, title, status: "answered", answer: { decision: "deny" } });
  expect(container.querySelector("details")?.open).toBe(false);
  expect(container.querySelector("summary")?.textContent).toContain("已拒绝");
  expect(container.querySelector("details pre code")?.textContent).toBe(title);
  expect(container.querySelector("button")).toBeNull();
  await act(async () => container.querySelector("summary")!.click());
  expect(container.querySelector("details")?.open).toBe(true);
});

it("retains a failed decision and its identity across remount instead of granting a different action", async () => {
  resolveInteraction.mockRejectedValueOnce(new Error("synthetic transport failure"));
  await render({ ...prompt, decisions: ["allow-once", "allow-always", "deny"] });
  await act(async () => button("拒绝")!.click());
  const original = resolveInteraction.mock.calls[0]![2];
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "synthetic transport failure",
  );
  expect(button("允许这次")).toBeUndefined();
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(button("重试确认")).toBeDefined();
  await act(async () => button("重试确认")!.click());
  expect(resolveInteraction.mock.calls[1]![2]).toEqual(original);
});

it("does not offer a second decision while native confirmation is in progress", async () => {
  await render({ ...prompt, status: "answering" });
  expect(button("允许这次")?.disabled).toBe(true);
  expect(button("拒绝")?.disabled).toBe(true);
  expect(resolveInteraction).not.toHaveBeenCalled();
});

it("retains the existing question flow and does not show exec controls there", async () => {
  await render({
    ...prompt,
    kind: "question",
    title: "Choose a folder",
    decisions: [],
    questions: [
      {
        id: "folder",
        header: "Folder",
        question: "Choose a folder",
        options: [{ label: "Reports", value: "reports" }],
        multiSelect: false,
        allowOther: false,
      },
    ],
  });
  expect(container.querySelector("fieldset legend")?.textContent).toBe("Choose a folder");
  expect(button("继续")?.disabled).toBe(true);
  expect(button("允许这次")).toBeUndefined();
  expect(button("跳过")).toBeDefined();
});
