import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("renames a draft through its context menu and confirms deletion", async ({
  page,
}, testInfo) => {
  await signup(page, `sessions-${Date.now()}@livingbot.test`, "password12", "Session fixture");
  await completeOnboarding(page);
  const capabilities = await rpc<{ enabled: boolean }>(page, "taskSessions/capabilities", {});
  test.skip(!capabilities.enabled, "Independent conversations need a compatible runtime.");
  await page.getByRole("button", { name: "新会话", exact: true }).click();
  await page.getByRole("tab", { name: "新会话", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  await page.getByRole("textbox", { name: "会话名称", exact: true }).fill("Travel plans");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Travel plans", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "全部会话", exact: true }).click();
  await page.getByRole("button", { name: "会话操作 Travel plans", exact: true }).click();
  await captureScreenshot(page, testInfo, "conversation-management-menu");
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Travel plans", exact: true })).toHaveCount(0);
});
