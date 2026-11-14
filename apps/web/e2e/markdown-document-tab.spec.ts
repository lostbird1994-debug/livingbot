import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("an agent's Markdown file opens beside session tabs and preserves the chat draft", async ({
  page,
}, testInfo) => {
  await signup(page, `markdown-tab-${Date.now()}@livingbot.test`, "password12", "Document tabs");
  await completeOnboarding(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill(
    "write path notes/preview.md and attach it to the thread says # Project preview",
  );
  await page.keyboard.press("Enter");
  const file = page
    .getByTestId("message-delivery-files")
    .getByRole("button", { name: /preview\.md/ })
    .first();
  await expect(file).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await composer.fill("An unsent draft");
  await file.click();
  const tab = page.getByRole("tab", { name: "preview.md", exact: true });
  const content = page.getByRole("tabpanel", { name: "preview.md" });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(content.getByRole("heading", { name: "Project preview" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(composer).toBeHidden();
  await captureScreenshot(page, testInfo, "markdown-document-tab");

  await page.getByRole("tab", { name: "主会话", exact: true }).click();
  await expect(composer).toHaveValue("An unsent draft");
  await file.click();
  await expect(tab).toHaveCount(1);
  await page.getByRole("button", { name: "Close preview preview.md", exact: true }).click();
  await expect(tab).toHaveCount(0);
  await expect(composer).toHaveValue("An unsent draft");
});
