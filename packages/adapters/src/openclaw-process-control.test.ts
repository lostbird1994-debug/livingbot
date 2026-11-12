import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeProcessControl } from "./openclaw-process-control.js";
import type { NativeProcessBackend } from "./openclaw-process-control.js";

const sessionKey = `agent:main:rakazo:${"a".repeat(64)}`;
const runId = `rakazo-${"b".repeat(64)}`;
describe("native process ownership", () => {
  it("requires a trusted observed handle and matching run, scope and PID", async () => {
    let cancelled = 0;
    const entry = { scopeKey: sessionKey, pid: 123, backgrounded: true };
    let finished = false;
    const backend: NativeProcessBackend = {
      getSession: () => finished ? undefined : entry,
      getFinishedSession: () => finished ? { ...entry, terminalStatus: "failed" } : undefined,
      cancel: () => { cancelled++; return true; },
    };
    const control = new NativeProcessControl(async () => backend);
    const params = { sessionKey, runId, sessionId: "owned", action: "kill" };
    await expect(control.control(params)).rejects.toThrow("ownership");
    control.observe({ toolName: "exec", result: { details: {
      status: "running", sessionId: "owned", pid: 123,
    } } }, { sessionKey, runId });
    await expect(control.control({ ...params, runId: "other" })).rejects.toThrow("ownership");
    entry.scopeKey = "different-session";
    await expect(control.control(params)).rejects.toThrow("scope");
    entry.scopeKey = sessionKey;
    entry.pid = 456;
    await expect(control.control(params)).rejects.toThrow("scope");
    entry.pid = 123;
    expect(cancelled).toBe(0);
    await expect(control.control(params)).resolves.toEqual({ status: "running" });
    expect(cancelled).toBe(1);
    await expect(control.control({ ...params, action: "poll" })).resolves.toEqual({ status: "running" });
    finished = true;
    await expect(control.control({ ...params, action: "poll" })).resolves.toEqual({ status: "failed" });
    expect(cancelled).toBe(1);
  });
  it("fails closed when the registry or cancellation handle is missing", async () => {
    let exists = false;
    const control = new NativeProcessControl(async () => ({
      getSession: () => exists ? { scopeKey: sessionKey, backgrounded: true } : undefined,
      getFinishedSession: () => undefined,
      cancel: () => false,
    }));
    control.observe({ toolName: "exec", result: { details: {
      status: "running", sessionId: "owned",
    } } }, { sessionKey, runId });
    const params = { sessionKey, runId, sessionId: "owned", action: "kill" };
    await expect(control.control(params)).rejects.toThrow("scope");
    exists = true;
    await expect(control.control(params)).rejects.toThrow("cancellation handle");
  });
  it("proves an exited background command after the engine forgot its registry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rakazo-process-"));
    const ledger = join(dir, "owners.json");
    try {
      const empty = { getSession: () => undefined, getFinishedSession: () => undefined, cancel: () => false };
      const first = new NativeProcessControl(async () => empty, ledger);
      // A dead PID stands in for a command that exited with the previous engine.
      const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
      first.observe({ toolName: "exec", result: { details: {
        status: "running", sessionId: "owned", pid: dead,
      } } }, { sessionKey, runId });
      // A restarted engine has no memory of the handle until the ledger is read.
      const restarted = new NativeProcessControl(async () => empty, ledger);
      await expect(restarted.control({ sessionKey, runId, sessionId: "owned", action: "poll" }))
        .resolves.toEqual({ status: "failed" });
      // A live PID keeps the guard closed: something is still executing.
      const alive = new NativeProcessControl(async () => empty, ledger);
      alive.observe({ toolName: "exec", result: { details: {
        status: "running", sessionId: "live", pid: process.pid,
      } } }, { sessionKey, runId });
      await expect(new NativeProcessControl(async () => empty, ledger)
        .control({ sessionKey, runId, sessionId: "live", action: "poll" }))
        .resolves.toEqual({ status: "running" });
      // Ownership still requires the exact session and run, ledger or not.
      await expect(new NativeProcessControl(async () => empty, ledger)
        .control({ sessionKey, runId: "other", sessionId: "owned", action: "poll" }))
        .rejects.toThrow("ownership");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
