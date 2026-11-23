import assert from "node:assert/strict";
import test from "node:test";
import { memoryFrequency, OpenClawMemorySettings } from "./memory-settings.ts";

test("memory cadence is bounded and translates directly into native dreaming cron", () => {
  const base = {
    enabled: true,
    cadence: "daily" as const,
    hour: 3,
    minute: 15,
    weekday: 1,
    recallMode: "escalate" as const,
    flushBeforeCompaction: true,
  };
  assert.equal(memoryFrequency(base), "15 3 * * *");
  assert.equal(memoryFrequency({ ...base, cadence: "weekly", weekday: 6 }), "15 3 * * 6");
  for (const patch of [
    { hour: 24 },
    { minute: -1 },
    { weekday: 7 },
    { enabled: "yes" },
    { recallMode: "guess" },
  ])
    assert.throws(() => memoryFrequency({ ...base, ...patch } as any));
});

test("saving disabled memory features does not reactivate disabled plugins", async () => {
  let patch: any;
  const config = {
    plugins: {
      entries: { "memory-core": { enabled: false }, "active-memory": { enabled: false } },
    },
    agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } },
  };
  const settings = new OpenClawMemorySettings({
    async request(method: string, input: any) {
      if (method === "config.get") return { hash: "revision", config } as never;
      if (method === "config.patch") {
        patch = JSON.parse(input.raw);
        Object.assign(config.plugins.entries["memory-core"], {
          ...config.plugins.entries["memory-core"],
          config: patch.plugins.entries["memory-core"].config,
        });
        return {} as never;
      }
      return { jobs: [] } as never;
    },
  });
  await settings.save({
    enabled: false,
    cadence: "daily",
    hour: 4,
    minute: 0,
    weekday: 1,
    recallMode: "off",
    flushBeforeCompaction: false,
  });
  assert.equal(patch.plugins.entries["memory-core"].enabled, undefined);
  assert.equal(patch.plugins.entries["active-memory"].enabled, undefined);
});

test("a timed-out write is read back without repeating it and distinguishes pending runtime application", async () => {
  let frequency = "0 3 * * *";
  let writes = 0;
  let active = "old";
  const settings = new OpenClawMemorySettings({
    async request(method: string, input: any) {
      if (method === "config.get")
        return {
          hash: "saved",
          configRevisionHash: frequency,
          appliedConfigHash: active,
          config: {
            plugins: {
              entries: {
                "memory-core": {
                  enabled: true,
                  config: { dreaming: { enabled: true, frequency } },
                },
                "active-memory": { enabled: true, config: { mode: "escalate" } },
              },
            },
          },
        } as never;
      if (method === "cron.list") return { jobs: [] } as never;
      writes++;
      frequency = JSON.parse(input.raw).plugins.entries["memory-core"].config.dreaming.frequency;
      throw Error("gateway request timeout for config.patch");
    },
  });
  const input = {
    enabled: true,
    cadence: "daily" as const,
    weekday: 1,
    hour: 22,
    minute: 0,
    recallMode: "escalate" as const,
    flushBeforeCompaction: true,
  };
  const pending = await settings.save(input);
  assert.equal(pending.frequency, "0 22 * * *");
  assert.equal(pending.applyState, "pending");
  assert.equal(writes, 1);
  await settings.save(input);
  assert.equal(writes, 1);
  active = frequency;
  assert.equal((await settings.read()).applyState, "applied");
});
