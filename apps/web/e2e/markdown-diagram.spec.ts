import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/markdown-diagram.html";

test("raw widgets run local controls inside an opaque frame, export and review follow-ups", async ({
  page,
}, testInfo) => {
  await page.goto(`${fixture}?case=widget&theme=light`);
  const card = page.getByTestId("inline-widget");
  const inner = card
    .frameLocator('iframe[title="Widget demo"]')
    .frameLocator('iframe[title="Visual"]');
  await expect(inner.locator("#isolation")).toHaveText("Isolated");
  await expect(card.getByText("This must not enter the composer automatically")).toHaveCount(0);
  await inner.getByRole("button", { name: "Increment" }).click();
  await expect(inner.locator("#count")).toHaveText("1");
  await inner.locator("#quantity").fill("7");
  await expect(inner.locator("#total")).toHaveText("21");
  await inner.getByRole("button", { name: /Explain the next stage/ }).click();
  await expect(card.getByText("Explain the next stage", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.addEventListener("livingbot:visual-reference", (event) => {
      (window as unknown as { visualReference: unknown }).visualReference = (
        event as CustomEvent
      ).detail;
    });
  });
  await card.getByRole("button", { name: "Add to conversation", exact: true }).first().click();
  expect(
    await page.evaluate(() => (window as unknown as { visualReference: unknown }).visualReference),
  ).toEqual({ text: "Explain the next stage" });
  const png = page.waitForEvent("download");
  await card.getByRole("button", { name: "Download image" }).click();
  expect((await png).suggestedFilename()).toBe("Widget_demo.png");
  const html = page.waitForEvent("download");
  await card.getByRole("button", { name: "Download", exact: true }).click();
  expect((await html).suggestedFilename()).toBe("Widget_demo.html");
  await card.getByRole("button", { name: "View source" }).click();
  await expect(card.locator("pre")).toContainText("getElementById");
  await card.getByRole("button", { name: "Expand diagram" }).click();
  await expect(
    page
      .getByRole("dialog")
      .frameLocator('iframe[title="Widget demo"]')
      .frameLocator('iframe[title="Visual"]')
      .locator("#isolation"),
  ).toHaveText("Isolated");
  await page.keyboard.press("Escape");
  await captureScreenshot(page, testInfo, "interactive-widget-light");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expect(inner.locator("#isolation")).toHaveText("Isolated");
  await captureScreenshot(page, testInfo, "interactive-widget-dark");
});

test("Bot documents use the transcript width and colored comparisons reflow on phones", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${fixture}?case=response&theme=light`);
  const body = page.getByTestId("message-bot-bubble");
  await expect(page.getByTestId("message-bot-heading")).toContainText("Chief");
  await expect(body.locator(".rk-inline-comparison-column")).toHaveCount(2);
  expect((await body.boundingBox())!.width).toBeGreaterThan(1000);
  expect(await body.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
    "rgba(0, 0, 0, 0)",
  );
  const columns = body.locator(".rk-inline-comparison-column");
  const left = (await columns.nth(0).boundingBox())!;
  const right = (await columns.nth(1).boundingBox())!;
  expect(Math.abs(left.y - right.y)).toBeLessThan(2);
  const lightFill = await columns.nth(0).evaluate((node) => getComputedStyle(node).backgroundColor);
  await page.getByTestId("message-bot-heading").scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "bot-document-light");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expect
    .poll(() => columns.nth(0).evaluate((node) => getComputedStyle(node).backgroundColor))
    .not.toBe(lightFill);
  await captureScreenshot(page, testInfo, "bot-document-dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await columns.nth(0).scrollIntoViewIfNeeded();
  expect((await columns.nth(1).boundingBox())!.y).toBeGreaterThan(
    (await columns.nth(0).boundingBox())!.y,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await captureScreenshot(page, testInfo, "bot-document-phone");
});

test("inline explanations change steps locally, expand and export SVG", async ({
  page,
}, testInfo) => {
  await page.goto(`${fixture}?case=explanation&theme=light`);
  const visual = page.getByTestId("inline-visual");
  await expect(visual.getByRole("img")).toBeVisible();
  await visual.getByRole("combobox").selectOption("1");
  await expect(visual).toContainText("The service checks the request");
  await visual.getByRole("button", { name: "Expand diagram" }).click();
  await expect(page.getByRole("dialog").getByRole("img")).toHaveAttribute(
    "alt",
    /Return the answer/,
  );
  await page.keyboard.press("Escape");
  await captureScreenshot(page, testInfo, "inline-explanation-light");
  const download = await Promise.all([
    page.waitForEvent("download"),
    visual.getByRole("link", { name: "Download SVG" }).click(),
  ]);
  expect(download[0].suggestedFilename()).toBe("diagram.svg");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture}?case=explanation`);
  await expect(page.getByTestId("inline-visual").getByRole("img")).toBeVisible();
  expect(
    await page
      .getByTestId("inline-visual")
      .getByRole("img")
      .evaluate((image) => image.getBoundingClientRect().width),
  ).toBeGreaterThanOrEqual(544);
  expect(
    await page
      .getByTestId("inline-visual")
      .getByRole("region")
      .evaluate((region) => region.scrollWidth > region.clientWidth),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await captureScreenshot(page, testInfo, "inline-explanation-dark-phone");
});

const flowSource = [
  "graph LR",
  "  A[Clone repo] --> B[Branch] --> C[Tests] --> D[Pull request]",
].join("\n");

