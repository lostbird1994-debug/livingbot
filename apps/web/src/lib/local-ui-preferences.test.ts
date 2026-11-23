// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
beforeEach(() => { vi.resetModules(); localStorage.clear(); });
it("restores durable settings across a new origin cache and never writes defaults over saved choices", async () => {
  const p = await import("./local-ui-preferences");
  const save = vi.fn().mockResolvedValue({}); const apply = vi.fn();
  p.hydrateLocalUiPreferences({ "rakazo.uiAppearance": "dark", "rakazo.showToolActivity": "on" }, save, apply, vi.fn());
  expect(apply).toHaveBeenCalledWith("rakazo.uiAppearance", "dark");
  expect(apply).toHaveBeenCalledWith("rakazo.showToolActivity", "on");
  expect(save).not.toHaveBeenCalled();
  p.persistLocalUiPreference("rakazo.showToolActivity", "off");
  p.persistLocalUiPreference("rakazo.showToolActivity", "on");
  await p.flushLocalUiPreferences();
  expect(save.mock.calls.map(([patch]) => patch)).toEqual([{ "rakazo.showToolActivity": "off" }, { "rakazo.showToolActivity": "on" }]);
});
it("a late bootstrap cannot overwrite a newer choice and failures are reported", async () => {
  const p = await import("./local-ui-preferences");
  const apply = vi.fn(); const failed = vi.fn(); const read = p.uiPreferenceRevision();
  p.persistLocalUiPreference("rakazo.uiAppearance", "dark");
  p.hydrateLocalUiPreferences({ "rakazo.uiAppearance": "light" }, vi.fn().mockRejectedValue(new Error("offline")), apply, failed, read);
  expect(apply).not.toHaveBeenCalled();
  await expect(p.flushLocalUiPreferences()).rejects.toThrow("offline");
  await Promise.resolve(); expect(failed).toHaveBeenCalled();
});
