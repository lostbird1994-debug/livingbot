import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("agent-attached files appear as cards with previews and downloads", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `artifact-card-${stamp}@livingbot.test`, "password12", "Artifact Card");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("write notes/result.txt and attach it to the thread");
  await page.keyboard.press("Enter");

  const fileCard = page
    .getByTestId("message-delivery-files")
    .getByRole("button", { name: /result\.txt/ })
    .first();
  await expect(fileCard).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "current-file-card");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "result.txt 的操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "下载", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("result.txt");

  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });
  await composer.fill(
    "write path notes/preview.md and attach it to the thread says # Project preview",
  );
  await page.keyboard.press("Enter");

  const previewButton = page
    .locator('[data-testid="message-delivery-files"] button[title="preview.md"]')
    .first();
  await expect(previewButton).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "markdown-file-card");
  let releasePreview = () => {};
  const previewReady = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  await page.route("**/rpc/artifacts/get", async (route) => {
    await previewReady;
    await route.continue();
  });
  await previewButton.click();

  const document = page.getByRole("tabpanel", { name: "preview.md" });
  await expect(document).toBeVisible();
  await expect(document.getByRole("status", { name: "Loading preview…" })).toBeVisible();
  await expect(document).not.toContainText("Loading preview…");
  await captureScreenshot(page, testInfo, "markdown-preview-loading-spinner");
  releasePreview();
  await expect(document.getByRole("heading", { name: "Project preview" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "preview.md", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await captureScreenshot(page, testInfo, "markdown-preview-open");

  await page.getByRole("button", { name: "Close preview preview.md", exact: true }).click();
  await expect(document).toHaveCount(0);
  await expect(previewButton).toBeVisible();

  const markdownDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "preview.md 的操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "下载", exact: true }).click();
  const markdownDownload = await markdownDownloadPromise;
  expect(markdownDownload.suggestedFilename()).toBe("preview.md");

  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });
  await page.locator('input[type="file"]').setInputFiles({
    name: "page.html",
    mimeType: "text/html",
    buffer: Buffer.from(
      "<h1>Rendered page</h1><p id=ran></p><script>document.getElementById('ran').textContent = 'script ran'</script>",
    ),
  });
  await composer.fill("Review the attached HTML.");
  await page.keyboard.press("Enter");

  const htmlPreviewButton = page.getByRole("button", { name: "Preview page.html" });
  await expect(htmlPreviewButton).toBeVisible({ timeout: 30_000 });
  await htmlPreviewButton.click();

  const htmlDialog = page.getByRole("dialog", { name: "page.html" });
  await expect(htmlDialog).toBeVisible();
  // The viewer loads the network shell, which renders the document in a nested sandboxed frame.
  const shell = htmlDialog.locator('iframe[title="page.html"]');
  await expect(shell).toHaveAttribute("src", "/html-viewer.html");
  const preview = shell.contentFrame().locator("iframe#preview").contentFrame();
  await expect(preview.getByRole("heading", { name: "Rendered page" })).toBeVisible();
  await expect(preview.getByText("script ran")).toBeVisible();
  // The preview's opaque origin keeps it away from the app's storage and DOM.
  expect(await preview.locator("body").evaluate(() => window.origin)).toBe("null");
  await captureScreenshot(page, testInfo, "html-preview-open");
});
