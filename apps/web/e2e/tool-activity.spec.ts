import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/tool-activity.html";
const REPLY_TEXT = "Tuesday at 2 pm is free.";
const NOTE_TEXT = "Anna is free all Tuesday afternoon.";
const STORAGE_KEY = "rakazo.showToolActivity";

const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];

async function openThread(page: Page, phase: "live" | "done") {
  await page.goto(`${fixture}?view=thread&phase=${phase}`);
  await expect(page.getByTestId("message-user-bubble")).toBeVisible();
}

/** Cards stay hidden until this browser saved "on". Seed only when a test needs them visible. */
async function seedToolActivityOn(page: Page) {
  await page.addInitScript((key) => {
    if (localStorage.getItem(key) == null) localStorage.setItem(key, "on");
  }, STORAGE_KEY);
}

async function setToggle(page: Page, on: boolean) {
  await page.goto(`${fixture}?view=settings`);
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  const toggle = settings.getByTestId("tool-activity-toggle");
  await expect(toggle).toBeVisible();
  if (on) await expect(toggle).not.toBeChecked();
  else await expect(toggle).toBeChecked();
  await toggle.click();
  if (on) await expect(toggle).toBeChecked();
  else await expect(toggle).not.toBeChecked();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY))
    .toBe(on ? "on" : "off");
  await toggle.scrollIntoViewIfNeeded();
}

test("tool activity shows for live and finished runs when the user turned it on", async ({
  page,
}, testInfo) => {
  await seedToolActivityOn(page);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);

    await openThread(page, "live");
    const liveLine = page.getByTestId("tool-activity-line");
    await expect(liveLine).toHaveCount(1);
    await expect(page.getByTestId("message-bot-bubble")).toHaveCount(0);
    const liveCard = page.getByTestId("tool-activity");
    await expect(liveCard.locator(":scope > button")).toHaveAttribute("aria-expanded", "true");
    await expect(liveCard.locator(":scope > button")).toContainText(/Working…\s*8 tools/);
    await expect(page.getByTestId("tool-rows-hidden")).toHaveCount(0);
    await expect(page.getByTestId("tool-rows")).toContainText("memory-organization.ts");
    await expect(page.getByTestId("tool-rows")).toContainText("invoice");
    await expect(page.getByTestId("tool-step-note")).toHaveCount(0);
    await expect(page.getByTestId("tool-step").last()).toHaveAttribute("data-running", "true");
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
    await captureScreenshot(page, testInfo, `default-live-${viewport.name}`);

    await liveCard.locator(":scope > button").click();
    await expect(liveCard.locator(":scope > button")).toHaveAttribute("aria-expanded", "false");

    await openThread(page, "done");
    await expect(page.getByTestId("message-bot-bubble")).toContainText(REPLY_TEXT);
    const doneCard = page.getByTestId("tool-activity");
    await expect(doneCard).toHaveCount(1);
    await expect(doneCard.locator(":scope > button")).toHaveAttribute("aria-expanded", "false");
    await doneCard.locator(":scope > button").click();
    await expect(doneCard.locator(":scope > button")).toHaveAttribute("aria-expanded", "true");
    await expect(doneCard.locator(":scope > button")).toContainText(/Completed\s*1m\s*28s/);
    await expect(page.getByTestId("tool-rows-hidden")).toHaveCount(0);
    await expect(doneCard).toContainText("memory-organization.ts");
    await expect(doneCard).toContainText("invoice");
    await expect(doneCard.getByText(NOTE_TEXT)).toBeVisible();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
    await captureScreenshot(page, testInfo, `default-done-open-${viewport.name}`);

    await doneCard.locator(":scope > button").click();
    await expect(doneCard.locator(":scope > button")).toHaveAttribute("aria-expanded", "false");
  }
});

