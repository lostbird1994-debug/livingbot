import assert from "node:assert/strict";
import test from "node:test";
import { OpenClawCapabilities } from "./capabilities.ts";
import type { KernelCapability } from "./capabilities.ts";
import type { GatewayRequests } from "./contracts.ts";
import { OpenClawAgents } from "./agents.ts";

function applyConfigPatch(current: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete current[key];
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      const child = current[key];
      const target = child && typeof child === "object" && !Array.isArray(child) ? child as Record<string, unknown> : {};
      current[key] = target;
      applyConfigPatch(target, value as Record<string, unknown>);
    } else current[key] = value;
  }
}

function fixture() {
  const calls: { method: string; params: unknown }[] = [];
  const gateway: GatewayRequests = {
    async request<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params });
      if (method === "config.get") return {
        hash: "revision-1",
        config: {
          models: { providers: { example: { apiKey: "synthetic-secret" } } },
          agents: { defaults: { skills: ["one", "two"] }, entries: {
            first: { tools: { deny: ["write"] } }, second: { skills: ["other"] },
          } },
        },
      } as T;
      if (method === "tools.catalog") return { groups: [{ tools: [
        { id: "read", label: "Read files", source: "core" }, { id: "write", source: "core" },
      ] }] } as T;
      if (method === "tools.effective") return { groups: [{ tools: [{ id: "read", source: "core" }] }] } as T;
      if (method === "skills.status") return { skills: [
        { name: "one", source: "bundled", bundled: true, eligible: true, filePath: "/private/source" },
        { name: "two", source: "bundled", bundled: true, eligible: false, missing: { env: ["EXAMPLE_KEY"] } },
        { name: "blocked", disabled: true, source: "workspace" },
      ] } as T;
      return { ok: true } as T;
    },
  };
  return { calls, gateway, adapter: new OpenClawCapabilities(gateway) };
}

test("native inventory distinguishes readiness and preserves only safe capability metadata", async () => {
  const f = fixture();
  const items = await f.adapter.read("first", "agent:first:explicit:example");
  assert.equal(items.find((item) => item.nativeName === "one")?.ready, true);
  assert.equal(items.find((item) => item.nativeName === "two")?.ready, false);
  assert.equal(items.find((item) => item.nativeName === "blocked")?.manageable, false);
  assert.equal(items.find((item) => item.nativeName === "read")?.enabled, true);
  assert.equal(items.find((item) => item.nativeName === "write")?.enabled, false);
  assert.ok(!JSON.stringify(items).includes("/private/source"));
});

test("skill and tool changes patch only the selected agent and carry explicit array intent", async () => {
  const f = fixture();
  const items = await f.adapter.read("first", "agent:first:explicit:example");
  await f.adapter.setEnabled("first", items.find((item) => item.nativeName === "one")!, false);
  await f.adapter.setEnabled("first", items.find((item) => item.nativeName === "read")!, false);
  const patches = f.calls.filter((call) => call.method === "config.patch").map((call) =>
    call.params as { raw: string; baseHash: string; replacePaths: string[] });
  assert.deepEqual(JSON.parse(patches[0].raw), { agents: { entries: { first: { skills: ["two"] } } } });
  assert.deepEqual(JSON.parse(patches[1].raw), { agents: { entries: { first: { tools: { deny: ["write", "read"] } } } } });
  assert.equal(patches[0].baseHash, "revision-1");
  assert.deepEqual(patches[1].replacePaths, ["agents.entries.first.tools.deny"]);
  assert.ok(!JSON.stringify(patches).includes("synthetic-secret"));
  await assert.rejects(f.adapter.setEnabled("first", items.find((item) => item.nativeName === "blocked")!, true), /shared/);
  await assert.rejects(f.adapter.setEnabled("absent", items[0] as KernelCapability, true), /Unknown/);
});

