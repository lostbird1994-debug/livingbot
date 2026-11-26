import assert from "node:assert/strict";
import test from "node:test";
import { OpenClawConnections } from "./connections.ts";
import type { ServiceConnectionInput } from "./connections.ts";
import type { GatewayRequests } from "./contracts.ts";

function fixture() {
  const servers: Record<string, Record<string, unknown>> = {
    existing: { url: "https://private.example/mcp", headers: { Authorization: "synthetic-secret" }, enabled: true },
  };
  const patches: { raw: string; baseHash: string; replacePaths?: string[] }[] = [];
  let fail = false;
  let loseReply = false;
  const gateway: GatewayRequests = {
    async request<T>(method: string, params: unknown): Promise<T> {
      if (method === "config.get") return { hash: "revision", config: { mcp: { servers } } } as T;
      assert.equal(method, "config.patch");
      const input = params as typeof patches[number];
      patches.push(input);
      if (fail) throw new Error("synthetic-secret");
      const patch = JSON.parse(input.raw).mcp.servers as typeof servers;
      function merge(previous: Record<string, unknown>, next: Record<string, unknown>) {
        for (const [key, value] of Object.entries(next)) {
          if (value === null) delete previous[key];
          else if (value && typeof value === "object" && !Array.isArray(value)) {
            const target = previous[key] && typeof previous[key] === "object" && !Array.isArray(previous[key])
              ? previous[key] as Record<string, unknown> : {};
            previous[key] = target;
            merge(target, value as Record<string, unknown>);
          } else previous[key] = value;
        }
      }
      for (const [key, value] of Object.entries(patch)) {
        servers[key] ??= {};
        merge(servers[key], value);
      }
      // A saved definition makes the real Gateway restart, so its reply can be lost
      // after the write landed.
      if (loseReply) throw new Error("synthetic-secret");
      return {} as T;
    },
  };
  return {
    connections: new OpenClawConnections(gateway), servers, patches,
    setFail: () => { fail = true; },
    loseReply: () => { loseReply = true; },
  };
}

test("connection reads expose no endpoint, command, environment or credential", async () => {
  const f = fixture();
  assert.deepEqual(await f.connections.list(), [{ name: "existing", transport: "streamable-http", enabled: true, auth: "none" }]);
  assert.equal(f.patches.length, 0);
});

test("an old connection is not confirmation of a failed credential write", async () => {
  const f = fixture();
  f.setFail();
  await assert.rejects(f.connections.update("existing", { headers: { "X-Key": "replacement" } }),
    (error: Error) => !error.message.includes("synthetic-secret"));
  assert.equal((f.servers.existing.headers as Record<string, string>)["X-Key"], undefined);
});

test("add and global disable use native revision-bound additive patches and preserve credentials", async () => {
  const f = fixture();
  await f.connections.add({ name: "本机笔记", transport: "stdio", command: "node", args: ["server.js"], env: { KEY: "synthetic-value" } });
  await f.connections.add({ name: "remote", transport: "streamable-http", url: "http://127.0.0.1:3000/mcp" });
  await f.connections.setEnabled("existing", false);
  assert.deepEqual(f.patches[2], {
    baseHash: "revision", raw: JSON.stringify({ mcp: { servers: { existing: { enabled: false } } } }), response: "summary",
  });
  assert.equal((f.servers.existing.headers as Record<string, string>).Authorization, "synthetic-secret");
  assert.equal(f.servers["本机笔记"].command, "node");
  assert.equal((await f.connections.list()).find((entry) => entry.name === "existing")?.enabled, false);
});

test("invalid or duplicate definitions fail before any native mutation", async () => {
  const f = fixture();
  const invalid = [
    { name: "__proto__", transport: "stdio", command: "node" },
    { name: " ", transport: "stdio", command: "node" },
    { name: "new", transport: "stdio", command: "node", args: [4] },
    { name: "new", transport: "streamable-http", url: "file:///secret" },
    { name: "new", transport: "streamable-http", url: "https://user:password@example.com/mcp" },
    { name: "new", transport: "streamable-http", url: "https://example.com", headers: { Authorization: "a\r\nb" } },
    { name: "new", transport: "streamable-http", url: "https://example.com", command: "node" },
    { name: "existing", transport: "stdio", command: "node" },
    { name: "new", transport: "streamable-http", url: "https://example.com", auth: "basic" },
    { name: "new", transport: "stdio", command: "node", auth: "oauth" },
    { name: "new", transport: "streamable-http", url: "https://example.com", oauth: { scope: "read" } },
    { name: "new", transport: "streamable-http", url: "https://example.com", auth: "oauth", oauth: { secret: "x" } },
  ];
  for (const input of invalid) await assert.rejects(f.connections.add(input as ServiceConnectionInput));
  await assert.rejects(f.connections.setEnabled("missing", false), /找不到/);
  assert.equal(f.patches.length, 0);
});

