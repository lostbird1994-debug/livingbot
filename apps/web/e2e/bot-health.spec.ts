import { expect, test } from "@playwright/test";
import type { HealthReport } from "../../../packages/workbench/src/bot-health-types";
import { captureScreenshot } from "./helpers";

test("health findings stay in the conversation and changes require the reviewed plan", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let changed = false;
  const report: HealthReport = {
    id: "test-report",
    botId: "test-bot",
    taskId: "task",
    runId: "run",
    version: "bot-health-v1",
    revision: "v1",
    createdAt: 1,
    mode: "confirm",
    first: true,
    state: "reported",
    complete: true,
    gaps: [],
    summary: "发现 2 项需要处理的问题。检查期间没有修改文件。",
    issues: [
      {
        id: "conflict",
        category: "context",
        priority: "P1",
        certainty: "confirmed",
        title: "两处规则对交付方式的要求不同",
        problem: "工作指令要求保留源稿，技能却要求只交付 PDF。",
        impact: "可能漏交你需要继续编辑的文件。",
        suggestion: "统一为保留源稿，并按需导出 PDF。",
        plan: {
          steps: ["核对两处规则的适用范围", "统一交付口径，保留源稿与所需 PDF"],
          diagram:
            'flowchart TD\n A["统一交付规则"] --> B["保留可编辑源稿"]\n A --> C["按需导出 PDF"]\n B --> D["核对交付清单"]\n C --> D',
        },
        evidence: [{ path: "AGENTS.md", excerpt: "交付时保留可编辑源稿。" }],
        actions: [
          {
            id: "conflict-skill",
            kind: "instruction",
            target: "Workshop 技能：交付规则",
            steps: [
              "把技能里的“只交付 PDF”改成按需导出",
              "保留可编辑源稿作为默认交付物",
              "提交新版本并保留上一版",
            ],
            explanation: "技能与工作指令冲突，改技能这一侧。",
          },
        ],
      },
      {
        id: "versions",
        category: "workspace",
        priority: "P2",
        certainty: "confirmed",
        title: "同一份报告留下了多个版本",
        problem: "目录仍然指向旧版，已经有确认过的最终版。",
        impact: "下次使用时容易拿错。",
        suggestion: "先更新目录入口，再核对旧版能否移入废纸篓。",
        plan: {
          steps: [
            "保留旧入口的恢复副本",
            "把目录指向已确认的最终版",
            "重新打开入口，确认能找到最终版",
          ],
        },
        evidence: [{ path: "tasks/report/INDEX.md", excerpt: "报告入口：draft.md" }],
        actions: [
          {
            id: "index",
            kind: "write",
            path: "tasks/report/INDEX.md",
            expectedDigest: "synthetic",
            beforeContent: "报告入口：draft.md",
            content: "报告入口：final.md",
            explanation: "只更新入口，其他文件保持原位。",
          },
        ],
      },
    ],
  };
  await page.route("**/api/bots/test-bot/health-reports/**", async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({
        submissionId: expect.any(String),
        revision: "v1",
        decisions: [
          { issueId: "conflict", choice: "other", instruction: "先保留两种交付方式" },
          { issueId: "versions", choice: "apply" },
        ],
      });
      changed = true;
      report.issues[1]!.actions[0]!.state = "applied";
      report.revision = "v2";
      report.batch = {
        id: "batch",
        state: "needs_review",
        decisions: route.request().postDataJSON().decisions,
      };
    }
    await route.fulfill({ json: report });
  });
  await page.setViewportSize({ width: 900, height: 940 });
  await page.goto("/e2e/fixtures/bot-health.html");
  await expect(page.getByText("P1 · 优先处理")).toBeVisible();
  await expect(page.getByText("P2 · 建议处理")).toBeVisible();
  await expect(page.getByRole("button", { name: "提交并处理" })).toBeDisabled();
  await expect(page.getByTestId("chat-diagram").locator("img").first()).toBeVisible();
  expect(changed).toBe(false);
  await captureScreenshot(page, testInfo, "bot-health-conversation");
  await page
    .getByRole("article", { name: "同一份报告留下了多个版本", exact: true })
    .getByText("具体改动")
    .click();
  await page.getByText("修改前后全文").click();
  await page.evaluate(async () => {
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => {})),
    );
  });
  await expect(page.locator("pre").filter({ hasText: "报告入口：draft.md" })).toBeVisible();
  await expect(page.locator("pre").filter({ hasText: "报告入口：final.md" })).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-health-review");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "bot-health-zoom");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
  });
  expect(changed).toBe(false);
  await page
    .getByRole("article", { name: "两处规则对交付方式的要求不同", exact: true })
    .getByText("其他", { exact: true })
    .click();
  await page.getByLabel("你希望怎么处理？").fill("先保留两种交付方式");
  await page
    .getByRole("article", { name: "同一份报告留下了多个版本", exact: true })
    .getByText("按建议执行", { exact: true })
    .click();
  expect(changed).toBe(false);
  await page.getByRole("button", { name: "提交并处理" }).click();
  await expect(page.getByText("已改好并核对", { exact: false })).toBeVisible();
  expect(changed).toBe(true);
  await expect(page.getByText("已提交，Bot 正在调整方案")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("bot-health-card")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "bot-health-narrow");
});