test("configured services appear before discovery without exposing connection settings or starting a turn", async () => {
  const f = fixture();
  const gateway: GatewayRequests = {
    async request<T>(method: string, params: unknown): Promise<T> {
      if (method === "config.get") return { config: { mcp: { servers: {
        docs: { url: "https://private.example/mcp", headers: { Authorization: "synthetic-secret" } },
        local: { enabled: false, command: "/private/program", env: { KEY: "synthetic-secret" } },
      } } } } as T;
      if (method === "tools.effective") return {
        groups: [], notices: [{ id: "mcp-not-yet-connected", servers: ["docs"], message: "Raw private diagnostic" }],
      } as T;
      return f.gateway.request<T>(method, params);
    },
  };
  const adapter = new OpenClawCapabilities(gateway);
  const items = await adapter.read("first", "agent:first:explicit:example");
  const docs = items.find((item) => item.nativeKind === "service" && item.nativeName === "docs")!;
  assert.equal(docs.enabled, true);
  assert.equal(docs.ready, false);
  assert.equal(docs.reason, "已配置，尚未连接");
  assert.equal(docs.manageable, true);
  assert.equal(items.find((item) => item.nativeName === "local")?.enabled, false);
  for (const secret of ["synthetic-secret", "private.example", "/private/program", "Raw private diagnostic"]) {
    assert.ok(!JSON.stringify(items).includes(secret));
  }
  assert.ok(!f.calls.some((call) => ["chat.send", "agent", "mcp.probe"].includes(call.method)));
  await assert.rejects(adapter.setEnabled("first", { ...docs, manageable: true }, false), /shared settings/);
});

test("retained MCP schemas do not imply readiness after a connection failure or config change", async () => {
  for (const notice of [
    { id: "mcp-server-diagnostic:docs", message: "synthetic-secret" },
    { id: "mcp-stale-catalog", servers: ["docs"] },
    { id: "mcp-not-yet-listed", servers: ["docs"] },
  ]) {
    const f = fixture();
    const adapter = new OpenClawCapabilities({
      async request<T>(method: string, params: unknown): Promise<T> {
        if (method === "config.get") return { config: { mcp: { servers: { docs: { url: "https://example.com/mcp" } } } } } as T;
        if (method === "tools.effective") return {
          groups: [{ tools: [{ id: "docs__search", source: "mcp", mcpServer: "docs" }] }], notices: [notice],
        } as T;
        return f.gateway.request<T>(method, params);
      },
    });
    const items = await adapter.read("first", "agent:first:explicit:example");
    const service = items.find((item) => item.nativeKind === "service")!;
    const tool = items.find((item) => item.nativeName === "docs__search")!;
    assert.equal(service.ready, false);
    assert.equal(tool.enabled, true);
    assert.equal(tool.ready, false);
    assert.equal(tool.reason, service.reason);
    assert.ok(!JSON.stringify(items).includes("synthetic-secret"));
  }
});

test("an exact native denial retains the previously discovered tool so it can be re-enabled", async () => {
  const f = fixture();
  const known: KernelCapability = {
    id: "tool:mcp:docs:docs__search:first", nativeName: "docs__search", nativeKind: "tool",
    name: "Search", description: "", kind: "service", source: "docs",
    enabled: true, ready: true, manageable: true,
  };
  const adapter = new OpenClawCapabilities({
    async request<T>(method: string, params: unknown): Promise<T> {
      if (method === "config.get") return { config: {
        agents: { entries: { first: { tools: { deny: ["docs__search"] } } } },
        mcp: { servers: { docs: {} } },
      } } as T;
      return f.gateway.request<T>(method, params);
    },
  });
  const items = await adapter.read("first", "agent:first:explicit:example", [
    known, { ...known, id: "removed", source: "removed" },
    { ...known, id: "unknown", nativeName: "docs__unknown" },
  ]);
  assert.equal(items.find((item) => item.id === known.id)?.enabled, false);
  assert.equal(items.find((item) => item.id === known.id)?.manageable, true);
  assert.ok(!items.some((item) => item.id === "removed"));
  assert.equal(items.find((item) => item.id === "unknown")?.enabled, true);
  assert.equal(items.find((item) => item.id === "unknown")?.ready, false);
});

