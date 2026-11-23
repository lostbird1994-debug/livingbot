import assert from "node:assert/strict";
import test from "node:test";
import { administratorCapabilityContext, sharedCapabilitySnapshot } from "./admin-capabilities.ts";
import type { Ability } from "./contracts.ts";

test("shared scope comes from product inventory rather than file ownership and unavailable is distinct from absent", () => {
  const skill = {
    id: "native:global:skill:browser",
    name: "browser",
    description: "Synthetic browser capability",
    version: "1",
    permissions: [],
    botIds: [],
    kind: "method",
    source: "openclaw-extra",
    state: "enabled",
    configuration: {
      native: { skillKey: "browser" },
      sharedAccess: { enabled: true, ready: false, reason: "Missing dependency" },
    },
  } as Ability;
  const one = sharedCapabilitySnapshot([skill], "first");
  const two = sharedCapabilitySnapshot([skill], "second");
  assert.equal(one.items[0]?.scope, "shared");
  assert.equal(one.items[0]?.enabled, true);
  assert.equal(one.items[0]?.ready, false);
  assert.equal(one.revision, two.revision);
  const changed = sharedCapabilitySnapshot([
    {
      ...skill,
      configuration: { ...skill.configuration, sharedAccess: { enabled: true, ready: true } },
    },
  ]);
  assert.notEqual(changed.revision, one.revision);
  const context = administratorCapabilityContext(one);
  assert.ok(context.includes(one.revision));
  assert.ok(context.includes('"scope":"shared"'));
  assert.ok(context.includes('"ready":false'));
});
