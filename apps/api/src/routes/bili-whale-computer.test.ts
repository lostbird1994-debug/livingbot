import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BILI_WHALE_FILE_SCRIPT } from "./bili-whale-computer.js";

// Execute the production script against an in-memory computer: no real files or processes.
const root = "/computer/bots/bot-1";
const project = `${root}/bili-whale`;
const config = `${project}/config.json`;
const credentials = `${project}/data/home/.bili-ai/credentials.json`;
const plan = `${project}/data/whale-night.json`;
const inputName = "12345678-abcd.json";
const inputFile = `${project}/data/.rakazo-settings/${inputName}`;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
const script = BILI_WHALE_FILE_SCRIPT.replace('await import("node:fs/promises")', "__fs")
  .replace('await import("node:path")', "__path")
  .replace('await import("node:crypto")', "__crypto")
  .replace('await import("node:url")', "__url")
  .replace(
    'await import(pathToFileURL(path.join(project, "tools/lib/night-config.mjs")))',
    "__nightConfig",
  )
  .replace(
    'await import(pathToFileURL(path.join(project, "tools/lib/night-plan.mjs")))',
    "__nightPlan",
  );

function computer(initial: Record<string, unknown> = {}) {
  const files = new Map<string, string>([
    [`${project}/bili`, "fixture"],
    ...Object.entries(initial).map(
      ([key, value]) =>
        [key, typeof value === "string" ? value : JSON.stringify(value)] as [string, string],
    ),
  ]);
  const modes = new Map<string, number>();
  const directories = new Set([
    root,
    project,
    `${project}/data`,
    `${project}/data/.rakazo-settings`,
  ]);
  const resolve = (file: string) => path.posix.resolve(root, file);
  const missing = () => Object.assign(new Error("File not found"), { code: "ENOENT" });
  const fs = {
    realpath: vi.fn(async (file: string) => {
      const absolute = resolve(file);
      if (files.has(absolute) || directories.has(absolute)) return absolute;
      throw missing();
    }),
    readFile: vi.fn(async (file: string) => {
      const raw = files.get(resolve(file));
      if (raw === undefined) throw missing();
      return raw;
    }),
    stat: vi.fn(async (file: string) => {
      if (!files.has(resolve(file))) throw missing();
      return { isFile: () => true };
    }),
    mkdir: vi.fn(async (directory: string) => {
      directories.add(resolve(directory));
    }),
    writeFile: vi.fn(
      async (file: string, value: string, options: { flag?: string; mode?: number }) => {
        const absolute = resolve(file);
        if (options.flag === "wx" && files.has(absolute)) throw Error("Already exists");
        files.set(absolute, value);
        if (options.mode) modes.set(absolute, options.mode);
      },
    ),
    chmod: vi.fn(async (file: string, mode: number) => {
      modes.set(resolve(file), mode);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      files.set(resolve(to), files.get(resolve(from))!);
      if (modes.has(resolve(from))) modes.set(resolve(to), modes.get(resolve(from))!);
      files.delete(resolve(from)); // Virtual map only; does not remove any filesystem entry.
    }),
  };
  const historyOf = vi.fn((state: Record<string, unknown>) => ({
    schema: 2,
    date: state.date,
    wakes: state.wakes ?? 0,
    usedCount: state.usedCount ?? {},
    skippedWindows: state.skippedWindows ?? [],
    wokeAt: state.wokeAt ?? null,
  }));
  const makePlan = vi.fn((_cfg, state) =>
    Number(state.wakes) >= 1
      ? { ...state, action: "done", reason: "Daily quota used" }
      : { ...state, action: "wake", atMs: Date.now() + 60_000, endsAt: Date.now() + 120_000 },
  );
  async function run(action: string, input?: object) {
    if (input) files.set(inputFile, JSON.stringify(input));
    const log = vi.fn();
    await new AsyncFunction(
      "process",
      "console",
      "__fs",
      "__path",
      "__crypto",
      "__url",
      "__nightConfig",
      "__nightPlan",
      script,
    )(
      { argv: ["node", action, inputName], env: {} },
      { log },
      fs,
      { ...path.posix, resolve },
      { randomUUID: () => "fixture-nonce" },
      { pathToFileURL: (value: string) => value },
      { readNightConfig: () => ({}) },
      { historyOf, makePlan },
    );
    return JSON.parse(log.mock.lastCall![0]);
  }
  return { files, modes, fs, run, makePlan, historyOf };
}