test("a removed service denial is absent from both configured and previously discovered inventories", async () => {
  const f = fixture();
  const adapter = new OpenClawCapabilities({
    async request<T>(method: string, params: unknown): Promise<T> {
      if (method === "config.get") return { config: {
        agents: { entries: { first: { tools: { deny: ["docs__search"] } } } },
        mcp: { servers: { docs: { enabled: false } } },
      } } as T;
      if (method === "tools.effective") return {
        groups: [{ tools: [{ id: "docs__search", source: "mcp", mcpServer: "docs" }] }],
      } as T;
      return f.gateway.request<T>(method, params);
    },
  });
  const items = await adapter.read("first", "agent:first:explicit:example", [{
    id: "tool:mcp:docs:docs__search:first", nativeName: "docs__search", nativeKind: "tool",
    name: "Search", description: "", kind: "service", source: "docs",
    enabled: false, ready: false, manageable: true,
  }]);
  assert.ok(!items.some((item) => item.nativeName === "docs" || item.nativeName === "docs__search"));
});

test("raw service overrides preserve other session policies and use native compare-and-swap", async () => {
  const f = fixture();
  let overrides: Record<string, unknown> = {
    webSearch: false, skills: { synthetic: false }, mcpToolsDeny: { docs: ["private"] },
    mcpServers: { unrelated: false },
  };
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const adapter = new OpenClawCapabilities({
    async request<T>(method: string, params: unknown): Promise<T> {
      const input = params as Record<string, unknown>;
      calls.push({ method, params: input });
      if (method === "sessions.describe") return { session: { agentId: "first", sessionId: "session-1", toolOverrides: overrides } } as T;
      if (method === "sessions.patch") {
        assert.deepEqual(input.expectedToolOverrides, overrides);
        assert.equal(input.expectedSessionId, "session-1");
        overrides = input.toolOverrides as Record<string, unknown>;
        return {} as T;
      }
      return f.gateway.request<T>(method, params);
    },
  });
  await adapter.prepareServices("first", "agent:first:livingbot:group:synthetic", { "docs with spaces": false });
  assert.deepEqual(overrides, {
    webSearch: false, skills: { synthetic: false }, mcpToolsDeny: { docs: ["private"] },
    mcpServers: { unrelated: false, "docs with spaces": false },
  });
  await adapter.prepareServices("first", "agent:first:livingbot:group:synthetic", { "docs with spaces": false });
  assert.equal(calls.filter((call) => call.method === "sessions.patch").length, 1);
  await adapter.prepareServices("first", "agent:first:livingbot:group:synthetic", { "docs with spaces": true });
  assert.deepEqual(overrides, {
    webSearch: false, skills: { synthetic: false }, mcpToolsDeny: { docs: ["private"] },
    mcpServers: { unrelated: false },
  });
  await adapter.prepareServices("first", "agent:first:livingbot:group:synthetic", { "docs with spaces": true });
  assert.equal(calls.filter((call) => call.method === "sessions.patch").length, 2);
  assert.ok(!calls.some((call) => call.method === "sessions.create" || call.method === "config.patch"));
  await assert.rejects(adapter.prepareServices("second", "agent:first:explicit:synthetic", { docs: false }), /owner/);
});

test("service policy changes reject conflicting native writes and missing confirmation", async () => {
  for (const conflict of [false, true]) {
    let reads = 0;
    const adapter = new OpenClawCapabilities({
      async request<T>(method: string): Promise<T> {
        if (method === "sessions.describe") {
          reads++;
          return { session: reads === 1 ? null : { toolOverrides: {} } } as T;
        }
        if (method === "sessions.patch") {
          if (conflict) throw new Error("Session revision changed");
          return {} as T;
        }
        throw new Error(`Unexpected method ${method}`);
      },
    });
    await assert.rejects(adapter.prepareServices("first", "agent:first:livingbot:group:synthetic", { docs: false }),
      conflict ? /revision/ : /尚未确认/);
  }
});

