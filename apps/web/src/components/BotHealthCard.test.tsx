// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HealthReport } from "../../../../packages/workbench/src/bot-health-types";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../lib/local-workbench", () => ({
  localConnection: async () => ({ origin: "http://127.0.0.1:1234", token: "synthetic" }),
}));
vi.mock("../../../workbench-web/src/client", () => ({
  WorkbenchClient: class {
    request = api.request;
  },
}));

import { BotHealthCard } from "./BotHealthCard";

let root: Root;
let container: HTMLDivElement;
let report: HealthReport;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  report = {
    id: "report",
    botId: "bot",
    taskId: "task",
    runId: "run",
    version: "bot-health-v1",
    revision: "revision-1",
    createdAt: 1,
    mode: "confirm",
    first: true,
    state: "reported",
    summary: "发现一处旧入口",
    complete: true,
    gaps: [],
    issues: [
      {
        id: "issue",
        category: "workspace",
        priority: "P2",
        certainty: "confirmed",
        title: "目录仍指向旧版",
        problem: "旧文件已有替代版本",
        impact: "可能拿错文件",
        suggestion: "更新入口",
        plan: { steps: ["备份目录文件", "更新后核对入口"] },
        evidence: [{ path: "tasks/index.md", excerpt: "旧入口" }],
        actions: [
          {
            id: "fix",
            kind: "write",
            path: "tasks/index.md",
            expectedDigest: "digest",
            beforeContent: "旧入口",
            content: "新入口",
            explanation: "只更新入口",
          },
        ],
      },
    ],
  };
  api.request.mockReset();
  api.request.mockImplementation(async (_path: string, body?: unknown) => {
    if (body)
      report = {
        ...report,
        revision: "revision-2",
        issues: report.issues.map((issue) => ({
          ...issue,
          actions: issue.actions.map((action) => ({ ...action, state: "applied" as const })),
        })),
      };
    return report;
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => {
    root.render(<BotHealthCard botId="bot" reportId="report" />);
  });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  expect(button).toBeTruthy();
  await act(async () => {
    button!.click();
  });
}
it("selects a plan locally and sends the whole decision batch only on submit", async () => {
  await render();
  expect(container.textContent).toContain("P2 · 建议处理");
  expect(container.textContent).toContain("影响");
  expect(container.textContent).toContain("可能拿错文件");
  expect(container.textContent).not.toContain("/100");
  expect(api.request).toHaveBeenCalledTimes(1);
  const detail = [...container.querySelectorAll("summary")].find(
    (item) => item.textContent === "具体改动",
  );
  await act(async () => detail!.click());
  expect(container.textContent).toContain("修改前");
  expect(container.textContent).toContain("旧入口");
  expect(api.request).toHaveBeenCalledTimes(1);
  expect(container.querySelector<HTMLButtonElement>("button:last-child")?.disabled).not.toBe(false);
  await act(async () =>
    container.querySelector<HTMLElement>('[role="radio"][data-choice="apply"]')!.click(),
  );
  expect(api.request).toHaveBeenCalledTimes(1);
  await click("提交并处理");
  const [path, body] = api.request.mock.calls[1]!;
  expect(path).toContain("/decisions");
  expect(body).toEqual({
    decisions: [{ issueId: "issue", choice: "apply" }],
    submissionId: expect.any(String),
    revision: "revision-1",
  });
  expect(container.textContent).toContain("已改好并核对");
  expect(container.textContent).not.toContain("提交并处理");
});
it("shows missing coverage and unverified findings without claiming a complete clean bill", async () => {
  report.complete = false;
  report.gaps = ["技能依赖尚未验证"];
  report.issues[0]!.certainty = "unverified";
  await render();
  expect(container.textContent).toContain("部分完成");
  expect(container.textContent).toContain("待确认");
  expect(container.textContent).toContain("证据不足");
  expect(container.textContent).not.toContain("P2 · 建议处理");
  // 待确认的问题同样只有三个处理方式，不再有“先出方案”这一档。
  expect(container.querySelectorAll('[role="radio"]').length).toBe(3);
});

it("offers exactly the three decisions for every finding", async () => {
  await render();
  const labels = [...container.querySelectorAll('[role="radio"]')].map(
    (item) => item.parentElement?.textContent,
  );
  expect(labels).toEqual(["暂不处理", "按建议执行", "其他"]);
  expect(container.textContent).not.toContain("生成");
});

it("requires text for other, keeps selections local, and submits all issue decisions once", async () => {
  report.issues.push({ ...report.issues[0]!, id: "second", title: "另一项问题", actions: [] });
  await render();
  await act(async () => {
    container.querySelector<HTMLElement>('[role="radio"][data-choice="defer"]')!.click();
    container.querySelectorAll<HTMLElement>('[role="radio"][data-choice="other"]')[1]!.click();
  });
  const submit = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "提交并处理",
  )!;
  expect(submit.disabled).toBe(true);
  await act(async () => {
    const input = container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      "先保留原件",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(api.request).toHaveBeenCalledTimes(1);
  await click("提交并处理");
  expect(api.request.mock.calls[1]![1]).toMatchObject({
    decisions: [
      { issueId: "issue", choice: "defer" },
      { issueId: "second", choice: "other", instruction: "先保留原件" },
    ],
  });
});

it("clears a failed read after the report is successfully retried", async () => {
  api.request.mockRejectedValueOnce(new Error("报告读取失败"));
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("报告读取失败");
  await click("重试");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("目录仍指向旧版");
});

it("shows a hand-off fix as work the Bot performs instead of a file edit", async () => {
  api.request.mockImplementation(async (_path: string, body?: unknown) => {
    if (body)
      return {
        ...report,
        revision: "revision-2",
        batch: { id: "batch", state: "completed", decisions: [] },
        issues: report.issues.map((issue) => ({
          ...issue,
          actions: issue.actions.map((action) => ({ ...action, state: "handed_off" as const })),
        })),
      };
    return {
      ...report,
      issues: [
        {
          ...report.issues[0]!,
          category: "skills" as const,
          actions: [
            {
              id: "workshop",
              kind: "instruction" as const,
              target: "Workshop 技能：dividend-simulation-workbook",
              steps: ["把写死的期间改成按本次取值", "提交新版本"],
              explanation: "技能里写死了 10 月目录",
            },
            ...report.issues[0]!.actions,
          ],
        },
      ],
    };
  });
  await render();
  const detail = [...container.querySelectorAll("summary")].find(
    (item) => item.textContent === "具体改动",
  );
  await act(async () => detail!.click());
  expect(container.textContent).toContain("交给 Bot 执行：Workshop 技能");
  expect(container.textContent).toContain("把写死的期间改成按本次取值");
  await act(async () =>
    container.querySelector<HTMLElement>('[role="radio"][data-choice="apply"]')!.click(),
  );
  await click("提交并处理");
  expect(container.textContent).toContain("已交给 Bot 执行");
});
