import assert from "node:assert/strict";
import { test } from "node:test";
import { toolDetail } from "./tool-detail.ts";

test("no arbitrary string from a tool payload can reach a retained detail", () => {
  const detail = toolDetail({
    url: "https://example.test/?access_token=synthetic-query-token",
    command: "curl -H Authorization: Bearer synthetic-command-token",
    output: "synthetic file body",
    error: "provider rejected synthetic-command-token",
  });
  assert.equal(detail, undefined);
});

test("previously leaked inline credentials stay out of the projection", () => {
  for (const payload of [
    { url: "https://example.test/?access_token=synthetic-query-token" },
    { url: "https://example.test/?api_key=synthetic-query-token" },
    { command: "curl -H Authorization: Bearer synthetic-command-token" },
    { command: "tool --password synthetic-command-token" },
    { headers: { Authorization: "Bearer synthetic-command-token" } },
    { env: { GITHUB_TOKEN: "synthetic-command-token" } },
    { body: "synthetic-command-token" },
  ]) {
    const detail = toolDetail({ toolCallId: "call-1", name: "exec", phase: "result", ...payload });
    assert.ok(detail, JSON.stringify(payload));
    assert.equal(detail.includes("synthetic-command-token"), false, JSON.stringify(payload));
    assert.equal(detail.includes("synthetic-query-token"), false, JSON.stringify(payload));
  }
});

test("ownership, status and scalar outcomes survive so a step stays readable", () => {
  const detail = toolDetail({
    toolCallId: "call-1", parentToolCallId: "wrapper-1", name: "write", title: "Synthetic title", phase: "result",
    result: { ok: true, bytes: 128, status: "completed", path: "projects/synthetic.md", content: "synthetic body" },
    input: { path: "projects/synthetic.md", content: "synthetic body" },
  });
  assert.ok(detail);
  const parsed = JSON.parse(detail);
  assert.equal(parsed.toolCallId, "call-1");
  assert.equal(parsed.parentToolCallId, "wrapper-1");
  assert.equal(parsed.name, "write");
  assert.equal(parsed.phase, "result");
  assert.deepEqual(parsed.outcome, { bytes: 128, ok: true, status: "completed" });
  assert.equal(detail.includes("projects/synthetic.md"), false);
  assert.equal(detail.includes("synthetic body"), false);
});

test("a running step reports its partial outcome and nothing else", () => {
  const detail = toolDetail({
    toolCallId: "exec-1", name: "exec", phase: "update",
    partialResult: { running: true, exitCode: 0, output: "synthetic stream" },
  });
  assert.ok(detail);
  assert.deepEqual(JSON.parse(detail).outcome, { exitCode: 0 });
  assert.equal(detail.includes("synthetic stream"), false);
});

test("identifiers that are not identifiers are dropped", () => {
  const detail = toolDetail({ toolCallId: "call with spaces and secret", name: "read", phase: "start" });
  assert.ok(detail);
  assert.equal(JSON.parse(detail).toolCallId, undefined);
  assert.equal(detail.includes("secret"), false);
});

test("an anonymous step keeps no detail at all", () => {
  assert.equal(toolDetail({}), undefined);
  assert.equal(toolDetail({ unknown: "value", other: 1 }), undefined);
});
