import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { OpenClawAgents } from "./agents.ts";

test("native registration is additive, revision-bound and recoverable after lost acknowledgment", async () => {
  const entries: Record<string, unknown> = { original: { workspace: "/synthetic/original" } };
  const workspace = resolve("local/synthetic-import");
  let loseReply = true;
  let patches = 0;
  const adapter = new OpenClawAgents({
    async request<T>(method: string, params: unknown): Promise<T> {
      if (method === "config.get") return { hash: "revision", config: { agents: { entries } } } as T;
      assert.equal(method, "config.patch");
      const patch = params as { baseHash: string; raw: string };
      assert.equal(patch.baseHash, "revision");
      const data = JSON.parse(patch.raw);
      assert.deepEqual(Object.keys(data.agents.entries), ["imported"]);
      Object.assign(entries, data.agents.entries);
      ++patches;
      if (loseReply) { loseReply = false; throw new Error("Lost acknowledgment"); }
      return { ok: true } as T;
    },
  });
  await assert.rejects(adapter.ensure({ agentId: "imported", workspace }), /Lost/);
  await adapter.ensure({ agentId: "imported", workspace });
  assert.equal(patches, 1);
  assert.deepEqual(entries.original, { workspace: "/synthetic/original" });
  await assert.rejects(adapter.ensure({ agentId: "imported", workspace: "/synthetic/elsewhere" }), /another/);
});
