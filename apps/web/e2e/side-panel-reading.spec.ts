import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

for (const scenario of [
  { width: 1470, chat: "default", size: "default", overlay: false },
  { width: 1470, chat: "wide", size: "default", overlay: true },
  { width: 1100, chat: "default", size: "default", overlay: true },
  { width: 1470, chat: "default", size: "largest", overlay: true },
  { width: 1800, chat: "wide", size: "default", overlay: false },
]) {
  test(`side panel preserves paragraphs at ${scenario.width}/${scenario.chat}/${scenario.size}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: 850 });
    await page.goto("/e2e/fixtures/side-panel-reading.html");
    const scroller = page.getByTestId("transcript");
    await expect(scroller.locator("[data-message-id]")).toHaveCount(24);
    await page.getByRole("combobox", { name: "Chat width" }).selectOption(scenario.chat);
    await page.getByRole("combobox", { name: "Text size" }).selectOption(scenario.size);
    const row = scroller.locator('[data-message-id="reading-5-bot"]');
    await row.evaluate((element) => element.scrollIntoView({ block: "start" }));
    await expect(row).toBeInViewport();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    // Sample the interior of one long message and the messages below it, not only its top edge.
    const baseline = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="transcript"]')!;
      const row = scroller.querySelector<HTMLElement>('[data-message-id="reading-5-bot"]')!;
      return {
        scroll: scroller.scrollTop,
        paragraphs: [...row.querySelectorAll("p")].map((element) => {
          const rect = element.getBoundingClientRect();
          return { y: rect.y, height: rect.height, width: rect.width };
        }),
      };
    });
    expect(baseline.paragraphs.length).toBeGreaterThanOrEqual(4);
    const panel = page.getByTestId("side-panel");
    for (const open of [true, false, true, false]) {
      const samples = await page.evaluate(async () => {
        const scroller = document.querySelector<HTMLElement>('[data-testid="transcript"]')!;
        const row = scroller.querySelector<HTMLElement>('[data-message-id="reading-5-bot"]')!;
        const button = [...document.querySelectorAll("button")].find(
          (element) => element.textContent === "Toggle panel",
        )!;
        button.click();
        const samples: Array<{
          scroll: number;
          paragraphs: Array<{ y: number; height: number; width: number }>;
        }> = [];
        const started = performance.now();
        await new Promise<void>((resolve) => {
          function sample() {
            samples.push({
              scroll: scroller.scrollTop,
              paragraphs: [...row.querySelectorAll("p")].map((element) => {
                const rect = element.getBoundingClientRect();
                return { y: rect.y, height: rect.height, width: rect.width };
              }),
            });
            if (performance.now() - started < 300) requestAnimationFrame(sample);
            else resolve();
          }
          requestAnimationFrame(sample);
        });
        return samples;
      });
      for (const sample of samples) {
        expect(Math.abs(sample.scroll - baseline.scroll)).toBeLessThan(1);
        sample.paragraphs.forEach((paragraph, index) => {
          const original = baseline.paragraphs[index]!;
          expect(Math.abs(paragraph.y - original.y)).toBeLessThan(1);
          expect(Math.abs(paragraph.height - original.height)).toBeLessThan(1);
          expect(Math.abs(paragraph.width - original.width)).toBeLessThan(1);
        });
      }
      if (open) {
        expect(await panel.getAttribute("data-overlay")).toBe(scenario.overlay ? "true" : null);
        await captureScreenshot(
          page,
          testInfo,
          `reading-${scenario.width}-${scenario.chat}-${scenario.size}`,
        );
      }
    }
  });
}
