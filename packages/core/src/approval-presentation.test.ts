import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { approvalPresentation } from "./approval-presentation.js";

const block: Extract<MessageBlock, { kind: "ask" }> = {
  kind: "ask",
  text: "Review before schedule_update",
  approvalEffectId: "effect-1",
  approvalContext: {
    tool: "schedule_update",
    reason: "new_schedule_site",
    target: "每日新闻",
    sites: ["new.example.test"],
    changes: [
      { field: "cron", before: "0 9 * * *", after: "0 10 * * *" },
      { field: "prompt", before: "旧任务", after: "新任务" },
      { field: "name", before: "每日新闻", after: "每日新闻" },
    ],
  },
};
describe("approval presentation", () => {
  it("shows Chinese operation, task, before/after values and concrete destination", () => {
    const result = approvalPresentation(block, "zh-CN");
    expect(result.title).toBe("请确认：修改定时任务「每日新闻」");
    expect(result.detail).toContain("尚未授权的网站");
    expect(result.detail).toContain("待授权网站：new.example.test");
    expect(result.detail).toContain("修改前：0 9 * * *");
    expect(result.detail).toContain("修改后：0 10 * * *");
    expect(result.expandedDetail).toContain("修改前：旧任务");
    expect(result.expandedLabel).toBe("查看任务内容修改详情");
    expect(result.detail).not.toContain("任务名称");
  });
  it("keeps an English presentation for other interfaces", () => {
    const result = approvalPresentation(block, "en");
    expect(result.title).toContain("Confirm:");
    expect(result.detail).toContain("unapproved website");
  });
  it("localizes existing generic cards without changing their saved contents", () => {
    const old = {
      kind: "ask" as const,
      text: "Review before schedule_update",
      approvalEffectId: "e",
      detail: "original",
    };
    expect(approvalPresentation(old, "zh-CN")).toEqual({
      title: "请确认：修改定时任务",
      detail: "original",
    });
    expect(old.text).toBe("Review before schedule_update");
  });
  it("does not reinterpret a normal question as an approval", () => {
    const question = { kind: "ask" as const, text: "Review before lunch?" };
    expect(approvalPresentation(question, "zh-CN").title).toBe(question.text);
  });
});
