import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
) as {
  productName?: string;
  build?: { productName?: string; publish?: unknown[] };
};

describe("desktop package metadata", () => {
  it("shares the customer-facing name between Electron and electron-builder", () => {
    expect(packageJson.productName).toBe("LivingBot");
    expect(packageJson.build?.productName).toBeUndefined();
  });
});

it("has no inherited desktop publishing feed", () => {
  expect(packageJson.build?.publish).toEqual([]);
});
it("disables mobile OTA and detaches the upstream Expo project", () => {
  const mobile = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "../../mobile/app.json"), "utf8"),
  ).expo;
  expect(mobile.name).toBe("LivingBot");
  expect(mobile.updates.enabled).toBe(false);
  expect(mobile.updates.url).toBeUndefined();
  expect(mobile.extra.eas).toBeUndefined();
  expect(mobile.owner).toBeUndefined();
});