describe("bili-whale computer operations", () => {
  it("preserves nested fields and unknown top-level configuration", async () => {
    const vm = computer({
      [config]: {
        persona: { name: "Old", diaryTitle: "Diary" },
        listen: { liveRoom: "12345", dmIntervalSec: 300, scope: "owner", oncePerPerson: false },
        share: { aiCommentGuard: true, aiThreshold: 50 },
        risk: { readHourly: 200 },
      },
    });
    await vm.run("settings", {
      persona: { name: "New" },
      listen: { live: true },
      share: { enabled: false },
    });
    expect(JSON.parse(vm.files.get(config)!)).toEqual({
      persona: { name: "New", diaryTitle: "Diary" },
      listen: {
        live: true,
        liveRoom: "12345",
        dmIntervalSec: 300,
        scope: "owner",
        oncePerPerson: false,
      },
      share: { enabled: false, aiCommentGuard: true, aiThreshold: 50 },
      risk: { readHourly: 200 },
    });
  });

  it("refuses corrupt configuration without replacing it", async () => {
    const vm = computer({ [config]: "{broken" });
    await expect(vm.run("settings", { persona: { name: "New" } })).rejects.toThrow();
    expect(vm.files.get(config)).toBe("{broken");
    expect(vm.fs.rename).not.toHaveBeenCalled();
  });

  it("preserves blank credential fields and never returns their contents", async () => {
    const vm = computer({
      [credentials]: {
        sessdata: "old-session",
        bili_jct: "csrf-fixture",
        buvid3: "device-fixture",
      },
    });
    expect(
      await vm.run("credentials", { sessdata: "new-session", bili_jct: "", buvid3: "" }),
    ).toEqual({ ok: true });
    expect(JSON.parse(vm.files.get(credentials)!)).toEqual({
      sessdata: "new-session",
      bili_jct: "csrf-fixture",
      buvid3: "device-fixture",
    });
    expect(vm.modes.get(credentials)).toBe(0o600);
    const status = await vm.run("get");
    expect(status.credentials.configured).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/new-session|csrf-fixture|device-fixture/);
  });

  it("refuses an incomplete first credential setup", async () => {
    const vm = computer();
    await expect(
      vm.run("credentials", { sessdata: "fixture", bili_jct: "", buvid3: "" }),
    ).rejects.toThrow("bili_jct");
    expect(vm.files.has(credentials)).toBe(false);
  });

  it("rerolls with wake history, daily counts and minimum-gap timestamp intact", async () => {
    const history = {
      schema: 2,
      date: "2026-11-09",
      action: "wake",
      wakes: 1,
      usedCount: { "2026-11-09|20:00–24:00": 1 },
      wokeAt: "2026-11-09T13:00:00Z",
    };
    const vm = computer({ [plan]: history });
    const next = await vm.run("plan");
    expect(next).toMatchObject({
      action: "done",
      wakes: 1,
      usedCount: history.usedCount,
      wokeAt: history.wokeAt,
    });
    expect(vm.historyOf).toHaveBeenCalledWith(history, expect.any(Number));
    expect(JSON.parse(vm.files.get(plan)!)).toEqual(next);
  });

  it("keeps the original plan when planning fails", async () => {
    const vm = computer({ [plan]: { action: "wake", wakes: 1 } });
    const before = vm.files.get(plan);
    vm.makePlan.mockImplementation(() => {
      throw Error("Fixture planning failure");
    });
    await expect(vm.run("plan")).rejects.toThrow("Fixture planning failure");
    expect(vm.files.get(plan)).toBe(before);
    expect(vm.fs.rename).not.toHaveBeenCalled();
  });

  it("keeps the original plan when the new result is invalid", async () => {
    const vm = computer({ [plan]: { action: "wake", wakes: 0 } });
    const before = vm.files.get(plan);
    vm.makePlan.mockReturnValue({ action: "wake" } as never);
    await expect(vm.run("plan")).rejects.toThrow("新计划无效");
    expect(vm.files.get(plan)).toBe(before);
  });

  it("keeps the destination intact when preparing a replacement fails", async () => {
    const vm = computer({ [config]: { persona: { name: "Old" } } });
    const before = vm.files.get(config);
    vm.fs.writeFile.mockRejectedValueOnce(new Error("Fixture disk full"));
    await expect(vm.run("settings", { persona: { name: "New" } })).rejects.toThrow("disk full");
    expect(vm.files.get(config)).toBe(before);
  });

  it("refuses a project symlink outside the bot folder", async () => {
    const vm = computer();
    vm.fs.realpath.mockImplementation(async (file) =>
      file === "." ? root : "/another-bot/bili-whale",
    );
    await expect(vm.run("get")).rejects.toThrow("项目目录");
    expect(vm.fs.readFile).not.toHaveBeenCalled();
  });

  it("preserves another task's update made while preparing a replacement", async () => {
    const vm = computer({ [config]: { persona: { name: "Old" } } });
    const updated = JSON.stringify({ persona: { name: "Concurrent update" } });
    const write = vm.fs.writeFile.getMockImplementation()!;
    vm.fs.writeFile.mockImplementationOnce(async (...args) => {
      await write(...args);
      vm.files.set(config, updated);
    });
    await expect(vm.run("settings", { persona: { name: "New" } })).rejects.toThrow("其他任务");
    expect(vm.files.get(config)).toBe(updated);
    expect(vm.fs.rename).not.toHaveBeenCalled();
  });
});
