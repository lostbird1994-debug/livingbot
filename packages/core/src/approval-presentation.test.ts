import type { MessageBlock } from "@livingbot/contracts";
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
    expect(result.detail).toContain("修改前：每天 9:00");
    expect(result.detail).toContain("修改后：每天 10:00");
    expect(result.expandedDetail).toContain("修改前：旧任务");
    expect(result.expandedLabel).toBe("查看任务详情");
    expect(result.detail).not.toContain("任务名称");
  });
  it("formats a created task without repeating its name and keeps raw timing in details", () => {
    const result = approvalPresentation(
      {
        ...block,
        approvalContext: {
          tool: "schedule_create",
          reason: "policy",
          target: "Daily review",
          changes: [
            { field: "name", after: "Daily review" },
            { field: "cron", after: "0 23 * * *" },
            { field: "timezone", after: "Asia/Shanghai" },
          ],
        },
      },
      "zh-CN",
    );
    expect(result.rows).toEqual([
      { label: "执行时间", after: "每天 23:00" },
      { label: "时区", after: "北京时间（Asia/Shanghai）" },
    ]);
    expect(result.expandedDetail).toContain("0 23 * * *");
    expect(result.confirmLabel).toBe("创建任务");
    expect(result.denyLabel).toBe("不创建");
  });
  it("formats one-time timestamps in the stated timezone and keeps unusual cron readable", () => {
    const result = approvalPresentation(
      {
        ...block,
        approvalContext: {
          tool: "schedule_create",
          reason: "policy",
          changes: [
            { field: "runAt", after: "2026-11-10T15:00:00Z" },
            { field: "timezone", after: "Asia/Shanghai" },
            { field: "cron", after: "7 3 2 4 *" },
          ],
        },
      },
      "zh-CN",
    );
    expect(result.rows?.[0]?.after).toContain("23:00");
    expect(result.rows?.[2]?.after).toContain("7 3 2 4 *");
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