test("Bot settings contain only scheduling and handling choices", async ({ page }, testInfo) => {
  await page.route("**/api/bots/test-bot/capability-audit", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        cadence: "weekly",
        hour: 18,
        minute: 0,
        weekday: 5,
        timezone: "Asia/Shanghai",
        mode: "confirm",
        consolidateVersions: false,
        scopeConfirmed: true,
      },
    }),
  );
  await page.goto("/e2e/fixtures/bot-health.html?view=settings");
  await expect(page.getByText("定期体检", { exact: true })).toBeVisible();
  await expect(page.getByTestId("bot-health-card")).toHaveCount(0);
  await expect(page.getByText("查看审计指令")).toHaveCount(0);
  await page.getByLabel("体检完成后").selectOption("silent");
  await expect(page.getByRole("switch", { name: "自动清理相同副本" })).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-health-settings");
});

test("report illustrations reuse the isolated interactive diagram host and export actual images", async ({
  page,
}, testInfo) => {
  const code = `<h2 class="sr-only">文件整理顺序</h2>
<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="文件整理顺序" viewBox="0 0 680 150">
<title>文件整理顺序</title><desc>先确认保留版本，再整理旧版</desc>
<rect class="box" x="32" y="30" width="616" height="90" rx="12"/>
<text id="stage" class="th" x="340" y="80" text-anchor="middle">先确认保留版本</text></svg>
<button id="next" type="button">下一步</button>
<script>document.getElementById("next").onclick=()=>{document.getElementById("stage").textContent="再核对旧版和引用";};</script>`;
  const report: HealthReport = {
    id: "test-report",
    botId: "test-bot",
    taskId: "task",
    runId: "run",
    version: "bot-health-v1",
    revision: "v1",
    createdAt: 1,
    mode: "confirm",
    first: true,
    state: "reported",
    complete: true,
    gaps: [],
    summary: "有一项可选整理建议",
    issues: [
      {
        id: "files",
        category: "workspace",
        priority: "P3",
        certainty: "suggestion",
        title: "先确认版本，再整理文件",
        problem: "多个候选版本仍在同一目录。",
        impact: "查找最终稿不方便。",
        suggestion: "先确认有效版本，再核对其他版本是否可以整理。",
        evidence: [],
        actions: [],
        plan: {
          steps: ["确认有效版本", "核对旧版内容和引用"],
          limitation: "需要先确认保留版本",
          illustration: { title: "文件整理顺序", format: "html", code },
        },
      },
    ],
  };
  await page.route("**/api/bots/test-bot/health-reports/**", (route) =>
    route.fulfill({ json: report }),
  );
  await page.goto("/e2e/fixtures/bot-health.html");
  const widget = page.getByTestId("inline-widget");
  const content = page.frameLocator('iframe[title="文件整理顺序"]').frameLocator("#widget");
  await expect(content.getByRole("img", { name: "文件整理顺序" })).toBeVisible();
  await content.getByRole("button", { name: "下一步" }).click();
  await expect(content.locator("#stage")).toHaveText("再核对旧版和引用");
  await widget.getByRole("button", { name: "查看源代码" }).click();
  await expect(widget.locator("pre")).toContainText('id="stage"');
  await widget.getByRole("button", { name: "查看源代码" }).click();
  const image = page.waitForEvent("download");
  await widget.getByRole("button", { name: "下载图片" }).click();
  const download = await image;
  expect(download.suggestedFilename()).toBe("文件整理顺序.png");
  await download.saveAs(testInfo.outputPath("health-diagram.png"));
  await widget.getByRole("button", { name: "展开", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await captureScreenshot(page, testInfo, "health-interactive-diagram");
});