test("global writes use native shared skills keys, tools and MCP definitions without editing any Bot", async () => {
  const f = fixture();
  const adapter = new OpenClawCapabilities({
    async request<T>(method: string, params: unknown): Promise<T> {
      if (method === "config.get") return {
        hash: "global-revision",
        config: {
          agents: { entries: { first: {}, second: {} } },
          tools: { deny: ["write"], sessions: { visibility: "self" } },
          skills: { entries: { "configured-key": { env: { KEY: "synthetic-secret" } } } },
          mcp: { servers: { docs: { enabled: false, url: "https://example.com/mcp" } } },
        },
      } as T;
      if (method === "skills.status") return { skills: [{
        name: "display-name", skillKey: "configured-key", source: "openclaw-extra",
        disabled: true, eligible: false,
      }] } as T;
      return f.gateway.request<T>(method, params);
    },
  });
  const items = await adapter.readGlobal();
  const skill = items.find((item) => item.nativeKind === "skill")!;
  assert.equal(skill.manageable, true);
  assert.equal(skill.global, true);
  assert.equal(skill.enabled, false);
  await adapter.setGlobalEnabled(skill, true);
  await adapter.setGlobalEnabled(items.find((item) => item.nativeName === "write")!, true);
  await adapter.setGlobalEnabled(items.find((item) => item.nativeKind === "service")!, true);
  const patches = f.calls.filter((call) => call.method === "config.patch").map((call) =>
    call.params as { raw: string; baseHash: string; replacePaths: string[] });
  assert.deepEqual(JSON.parse(patches[0].raw), { skills: { entries: { "configured-key": { enabled: true } } } });
  assert.deepEqual(JSON.parse(patches[1].raw), { tools: { deny: [] } });
  assert.deepEqual(patches[1].replacePaths, ["tools.deny"]);
  assert.deepEqual(JSON.parse(patches[2].raw), { mcp: { servers: { docs: { enabled: true } } } });
  assert.ok(patches.every((patch) => patch.baseHash === "global-revision" && !patch.raw.includes("agents")));
  assert.ok(!JSON.stringify(items).includes("synthetic-secret"));
  assert.ok(!f.calls.some((call) => call.method === "sessions.patch"));
});

test("global discovery keeps stable skill identities, raw sources and MCP owners without session-based enablement", async () => {
  const f = fixture();
  const adapter = new OpenClawCapabilities({
    async request<T>(method: string, params: unknown): Promise<T> {
      if (method === "config.get") return { config: {
        agents: { entries: { first: {} } }, tools: { deny: ["write"] },
        mcp: { servers: { docs: { url: "https://example.com/mcp" } } },
      } } as T;
      if (method === "skills.status") return { skills: [{
        name: "shared", skillKey: "stable-key", source: "openclaw-extra", eligible: true, blockedByAgentFilter: true,
      }, {
        name: "private-workspace", source: "openclaw-workspace", baseDir: "/synthetic/private/skills/one", eligible: true,
      }] } as T;
      if (method === "sessions.describe") return { session: { toolOverrides: { mcpServers: { docs: false } } } } as T;
      if (method === "tools.effective") return { groups: [{ tools: [{
        id: "docs__search", source: "mcp", mcpServer: "docs",
      }] }] } as T;
      return f.gateway.request<T>(method, params);
    },
  });
  const items = await adapter.readGlobal();
  const skill = items.find((item) => item.nativeKind === "skill")!;
  assert.equal(skill.id, "skill:stable-key");
  assert.equal(skill.nativeSource, "openclaw-extra");
  assert.equal(skill.enabled, true);
  assert.equal(skill.ready, false);
  assert.equal(items.find((item) => item.nativeName === "private-workspace"), undefined);
  const child = items.find((item) => item.nativeName === "docs__search")!;
  assert.equal(child.source, "docs");
  assert.equal(child.nativeSource, "mcp");
  assert.equal(child.id, "tool:mcp:docs:docs__search");
  assert.equal(items.find((item) => item.nativeKind === "service")?.enabled, true);
});

