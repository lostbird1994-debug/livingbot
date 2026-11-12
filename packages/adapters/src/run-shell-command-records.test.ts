import type { ProcessEvent } from "@rakazo/adapter-kit";
import type { ComputerCommand } from "@rakazo/contracts";
import { afterEach, expect, it, vi } from "vitest";
import type * as BotSecrets from "./bot-secrets.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { computerTools } from "./run-tools-computer.js";

vi.mock("./bot-secrets.js", async (original) => ({
  ...(await original<typeof BotSecrets>()),
  shellCommandEnvironment: async () => ({ env: {}, unsetEnv: [] }),
}));

afterEach(() => vi.useRealTimers());

function fixture(
  stream: () => AsyncIterable<ProcessEvent>,
  append: (command: ComputerCommand) => Promise<void>,
) {
  const onShellStillRunning = vi.fn();
  const ctx = {
    deps: {
      sandbox: { execute: stream },
      events: { append: async ({ payload }: { payload: ComputerCommand }) => append(payload) },
    },
    bot: { id: "fixture-bot" },
    thread: { id: "fixture-thread" },
    run: { spaceId: "fixture-space" },
    runId: "fixture-run",
    context: { signal: new AbortController().signal },
    secrets: [],
    computer: {
      mode: "team",
      checkpoint: { markDirty: vi.fn() },
      get: async () => ({ kind: "desktop" }),
      hostEnvironment: { platform: "darwin", home: "/Users/fake", shell: "/bin/zsh" },
    },
  } as unknown as RunContext;
  const call = {
    name: "shell",
    args: { command: "fixture-command" },
    executionId: "fixture-command-id",
    observer: { onShellStillRunning },
    finish: async (result: unknown) => result,
  } as unknown as ToolCall;
  return { execute: () => computerTools.shell!(ctx, call), onShellStillRunning };
}

it("commits the final receipt after delayed running updates, using the same command id", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const exit = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let allowWrites!: () => void;
  const writeGate = new Promise<void>((resolve) => {
    allowWrites = resolve;
  });
  const records: ComputerCommand[] = [];
  let writes = 0;
  const { execute, onShellStillRunning } = fixture(
    async function* () {
      yield { type: "stdout", data: "starting\n" };
      await exit;
      yield { type: "stdout", data: "done\n" };
      yield { type: "exit", code: 0 };
    },
    async (record) => {
      writes += 1;
      if (writes > 1) await writeGate;
      records.push(record);
    },
  );
  const running = execute();
  await vi.advanceTimersByTimeAsync(1_500);
  expect(await running).toMatchObject({ running: true });
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(records.map((record) => record.status)).toEqual(["running"]);
  allowWrites();
  await onShellStillRunning.mock.calls[0]![0];
  await vi.advanceTimersByTimeAsync(1_000);
  expect(records.at(-1)).toMatchObject({ status: "done", exitCode: 0, output: "starting\ndone\n" });
  expect(new Set(records.map((record) => record.executionId))).toEqual(
    new Set(["fixture-command-id"]),
  );
});

it("does not overwrite a failure with a stale running update", async () => {
  vi.useFakeTimers();
  const records: ComputerCommand[] = [];
  const { execute } = fixture(
    async function* () {
      yield { type: "stdout", data: "starting\n" };
      yield { type: "stdout", data: "waiting\n" };
      throw new Error("fixture disconnect");
    },
    async (record) => {
      records.push(record);
    },
  );
  await expect(execute()).rejects.toThrow("fixture disconnect");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(records.at(-1)).toMatchObject({
    status: "done",
    exitCode: 1,
    output: "fixture disconnect",
  });
  expect(records.filter((record) => record.status === "done")).toHaveLength(1);
});