async function streamUpdate(page: Page, markdown: string, streaming: boolean) {
  await page.evaluate(
    (detail) => {
      window.dispatchEvent(new CustomEvent("rk-diagram-stream-update", { detail }));
    },
    { markdown, streaming },
  );
}

async function diagramMarkup(page: Page) {
  const src = await page.getByTestId("chat-diagram").locator("img").getAttribute("src");
  return decodeURIComponent(src?.slice(src.indexOf(",") + 1) ?? "");
}

async function expectDrawn(page: Page) {
  const image = page.getByTestId("chat-diagram").locator("img");
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth))
    .toBeGreaterThan(0);
  return image;
}

test("a mermaid fence is drawn as a themed, copyable diagram in place of its code block", async ({
  page,
}, testInfo) => {
  await page.goto(fixture);
  const message = page.getByTestId("diagram-fixture");
  const image = await expectDrawn(page);

  await expect(image).toHaveAttribute("alt", "Diagram");
  await expect(image).toHaveAttribute("src", /^data:image\/svg\+xml;/);
  await expect(message.locator("pre")).toHaveCount(0);
  await expect(message.getByText("graph LR")).toHaveCount(0);
  const text = await message.innerText();
  expect(text.indexOf("Here is the contribution flow:")).toBeLessThan(
    text.indexOf("Each step runs in CI."),
  );
  const drawnText = (await diagramMarkup(page)).replace(/<[^>]+>/g, "");
  for (const label of ["Clone repo", "Branch", "Tests", "Pull request"]) {
    expect(drawnText).toContain(label);
  }
  const frame = await message.boundingBox();
  const drawn = await image.boundingBox();
  expect(drawn!.width).toBeLessThanOrEqual(frame!.width);

  await captureScreenshot(page, testInfo, "markdown-diagram-dark");

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy diagram source" }).click();
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(flowSource);
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();

  expect(await diagramMarkup(page)).toContain("fill:#F5F5F5");
  await page.goto(`${fixture}?theme=light`);
  await expectDrawn(page);
  expect(await diagramMarkup(page)).toContain("fill:#1C1C1C");
  await captureScreenshot(page, testInfo, "markdown-diagram-light");

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expect.poll(() => diagramMarkup(page)).toContain("fill:#F5F5F5");
});

test("a wide diagram scrolls on a phone instead of shrinking its text away", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture}?case=wide`);
  const image = await expectDrawn(page);
  const natural = await image.evaluate((node: HTMLImageElement) => node.width && node.naturalWidth);
  const shown = (await image.boundingBox())!.width;
  expect(shown).toBeGreaterThanOrEqual(Math.floor(natural * 0.8) - 1);
  const card = page.getByTestId("chat-diagram");
  expect(await card.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await captureScreenshot(page, testInfo, "markdown-diagram-wide-phone");
});

test("Mermaid loads only for a message with a diagram", async ({ page }) => {
  // The library itself, not this package's own mermaid*.ts modules or the fixture.
  const libraryRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/mermaid/i.test(path) && !/chat-ui\/src\/|e2e\/fixtures\//.test(path)) {
      libraryRequests.push(path);
    }
  });
  await page.goto(`${fixture}?case=plain`);
  await expect(page.getByTestId("diagram-fixture").locator("pre")).toContainText("const ok");
  expect(libraryRequests).toEqual([]);

  await streamUpdate(page, `\`\`\`mermaid\n${flowSource}\n\`\`\``, false);
  await expectDrawn(page);
  expect(libraryRequests.length).toBeGreaterThan(0);
});

test("partial widget code stays inert until the completed fence is committed", async ({ page }) => {
  await page.goto(`${fixture}?case=plain`);
  const code =
    '<div id="partial">Preview</div><script>document.getElementById("partial").textContent="Executed"</script>';
  const raw = JSON.stringify({ title: "Progressive", widget_code: code });
  await streamUpdate(page, `\`\`\`show_widget\n${raw.slice(0, -2)}`, true);
  const inner = page
    .getByTestId("inline-widget")
    .frameLocator('iframe[title="Progressive"]')
    .frameLocator('iframe[title="Visual"]');
  await expect(inner.locator("#partial")).toHaveText("Preview");
  await streamUpdate(page, `\`\`\`show_widget\n${raw}\n\`\`\``, false);
  await expect(inner.locator("#partial")).toHaveText("Executed");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download image" }).click();
  expect((await download).suggestedFilename()).toBe("Progressive.png");
});

test("raw SVG exports a PNG and retains its accessible labels", async ({ page }) => {
  await page.goto(`${fixture}?case=plain`);
  const raw = JSON.stringify({ title: "SVG export", widget_code: '<svg viewBox="0 0 680 160" role="img" aria-label="Request to reply"><rect x="20" y="20" width="240" height="100" rx="12" fill="var(--blueFill)"/><text x="140" y="70" text-anchor="middle" class="t">Request</text><path d="M280 70H600" stroke="var(--color-text-primary)"/></svg>' });
  await streamUpdate(page, `\`\`\`show_widget\n${raw}\n\`\`\``, false);
  await expect(page.getByTestId("inline-widget").frameLocator('iframe[title="SVG export"]').frameLocator('iframe[title="Visual"]').getByRole("img", { name: "Request to reply" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download image" }).click();
  expect((await download).suggestedFilename()).toBe("SVG_export.png");
});
