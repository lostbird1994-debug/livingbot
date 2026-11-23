import assert from "node:assert/strict";
import test from "node:test";
import { OpenClawMemory } from "./memory.ts";
import type { GatewayRequests } from "./contracts.ts";

function fixture() {
  const calls: { method: string; params: unknown }[] = [];
  const reference = { providerId: "memory-core", id: "memory/project.md", fragment: "L2-L3" };
  let response: Record<string, unknown> = {
    version: 2, agentId: "first", providerId: "memory-core", coverage: "partial", warning: "Synthetic index warning",
    hits: [{ reference, excerpt: "合成项目资料", source: "memory", citations: [{ label: "project.md#L2-L3", reference, startLine: 2, endLine: 3 }], internal: "/private/unused" }],
  };
  const gateway: GatewayRequests = {
    async request<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params }); return response as T;
    },
  };
  return { calls, reference, adapter: new OpenClawMemory(gateway), setResponse(value: Record<string, unknown>) { response = value; } };
}

test("memory uses native v2 reads with explicit agent, opaque source references and bounded output", async () => {
  const f = fixture();
  const result = await f.adapter.search("first", { query: " 项目资料 ", sources: ["memory", "memory"] });
  assert.deepEqual(f.calls[0], { method: "memory.search", params: { agentId: "first", version: 2, query: "项目资料", maxResults: 12, sources: ["memory"] } });
  assert.equal(result.coverage, "partial");
  assert.equal(result.hits[0].citations[0].startLine, 2);
  assert.equal(JSON.stringify(result).includes("/private/unused"), false);
  f.setResponse({ version: 2, agentId: "first", providerId: "memory-core", status: "ok", reference: f.reference, text: "Source", truncated: true, nextFrom: 102 });
  const source = await f.adapter.get("first", f.reference, 2);
  assert.equal(source.status, "ok");
  assert.deepEqual(f.calls[1].params, { agentId: "first", reference: f.reference, from: 2, lines: 100 });
});

test("memory rejects mismatched agent/provider/revision and invalid queries before trusting data", async () => {
  const f = fixture();
  await assert.rejects(f.adapter.search("first", { query: "" }));
  await assert.rejects(f.adapter.search("first", { query: "Valid", limit: 1000 }));
  await assert.rejects(f.adapter.search("../other", { query: "Valid" }));
  assert.equal(f.calls.length, 0);
  f.setResponse({ version: 2, agentId: "second", providerId: "memory-core", hits: [] });
  await assert.rejects(f.adapter.search("first", { query: "Valid" }), /ownership/);
  f.setResponse({ version: 2, agentId: "first", providerId: "memory-core", hits: [{ reference: { ...f.reference, providerId: "another" }, excerpt: "Invalid" }] });
  await assert.rejects(f.adapter.search("first", { query: "Valid" }), /provider/);
  f.setResponse({ version: 2, agentId: "first", providerId: "memory-core", status: "ok", reference: { ...f.reference, revision: "new" }, text: "Changed" });
  await assert.rejects(f.adapter.get("first", { ...f.reference, revision: "old" }), /changed/);
});

test("memory health reports FTS mode honestly and omits raw backend diagnostics", async () => {
  const f = fixture();
  f.setResponse({ version: 2, agentId: "first", providerId: "memory-core", status: "ready", details: {
    legacy: { provider: "none", dbPath: "/private/database", apiKey: "synthetic-not-a-secret" },
  } });
  assert.deepEqual(await f.adapter.health("first"), { providerId: "memory-core", status: "ready", mode: "text" });
});
