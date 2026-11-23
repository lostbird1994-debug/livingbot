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
  assert.equal(config.agents.ownership, "explicit");
  assert.equal(config.tools.agentToAgent.enabled, false);
});
