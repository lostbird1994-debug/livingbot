import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const ROW_HEIGHT = 22;
const VISIBLE_TURNS = 25;

test("reflow keeps the visible timestamp still even when the reader was at the tail", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1080, height: 500 });
  await page.goto("/e2e/fixtures/chat-turn-rail.html");
  const scroller = page.getByTestId("transcript");
  await expect(scroller.locator("[data-message-id]")).toHaveCount(56);
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  // Wait for the scroll/scrollend handlers to establish the tail position.
  await expect.poll(() => scroller.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeLessThan(1);
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  ));
  const anchor = await scroller.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>(
      "[data-message-id], [data-testid=time-separator]",
    )].find((row) => row.getBoundingClientRect().bottom > top)!;
    row.dataset.resizeTestAnchor = "true";
    return row.getBoundingClientRect().top - top;
  });
  await page.setViewportSize({ width: 420, height: 500 });
  await expect.poll(() => scroller.evaluate((element) => {
    const row = element.querySelector<HTMLElement>("[data-resize-test-anchor]")!;
    return row.getBoundingClientRect().top - element.getBoundingClientRect().top;
  }).then((offset) => Math.abs(offset - anchor))).toBeLessThan(1);
  expect(await scroller.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeGreaterThan(1);
  await page.setViewportSize({ width: 1080, height: 500 });
  await expect.poll(() => scroller.evaluate((element) => {
    const row = element.querySelector<HTMLElement>("[data-resize-test-anchor]")!;
    return row.getBoundingClientRect().top - element.getBoundingClientRect().top;
  })).toBeCloseTo(anchor, 0);
});

test("the margin names each turn and gives way on a narrow window", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1080, height: 820 });
  await page.goto("/e2e/fixtures/chat-turn-rail.html");
  const rail = page.getByTestId("turn-rail");
  const list = page.getByTestId("turn-rail-list");
  const items = rail.locator("[data-turn-id]");
  await expect(items).toHaveCount(28);

  // At most twenty-five fit; the rest live in the list's own scroll.
  expect(await list.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(
    VISIBLE_TURNS * ROW_HEIGHT + 1,
  );
  expect(await list.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
    VISIBLE_TURNS * ROW_HEIGHT,
  );
  await expect(rail.locator("[aria-current=location]")).toHaveCount(1);
  await captureScreenshot(page, testInfo, "turn-rail-wide");

  // A name opens its turn at the top of the viewport and becomes the current one.
  const target = items.nth(3);
  const targetId = await target.getAttribute("data-turn-id");
  await target.click();
  await expect(rail.locator("[aria-current=location]")).toHaveAttribute(
    "data-turn-id",
    targetId ?? "",
  );
  const scroller = page.getByTestId("transcript");
  const offset = await page.evaluate((id) => {
    const scroll = document.querySelector("[data-testid=transcript]");
    const row = document.querySelector(`[data-message-id="${id}"]`);
    if (!scroll || !row) return null;
    return Math.round(row.getBoundingClientRect().top - scroll.getBoundingClientRect().top);
  }, targetId);
  expect(offset).not.toBeNull();
  expect(offset!).toBeLessThan(40);
  await expect(scroller).toBeVisible();

  // Too narrow for both: the column takes no lane at all and the text stays centred.
  await page.setViewportSize({ width: 760, height: 820 });
  await expect(rail).toHaveCSS("width", "0px");
  await captureScreenshot(page, testInfo, "turn-rail-narrow");
});

test("the saved count controls the visible rows and the switch releases the margin", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1080, height: 820 });
  await page.addInitScript(() => {
    localStorage.setItem("rakazo.turnTitleCount", "5");
  });
  await page.goto("/e2e/fixtures/chat-turn-rail.html");
  const list = page.getByTestId("turn-rail-list");
  await expect(list).toHaveCSS("max-height", "110px");
  await captureScreenshot(page, testInfo, "turn-rail-five");
  await page.evaluate(() => {
    localStorage.setItem("rakazo.showTurnTitles", "off");
  });
  await page.reload();
  await expect(page.getByTestId("turn-rail")).toHaveCount(0);
  const reserved = await page
    .getByTestId("transcript")
    .evaluate((element) => getComputedStyle(element).getPropertyValue("--rk-rail-end").trim());
  expect(reserved).toBe("0px");
});