test("a reply lost to the Gateway restart is confirmed by the saved definition, not reported as failure", async () => {
  const f = fixture();
  f.loseReply();
  await f.connections.add({
    name: "示例资料", transport: "streamable-http", url: "https://mcp.example.com/mcp", auth: "oauth",
  });
  assert.equal(f.servers["示例资料"].auth, "oauth");
  assert.equal((await f.connections.list()).find((entry) => entry.name === "示例资料")?.auth, "oauth");
  await f.connections.setEnabled("示例资料", false);
  assert.equal(f.servers["示例资料"].enabled, false);
  const absent = fixture();
  absent.setFail();
  await assert.rejects(absent.connections.add({
    name: "new", transport: "streamable-http", url: "https://example.com/mcp",
  }), (error: Error) => !error.message.includes("synthetic-secret"));
});

test("native mutation errors never return submitted secrets", async () => {
  const f = fixture();
  f.setFail();
  await assert.rejects(f.connections.add({
    name: "new", transport: "streamable-http", url: "https://example.com/mcp",
    headers: { Authorization: "synthetic-secret" },
  }), (error: Error) => !error.message.includes("synthetic-secret") && error.message.includes("未确认保存"));
});

test("editing changes only supplied settings and explicit credential removal never resubmits saved secrets", async () => {
  const f = fixture();
  f.servers.existing.headers = { Authorization: "synthetic-secret", "X-Project": "one" };
  await f.connections.update("existing", { url: "https://example.com/new" });
  assert.equal(f.servers.existing.url, "https://example.com/new");
  assert.equal((f.servers.existing.headers as Record<string, string>).Authorization, "synthetic-secret");
  assert.ok(!f.patches[0].raw.includes("synthetic-secret"));
  await f.connections.update("existing", { headers: { "X-Project": null } });
  assert.deepEqual(f.servers.existing.headers, { Authorization: "synthetic-secret" });
  await f.connections.update("existing", { headers: null });
  assert.equal(f.servers.existing.headers, undefined);
  await assert.rejects(f.connections.update("existing", {}), /需要修改/);
  await assert.rejects(f.connections.update("existing", { command: "node" }), /远程/);
  await assert.rejects(f.connections.update("existing", { headers: { Authorization: "a\nb" } }), /格式/);
  await assert.rejects(f.connections.update("missing", { url: "https://example.com" }), /找不到/);
});

test("editing local program arguments includes exact replacement intent and retains unsupplied environment", async () => {
  const f = fixture();
  await f.connections.add({ name: "local", transport: "stdio", command: "node", args: ["a", "b"], env: { KEY: "synthetic" } });
  await f.connections.update("local", { args: [] });
  assert.deepEqual(f.patches[1].replacePaths, ["mcp.servers.local.args"]);
  assert.deepEqual(f.servers.local.args, []);
  assert.deepEqual(f.servers.local.env, { KEY: "synthetic" });
  await assert.rejects(f.connections.update("local", { url: "https://example.com" }), /本机/);
});

test("account sign-in is an explicit connection setting and cannot be combined with local programs", async () => {
  const f = fixture();
  await f.connections.add({
    name: "account-docs", transport: "streamable-http", url: "https://mcp.example.com/mcp",
    auth: "oauth", oauth: { scope: "docs.read" },
  });
  assert.deepEqual(f.servers["account-docs"], {
    transport: "streamable-http", url: "https://mcp.example.com/mcp", auth: "oauth", oauth: { scope: "docs.read" }, enabled: true,
  });
  assert.deepEqual((await f.connections.list()).find((entry) => entry.name === "account-docs"),
    { name: "account-docs", transport: "streamable-http", enabled: true, auth: "oauth" });
  await f.connections.update("account-docs", { auth: "none" });
  assert.equal(f.servers["account-docs"].auth, undefined);
  assert.equal(f.servers["account-docs"].oauth, undefined);
  assert.equal((await f.connections.list()).find((entry) => entry.name === "account-docs")?.auth, "none");
});

test("removal clears credentials and arrays, retains a native denial, and allows explicit re-add", async () => {
  const f = fixture();
  f.servers.existing.toolFilter = { include: ["search"], exclude: [] };
  f.servers.existing.custom = { nested: { values: [1] } };
  await f.connections.remove("existing");
  assert.deepEqual(f.servers.existing, { enabled: false });
  assert.deepEqual(f.patches[0].replacePaths, [
    "mcp.servers.existing.toolFilter.include", "mcp.servers.existing.toolFilter.exclude",
    "mcp.servers.existing.custom.nested.values",
  ]);
  assert.deepEqual(await f.connections.list(), []);
  await f.connections.remove("existing");
  assert.equal(f.patches.length, 1);
  await assert.rejects(f.connections.setEnabled("existing", true), /找不到/);
  await assert.rejects(f.connections.update("existing", { url: "https://example.com" }), /找不到/);
  await f.connections.add({ name: "existing", transport: "stdio", command: "node" });
  assert.deepEqual(f.servers.existing, { enabled: true, transport: "stdio", command: "node" });
  await assert.rejects(f.connections.remove("missing"), /找不到/);
});
