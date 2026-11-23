import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";
import { KernelRuntime } from "./runtime.ts";
import { preparePaths, runtimePaths } from "./paths.ts";
import type { GatewayPeer, RuntimeObservation } from "./contracts.ts";

async function fixture(t: TestContext, initialGeneration?: number) {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp(resolve("local/test-fixtures/supervisor-"));
  const paths = runtimePaths(root);
  await preparePaths(paths);
  const peers: { stopped: boolean }[] = [];
  const sessions: { hasActiveRun?: boolean }[] = [];
  const runtime: KernelRuntime = new KernelRuntime({
    nodeExecutable: process.execPath,
    entry: fileURLToPath(new URL("./fixtures/gateway.mjs", import.meta.url)),
    paths, port: 32123, token: "synthetic", expectedVersion: "synthetic", initialGeneration,
    peerFactory: async (options) => {
      const state = { stopped: false };
      peers.push(state);
      const peer: GatewayPeer = {
        start() { options.onHelloOk({ server: { version: "synthetic" } }); },
        async stopAndWait() {
          assert.equal(runtime.processId, undefined, "Retain the operator peer until its Gateway exits");
          state.stopped = true;
        },
        async request<T>(method: string) { return (method === "sessions.list" ? { sessions } : {}) as T; },
      };
      return peer;
    },
  });
  t.after(() => runtime.stop());
  return { runtime, peers, sessions };
}

function observation(runtime: KernelRuntime, predicate: (event: RuntimeObservation) => boolean): Promise<RuntimeObservation> {
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { runtime.off("observation", changed); reject(new Error("Supervisor observation deadline exceeded")); }, 10_000);
    function changed(event: RuntimeObservation) {
      if (!predicate(event)) return;
      clearTimeout(timer); runtime.off("observation", changed); done(event);
    }
    runtime.on("observation", changed);
  });
}

test("an unexpected child exit restarts only its owned Gateway and closes the previous peer", async (t) => {
  const { runtime, peers } = await fixture(t);
  await runtime.start();
  const previous = runtime.processId;
  assert.ok(previous);
  const ready = observation(runtime, (event) => event.type === "ready" && event.generation === 2);
  process.kill(previous, "SIGKILL");
  await ready;
  assert.equal(runtime.phase, "ready");
  assert.ok(runtime.processId);
  assert.notEqual(runtime.processId, previous);
  assert.equal(peers.length, 2);
  assert.equal(peers[0].stopped, true);
  assert.equal(peers[1].stopped, false);
});

test("explicit shutdown cancels pending crash recovery and a later start remains possible", async (t) => {
  const { runtime, peers } = await fixture(t);
  await runtime.start();
  const exited = observation(runtime, (event) => event.type === "exit");
  process.kill(runtime.processId!, "SIGKILL");
  await exited;
  await runtime.stop();
  await new Promise((done) => setTimeout(done, 1200));
  assert.equal(runtime.generation, 1);
  assert.equal(runtime.phase, "stopped");
  assert.equal(runtime.processId, undefined);
  assert.equal(peers.length, 1);
  assert.equal(peers[0].stopped, true);
  await runtime.start();
  assert.equal(runtime.generation, 2);
  assert.equal(runtime.phase, "ready");
});

test("a persisted generation seeds the first launch and subsequent restart", async (t) => {
  const { runtime } = await fixture(t, 12);
  const starting: number[] = [];
  runtime.on("observation", (event: RuntimeObservation) => {
    if (event.type === "phase" && event.phase === "starting") starting.push(event.generation);
  });
  await runtime.start();
  assert.equal(runtime.generation, 13);
  await runtime.restart();
  assert.equal(runtime.generation, 14);
  assert.deepEqual(starting, [13, 14]);
});

test("offline maintenance refuses active or uncertain native runs without stopping the kernel", async (t) => {
  const { runtime, sessions } = await fixture(t);
  await runtime.start();
  const pid = runtime.processId;
  for (const session of [{ hasActiveRun: true }, {}]) {
    sessions.splice(0, sessions.length, session);
    await assert.rejects(runtime.offlineMaintenance(async () => { throw new Error("Must not run"); }), /native work/);
    assert.equal(runtime.processId, pid);
    assert.equal(runtime.maintenance, false);
  }
});

test("offline maintenance retains admission ownership, recovers after failure, and respects explicit shutdown", async (t) => {
  const { runtime } = await fixture(t);
  await runtime.start();
  await assert.rejects(runtime.offlineMaintenance(async () => {
    assert.equal(runtime.processId, undefined);
    assert.equal(runtime.maintenance, true);
    await assert.rejects(runtime.start(), /maintenance/);
    await assert.rejects(runtime.offlineMaintenance(async () => {}), /not available/);
    throw new Error("Synthetic preview failure");
  }), /Synthetic preview failure/);
  assert.equal(runtime.phase, "ready");
  assert.equal(runtime.generation, 2);
  assert.equal(runtime.maintenance, false);
  await runtime.offlineMaintenance(async () => { await runtime.stop(); });
  assert.equal(runtime.phase, "stopped");
  assert.equal(runtime.processId, undefined);
  assert.equal(runtime.generation, 2);
});

test("unfinished destructive maintenance can explicitly retain the stopped kernel", async (t) => {
  const { runtime } = await fixture(t);
  await runtime.start();
  const result = await runtime.offlineMaintenance(async () => ({ status: "recovery-required" }), { restartAfter: () => false });
  assert.equal(result.status, "recovery-required");
  assert.equal(runtime.phase, "stopped");
  assert.equal(runtime.processId, undefined);
  assert.equal(runtime.generation, 1);
  assert.equal(runtime.maintenance, false);
});

test("a startup deadline retains the last handshake error instead of hiding its cause", async (t) => {
  const { runtime } = await fixture(t);
  runtime.options.startupTimeoutMs = 50;
  runtime.options.peerFactory = async (options) => ({
    start() { options.onConnectError(new Error("Synthetic handshake rejected")); },
    async stopAndWait() {},
    async request() { throw new Error("Not connected"); },
  });
  await assert.rejects(runtime.start(), /Kernel startup deadline exceeded: Synthetic handshake rejected/);
  assert.equal(runtime.phase, "failed");
});
