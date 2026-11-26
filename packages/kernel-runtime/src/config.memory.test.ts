import assert from "node:assert/strict";
import test from "node:test";
import { buildKernelConfig } from "./config.ts";
import { runtimePaths } from "./paths.ts";

test("new explicit fleets have a native ambient owner for memory maintenance", () => {
  const config = buildKernelConfig(
    runtimePaths("/synthetic/application"),
    12345,
    "synthetic-token",
    [{ id: "living" }, { id: "files" }],
  ) as any;
  assert.deepEqual(config.agents.defaults.systemAgent, { agentId: "living" });
  assert.deepEqual(config.agents.defaults.authInheritance, config.agents.defaults.systemAgent);
  assert.equal(config.agents.ownership, "explicit");
  assert.equal(config.tools.agentToAgent.enabled, false);
});

test("administrator-first initialization assigns both system and authorization ownership to it", () => {
  const config = buildKernelConfig(runtimePaths("/synthetic/application"), 12345, "synthetic",
    [{ id: "system-super-admin" }, { id: "living" }]) as any;
  assert.equal(config.agents.defaults.systemAgent.agentId, "system-super-admin");
  assert.equal(config.agents.defaults.authInheritance.agentId, "system-super-admin");
});
