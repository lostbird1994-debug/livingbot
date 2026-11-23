import assert from "node:assert/strict";
import test from "node:test";
import { ServiceAuthorizations } from "./service-authorizations.ts";
import { WorkbenchStore } from "./store.ts";
import type { AuthorizationAttempt, AuthorizationProvider, McpAuthorization } from "../../kernel-runtime/src/authorizations.ts";

function provider(initial: McpAuthorization[]) {
  let current = initial;
  const calls: string[] = [];
  const value: AuthorizationProvider = {
    async read() { calls.push("read"); return current.map((item) => ({ ...item })); },
    async start(name) { calls.push(`start:${name}`); return { id: "attempt-1", name, state: "waiting", startedAt: 1 } as AuthorizationAttempt; },
    attempt(id) { return id === "attempt-1" ? { id, name: "docs", state: "waiting", startedAt: 1 } : undefined; },
    async wait(id) { return id === "attempt-1" ? { id, name: "docs", state: "authorized", startedAt: 1 } : undefined; },
    async cancel(id) { calls.push(`cancel:${id}`); },
    async complete(name) { calls.push(`complete:${name}`); return { name, authorization: "oauth", state: "authorized", hasTokens: true }; },
    async revoke(name) { calls.push(`revoke:${name}`); return { name, authorization: "oauth", state: "signed-out", hasTokens: false }; },
    async dispose() { calls.push("dispose"); },
  };
  return { value, calls, set: (next: McpAuthorization[]) => { current = next; } };
}

test("every account state comes from an authoritative read and is kept as a receipt", async () => {
  const store = new WorkbenchStore(":memory:");
  try {
    const source = provider([{ name: "docs", authorization: "oauth", state: "signed-out", hasTokens: false }]);
    const authorizations = new ServiceAuthorizations(store, source.value);
    const first = await authorizations.read();
    assert.deepEqual(first, [{ name: "docs", authorization: "oauth", state: "signed-out", hasTokens: false, checkedAt: first[0].checkedAt }]);
    assert.deepEqual(authorizations.receipts().map(({ name, state }) => [name, state]), [["docs", "signed-out"]]);
    assert.ok(!JSON.stringify(authorizations.receipts()).includes("id"), "Receipt identity is not part of the view");

    source.set([{ name: "docs", authorization: "oauth", state: "authorized", hasTokens: true, expiresAt: 9 }]);
    const second = await authorizations.read();
    assert.equal(second[0].state, "authorized");
    assert.equal(authorizations.receipts()[0].state, "authorized");
    assert.equal(source.calls.filter((call) => call === "read").length, 2);
  } finally { store.close(); }
});

test("a failed native read never reports a remembered success", async () => {
  const store = new WorkbenchStore(":memory:");
  try {
    const source = provider([{ name: "docs", authorization: "oauth", state: "authorized", hasTokens: true }]);
    const authorizations = new ServiceAuthorizations(store, source.value);
    await authorizations.read();
    source.value.read = async () => { throw new Error("暂时无法读取账号状态"); };
    await assert.rejects(authorizations.read(), /暂时无法读取账号状态/u);
    // The receipt is what was last confirmed; it is not presented as a fresh result.
    assert.equal(authorizations.receipts()[0].state, "authorized");
  } finally { store.close(); }
});

test("completion and revocation record the confirmed result, and attempts stay addressable", async () => {
  const store = new WorkbenchStore(":memory:");
  try {
    const source = provider([]);
    const authorizations = new ServiceAuthorizations(store, source.value);
    const attempt = await authorizations.start("docs");
    assert.equal(authorizations.attempt(attempt.id)?.state, "waiting");
    assert.equal((await authorizations.wait(attempt.id, 10))?.state, "authorized");
    const completed = await authorizations.complete("docs", "code");
    assert.equal(completed.state, "authorized");
    assert.equal(authorizations.receipts()[0].state, "authorized");
    const revoked = await authorizations.revoke("docs");
    assert.equal(revoked.state, "signed-out");
    assert.equal(authorizations.receipts()[0].state, "signed-out");
    await authorizations.dispose();
    assert.deepEqual(source.calls.filter((call) => !call.startsWith("start") && call !== "read"),
      ["complete:docs", "revoke:docs", "dispose"]);
  } finally { store.close(); }
});