test("shared refresh reuses native extraDirs additively, refreshes discovery and never moves files", async () => {
  const f = fixture();
  const directory = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
  let roots = ["/existing/shared"];
  const adapter = new OpenClawCapabilities({
    async request<T>(method: string, params: unknown): Promise<T> {
      if (method === "config.get") return {
        hash: "shared-revision", config: {
          agents: { entries: { first: {}, second: {} } },
          skills: { load: { extraDirs: roots } },
        },
      } as T;
      if (method === "config.patch") roots = JSON.parse((params as { raw: string }).raw).skills.load.extraDirs;
      return f.gateway.request<T>(method, params);
    },
  });
  await adapter.refreshGlobal([directory, directory, "/nonexistent/synthetic/skills"]);
  const patch = f.calls.find((call) => call.method === "config.patch")!.params as { raw: string; replacePaths: string[] };
  assert.deepEqual(JSON.parse(patch.raw), { skills: { load: { extraDirs: ["/existing/shared", directory] } } });
  assert.deepEqual(patch.replacePaths, ["skills.load.extraDirs"]);
  assert.ok(f.calls.some((call) => call.method === "skills.status" &&
    (call.params as { refresh?: boolean }).refresh === true));
  assert.ok(!f.calls.some((call) => call.method === "sessions.patch"));
  await assert.rejects(adapter.refreshGlobal(["relative/skills"]), /absolute/);
});

test("conflicting same-name packages abort shared root changes without modifying either installation", async () => {
  const calls: string[] = [];
  const source = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
  const other = new URL("../native-plugin", import.meta.url).pathname;
  const adapter = new OpenClawCapabilities({
    async request<T>(method: string, params: unknown): Promise<T> {
      calls.push(method);
      if (method === "config.get") return {
        hash: "revision", config: { agents: { entries: { first: {}, second: {} } } },
      } as T;
      if (method === "skills.status") return { skills: [{
        name: "same-native-name", baseDir: (params as { agentId: string }).agentId === "first" ? source : other,
      }] } as T;
      throw new Error(`Unexpected ${method}`);
    },
  });
  await assert.rejects(adapter.refreshGlobal([source]), /同名技能内容不同.*same-native-name/);
  assert.ok(!calls.includes("config.patch"));
});

test("shared refresh rejects a native patch that did not retain the requested roots", async () => {
  const directory = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
  const adapter = new OpenClawCapabilities({
    async request<T>(method: string): Promise<T> {
      if (method === "config.get") return {
        hash: "revision", config: { agents: { entries: { first: {} } } },
      } as T;
      if (method === "skills.status") return { skills: [] } as T;
      if (method === "config.patch") return { ok: true } as T;
      throw new Error(`Unexpected ${method}`);
    },
  });
  await assert.rejects(adapter.refreshGlobal([directory]), /公共技能目录配置尚未确认/);
});