test("the settings toggle hides and restores tool activity", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  // Nothing saved leaves the switch off and the cards hidden.
  await page.goto(`${fixture}?view=settings`);
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  const initialToggle = settings.getByTestId("tool-activity-toggle");
  await expect(initialToggle).toBeVisible();
  await expect(initialToggle).not.toBeChecked();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY))
    .toBeNull();
  await initialToggle.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "settings-tool-activity-off");

  await openThread(page, "done");
  await expect(page.getByTestId("message-bot-bubble")).toContainText(REPLY_TEXT);
  await expect(page.getByTestId("tool-activity")).toHaveCount(0);
  await expect(page.getByText(/Done\s*8 tools/)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "off-done");

  await openThread(page, "live");
  await expect(page.getByTestId("tool-activity")).toHaveCount(0);
  await expect(page.getByTestId("tool-activity-line")).toHaveCount(0);
  await expect(page.getByTestId("message-bot-bubble")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "off-live");

  await setToggle(page, true);
  await captureScreenshot(page, testInfo, "settings-tool-activity-on");

  await openThread(page, "done");
  await expect(page.getByTestId("tool-activity")).toHaveCount(1);
  await expect(page.getByTestId("tool-activity").locator(":scope > button")).toContainText(
    /Completed\s*1m\s*28s/,
  );
  await captureScreenshot(page, testInfo, "on-again-done");
});

test("provider reasoning is separate from the reply and follows execution visibility", async ({
  page,
}, testInfo) => {
  await seedToolActivityOn(page);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto(`${fixture}?phase=live&reasoning=true`);
    const reasoning = page.getByTestId("reasoning-activity");
    await expect(reasoning).toHaveCount(3);
    await expect(reasoning.first().locator(":scope > button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(reasoning.last().locator(":scope > button")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(
      page.getByText("I will inspect the sources before choosing a time."),
    ).toBeVisible();
    await expect(page.getByTestId("tool-step")).toHaveCount(8);
    const liveBody = reasoning.last().getByTestId("reasoning-content");
    await expect(liveBody).toBeVisible();
    expect(await liveBody.evaluate((node) => node.clientHeight)).toBeLessThanOrEqual(200);
    expect(await liveBody.evaluate((node) => node.scrollHeight)).toBeGreaterThan(200);
    await captureScreenshot(page, testInfo, `reasoning-live-${viewport.name}`);
    await page.goto(`${fixture}?phase=done&reasoning=true`);
    const process = page.getByTestId("tool-activity");
    await expect(process.locator(":scope > button")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("message-bot-bubble")).toContainText(REPLY_TEXT);
    await captureScreenshot(page, testInfo, `reasoning-done-folded-${viewport.name}`);
    await process.locator(":scope > button").click();
    await expect(reasoning.first().locator(":scope > button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(
      page.getByText("The sources confirm Tuesday afternoon is available."),
    ).toBeVisible();
    const operations = page.getByTestId("tool-operation-group").first();
    await expect(operations.locator(":scope > button")).toHaveAttribute("aria-expanded", "false");
    await expect(operations.locator(":scope > button")).toContainText("memory-organization.ts");
    await operations.locator(":scope > button").click();
    const command = operations.getByTestId("tool-step").last();
    await command.locator(":scope > button").click();
    await expect(command.locator("pre")).toHaveText("git diff --stat");
    await expect(command.locator("pre")).toBeVisible();
    await operations.locator(":scope > button").click();
    await reasoning.first().locator(":scope > button").click();
    const body = reasoning.first().getByTestId("reasoning-content");
    await expect(body).toBeVisible();
    expect(await body.evaluate((node) => node.clientHeight)).toBeLessThanOrEqual(200);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
    await captureScreenshot(page, testInfo, `reasoning-done-${viewport.name}`);
  }
  await setToggle(page, false);
  await page.goto(`${fixture}?phase=done&reasoning=true`);
  await expect(page.getByRole("button", { name: "Deep thought", exact: true })).toHaveCount(0);
  await expect(page.getByText("I will check the calendar before choosing a time.")).toHaveCount(0);
  await expect(page.getByTestId("message-bot-bubble")).toContainText(REPLY_TEXT);
});
