import { mkdtemp, mkdir, realpath, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { moveNativePathToTrash } from "./desktop-workspace-cleanup.js";
import { LocalAgentHomeStore, STALE_STAGING_MS } from "./home.js";

vi.mock("./desktop-workspace-cleanup.js", () => ({ moveNativePathToTrash: vi.fn(async () => {}) }));

it("sends stale startup staging to recoverable cleanup and retains fresh staging", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "kernel-home-trash-test-")));
  const stale = path.join(root, "staging", "rakazo-workspace-stale");
  const fresh = path.join(root, "staging", "rakazo-workspace-fresh");
  await mkdir(stale, { recursive: true });
  await mkdir(fresh);
  await writeFile(path.join(stale, "retained.txt"), "recoverable evidence");
  const now = Date.now();
  const old = new Date(now - STALE_STAGING_MS - 1000);
  await utimes(stale, old, old);
  const cleanup = vi.mocked(moveNativePathToTrash);
  cleanup.mockClear();
  await new LocalAgentHomeStore(root).removeStaleStaging(now);
  expect(cleanup).toHaveBeenCalledWith(stale);
  expect(cleanup).not.toHaveBeenCalledWith(fresh);
  expect((await stat(path.join(stale, "retained.txt"))).isFile()).toBe(true);
  cleanup.mockImplementation(async file => {
    if (file === stale) throw Error("Trash is unavailable");
  });
  await expect(new LocalAgentHomeStore(root).removeStaleStaging(now)).rejects.toThrow("Trash is unavailable");
  expect((await stat(path.join(stale, "retained.txt"))).isFile()).toBe(true);
});