test("one native patch enables a public skill and removes old Bot/default filters while preserving unrelated configuration", async () => {
  const config = {
    agents: {
      defaults: { skills: ["old-only"], model: { primary: "example/model" }, tools: { deny: ["write"], exec: { timeoutSec: 30 } } },
      entries: {
        first: {
          skills: [], tools: { deny: ["read"], exec: { security: "allowlist" } },
          workspace: "/synthetic/first", identity: { name: "First" }, memory: { search: { rememberAcrossConversations: true } },
        },
        second: { skills: ["old-only"], tools: { deny: ["write"], allow: ["read"] }, model: "example/other" },
      },
    },
    skills: { entries: { public: { enabled: false, env: { KEY: "synthetic-secret" } } } },
    tools: { deny: ["exec"], sessions: { visibility: "self" } },
  };
  const patches: { raw: string; baseHash: string; replacePaths: string[] }[] = [];
  const gateway: GatewayRequests = {
    async request<T>(method: string, params: unknown): Promise<T> {
      if (method === "config.get") return { hash: "revision", config: structuredClone(config) } as T;
      assert.equal(method, "config.patch");
      const patch = params as typeof patches[number];
      patches.push(patch);
      applyConfigPatch(config, JSON.parse(patch.raw));
      return { ok: true } as T;
    },
  };
  const adapter = new OpenClawCapabilities(gateway);
  const capability: KernelCapability = {
    id: "skill:public", name: "Public", description: "", kind: "method", source: "openclaw-extra",
    nativeName: "public", skillKey: "public", nativeKind: "skill", enabled: false, ready: false, manageable: true, global: true,
  };
  await adapter.setGlobalEnabled(capability, true);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].baseHash, "revision");
  assert.deepEqual(JSON.parse(patches[0].raw), {
    agents: {
      defaults: { skills: null, tools: { deny: null } },
      entries: { first: { skills: null, tools: { deny: null } }, second: { skills: null, tools: { deny: null } } },
    },
    skills: { entries: { public: { enabled: true } } },
  });
  assert.deepEqual(new Set(patches[0].replacePaths), new Set([
    "agents.defaults.skills", "agents.defaults.tools.deny",
    "agents.entries.first.skills", "agents.entries.first.tools.deny",
    "agents.entries.second.skills", "agents.entries.second.tools.deny",
  ]));
  assert.deepEqual(config.agents.defaults, { model: { primary: "example/model" }, tools: { exec: { timeoutSec: 30 } } });
  assert.deepEqual(config.agents.entries.first, {
    tools: { exec: { security: "allowlist" } }, workspace: "/synthetic/first", identity: { name: "First" },
    memory: { search: { rememberAcrossConversations: true } },
  });
  assert.deepEqual(config.agents.entries.second, { tools: { allow: ["read"] }, model: "example/other" });
  assert.deepEqual(config.skills.entries.public, { enabled: true, env: { KEY: "synthetic-secret" } });
  assert.deepEqual(config.tools, { deny: ["exec"], sessions: { visibility: "self" } });
  assert.ok(!patches[0].raw.includes("synthetic-secret"));
  // The normal Bot registration inherits the shared config after normalization.
  await new OpenClawAgents(gateway).ensure({ agentId: "newbot", workspace: "/synthetic/newbot" });
  const added = (config.agents.entries as Record<string, Record<string, unknown>>).newbot;
  assert.equal(Object.hasOwn(added, "skills"), false);
  assert.equal(Object.hasOwn(added, "tools"), false);
  assert.equal(Object.hasOwn(config.agents.defaults, "skills"), false);
  assert.equal(config.skills.entries.public.enabled, true);
});

test("refresh combines public directories and inheritance normalization into one confirmed native patch", async () => {
  const directory = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
  const config: Record<string, unknown> = {
    agents: { defaults: { skills: [] }, entries: { first: { skills: [], tools: { deny: ["read"] } } } },
    skills: { load: { extraDirs: [] } },
  };
  let patches = 0;
  const adapter = new OpenClawCapabilities({
    async request<T>(method: string, params: unknown): Promise<T> {
      if (method === "config.get") return { hash: "revision", config: structuredClone(config) } as T;
      if (method === "skills.status") return { skills: [] } as T;
      assert.equal(method, "config.patch");
      ++patches;
      const patch = JSON.parse((params as { raw: string }).raw);
      assert.deepEqual(patch, {
        agents: { defaults: { skills: null }, entries: { first: { skills: null, tools: { deny: null } } } },
        skills: { load: { extraDirs: [directory] } },
      });
      applyConfigPatch(config, patch);
      return { ok: true } as T;
    },
  });
  await adapter.refreshGlobal([directory]);
  assert.equal(patches, 1);
  await adapter.refreshGlobal([directory]);
  assert.equal(patches, 1);
});

test("an unconfirmed inheritance cleanup rejects public enablement instead of reporting success", async () => {
  const adapter = new OpenClawCapabilities({
    async request<T>(method: string): Promise<T> {
      if (method === "config.get") return {
        hash: "revision", config: { agents: { defaults: { skills: [] }, entries: { first: { tools: { deny: ["read"] } } } } },
      } as T;
      if (method === "config.patch") return { ok: true } as T;
      throw new Error(`Unexpected ${method}`);
    },
  });
  await assert.rejects(adapter.setGlobalEnabled({
    id: "tool:core:core:read", name: "Read", description: "", kind: "tool", source: "core",
    nativeName: "read", nativeKind: "tool", enabled: false, ready: false, manageable: true,
  }, true), /公共能力继承配置尚未确认/);
});
