import assert from "node:assert/strict";
import test from "node:test";
import { Abilities } from "./abilities.ts";
import type { CapabilityProvider, KernelCapability } from "../../kernel-runtime/src/capabilities.ts";
import { OpenClawCapabilities } from "../../kernel-runtime/src/capabilities.ts";
import { WorkbenchStore } from "./store.ts";

test("an unfinished package update fences only its Bot admission until the reviewed update completes", async () => {
  const store = new WorkbenchStore(":memory:");
  try {
    const first = store.createBot({ name: "First", agentId: "first" });
    const second = store.createBot({ name: "Second", agentId: "second" });
    const provider: CapabilityProvider = { read: async () => [], setEnabled: async () => {} };
    const abilities = new Abilities(store, provider);
    store.put("settings", { id: "package-update:synthetic", previous: { botId: first.id }, state: "failed" });
    let sends = 0;
    await assert.rejects(abilities.withAccess(first.id, "agent:first:main", async () => { ++sends; }), /更新未完成/);
    assert.equal(sends, 0);
    await abilities.withAccess(second.id, "agent:second:main", async () => { ++sends; });
    assert.equal(sends, 1);
    store.put("settings", { id: "package-update:synthetic", previous: { botId: first.id }, state: "ready" });
    await abilities.withAccess(first.id, "agent:first:main", async () => { ++sends; });
    assert.equal(sends, 2);
  } finally { store.close(); }
});

test("shared ability inventory retains distinct per-Bot access and waits for native confirmation", async () => {
  const store = new WorkbenchStore(":memory:");
  const first = store.createBot({ name: "First", agentId: "first" });
  const second = store.createBot({ name: "Second", agentId: "second" });
  const enabled = new Map([["first", true], ["second", true]]);
  const requests: string[] = [];
  let fail = false;
  const provider: CapabilityProvider = {
    async read(agentId, sessionKey) {
      requests.push(sessionKey);
      return [{
        id: "shared-read", name: "Read", description: "Read local files", kind: "tool", source: "core",
        enabled: enabled.get(agentId)!, ready: enabled.get(agentId)!, manageable: true,
        nativeName: "read", nativeKind: "tool",
      } satisfies KernelCapability];
    },
    async setEnabled(agentId, _capability, state) {
      if (fail) throw new Error("Configuration revision changed");
      enabled.set(agentId, state);
    },
  };
  const abilities = new Abilities(store, provider);
  await Promise.all([abilities.refresh(first.id), abilities.refresh(second.id)]);
  assert.equal(store.snapshot().abilities.length, 1);
  assert.equal(store.snapshot().abilities[0].botIds.length, 2);
  await abilities.setEnabled("native:shared-read", first.id, false);
  const current = store.snapshot().abilities[0];
  assert.equal(current.access?.[first.id].enabled, false);
  assert.equal(current.access?.[second.id].enabled, true);
  fail = true;
  await assert.rejects(abilities.setEnabled(current.id, first.id, true), /revision changed/);
  assert.equal(store.snapshot().abilities[0].access?.[first.id].enabled, false);
  assert.ok(requests.every((key) => key.includes(":explicit:livingbot-")));
  store.close();
});

test("service restrictions are durable across conversations and failed native writes block admission", async () => {
  const store = new WorkbenchStore(":memory:");
  const first = store.createBot({ name: "First", agentId: "first" });
  const second = store.createBot({ name: "Second", agentId: "second" });
  store.privateConversation(first.id);
  const group = store.createConversation("group", [first.id, second.id], "Group");
  const policies = new Map<string, Record<string, boolean>>();
  let fail = false;
  const provider: CapabilityProvider = {
    async read(_agentId, sessionKey) {
      return [{
        id: "service:example", name: "Example", description: "", kind: "service", source: "mcp",
        nativeName: "example", nativeKind: "service",
        enabled: policies.get(sessionKey)?.example !== false, ready: false, manageable: true,
      }];
    },
    async setEnabled() { throw new Error("Service must use raw native server overrides"); },
    async prepareServices(_agentId, sessionKey, services) {
      if (fail) throw new Error("Native session changed");
      policies.set(sessionKey, services);
    },
  };
  const abilities = new Abilities(store, provider);
  await abilities.refresh(first.id);
  await abilities.setEnabled("native:service:example", first.id, false);
  assert.equal(policies.get(store.engineSessionKey(group.id, first.id))?.example, false);
  assert.ok(!policies.has(store.engineSessionKey(group.id, second.id)));
  const newPrivate = store.createConversation("private", [first.id], "Another private");
  let sent = false;
  const reopened = new Abilities(store, provider);
  await reopened.withAccess(first.id, store.engineSessionKey(newPrivate.id, first.id), async () => { sent = true; });
  assert.equal(sent, true);
  assert.equal(policies.get(store.engineSessionKey(newPrivate.id, first.id))?.example, false);
  fail = true;
  sent = false;
  await assert.rejects(reopened.withAccess(first.id, "agent:first:livingbot:group:new", async () => { sent = true; }), /changed/);
  assert.equal(sent, false);
  await reopened.withAccess(second.id, store.engineSessionKey(group.id, second.id), async () => { sent = true; });
  assert.equal(sent, true);
  store.close();
});

test("a service edit waits only for the same Bot admission and later sends observe the new restriction", async () => {
  const store = new WorkbenchStore(":memory:");
  const first = store.createBot({ name: "First", agentId: "first" });
  const second = store.createBot({ name: "Second", agentId: "second" });
  const seen: boolean[] = [];
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const provider: CapabilityProvider = {
    async read() { return [{
      id: "service:example", name: "Example", description: "", kind: "service", source: "mcp",
      nativeName: "example", nativeKind: "service", enabled: seen.at(-1) !== false, ready: false, manageable: true,
    }]; },
    async setEnabled() {},
    async prepareServices(_agentId, _sessionKey, services) { seen.push(services.example); },
  };
  const abilities = new Abilities(store, provider);
  await abilities.refresh(first.id);
  const prior = abilities.withAccess(first.id, "first-session", () => held);
  const editing = abilities.setEnabled("native:service:example", first.id, false);
  let independent = false;
  await abilities.withAccess(second.id, "second-session", async () => { independent = true; });
  assert.equal(independent, true);
  assert.equal(seen.length, 0);
  release(); await prior; await editing;
  await abilities.withAccess(first.id, "new-session", async () => { assert.equal(seen.at(-1), false); });
  store.close();
});

test("public inventory retains flat MCP tools, returns explicit shared state and includes a newly created Bot", async () => {
  const store = new WorkbenchStore(":memory:");
  try {
    const first = store.createBot({ name: "First", agentId: "first" });
    let enabled = true;
    let changes = 0;
    let directories: string[] = [];
    const readGlobal = async (): Promise<KernelCapability[]> => [{
      id: "skill:shared-key", name: "Shared", description: "Original description",
      kind: "method", source: "openclaw-extra", nativeName: "original-name", nativeKind: "skill",
      nativeSource: "openclaw-extra", skillKey: "shared-key", enabled, ready: false, manageable: true,
      reason: "需要完成本机配置", global: true,
    }, {
      id: "service:mcp:docs", name: "Docs", description: "", kind: "service", source: "mcp",
      nativeName: "docs", nativeKind: "service", enabled: true, ready: false, manageable: true, global: true,
    }, {
      id: "tool:mcp:docs:docs__search", name: "Search", description: "", kind: "service", source: "docs",
      nativeName: "docs__search", nativeKind: "tool", nativeSource: "mcp",
      enabled: true, ready: false, manageable: true, global: true,
    }];
    const abilities = new Abilities(store, {
      read: async () => { throw new Error("Must use shared discovery"); },
      setEnabled: async () => { throw new Error("Must not edit a Bot"); },
      readGlobal,
      refreshGlobal: async (value) => { directories = value ?? []; },
      setGlobalEnabled: async (capability, value) => {
        assert.equal(capability.skillKey, "shared-key"); enabled = value; ++changes;
      },
    });
    const initial = await abilities.refreshShared();
    assert.equal(initial.length, 3);
    assert.deepEqual(directories, []);
    const method = initial.find((item) => item.kind === "method")!;
    assert.deepEqual(method.configuration?.sharedAccess, {
      enabled: true, ready: false, manageable: true, reason: "需要完成本机配置",
    });
    assert.deepEqual(method.botIds, [first.id]);
    const child = initial.find((item) => item.source === "docs")!;
    assert.equal(child.source, "docs");
    const native = child.configuration!.native as { nativeName: string; nativeKind: string; nativeSource: string; owner: string };
    assert.equal(native.owner, "docs");
    assert.equal(native.nativeName, "docs__search");
    assert.equal(native.nativeKind, "tool");
    assert.equal(native.nativeSource, "mcp");
    const second = store.createBot({ name: "Second", agentId: "second" });
    assert.deepEqual((await abilities.listShared())[0].botIds.toSorted(), [first.id, second.id].toSorted());
    const result = await abilities.setSharedEnabled(method.id, false);
    assert.equal(changes, 1);
    assert.equal(result[0].state, "disabled");
    assert.deepEqual(result[0].botIds, []);
    assert.equal((result[0].configuration?.sharedAccess as { enabled: boolean }).enabled, false);
    await assert.rejects(abilities.setSharedEnabled("untrusted-native-key", true), /Unknown/);
    assert.equal(changes, 1);
  } finally { store.close(); }
});

test("public edits fail on missing native confirmation and retain legacy provider compatibility", async () => {
  const store = new WorkbenchStore(":memory:");
  try {
    const bot = store.createBot({ name: "First" });
    const item: KernelCapability = {
      id: "read", nativeName: "read", nativeKind: "tool", name: "Read", description: "", kind: "tool",
      source: "core", enabled: true, ready: true, manageable: true, global: true,
    };
    const legacy = new Abilities(store, { read: async () => [item], setEnabled: async () => {} });
    assert.equal((await legacy.refresh(bot.id)).length, 1);
    await assert.rejects(legacy.listShared(), /unavailable/);
    const shared = new Abilities(store, {
      read: async () => [], setEnabled: async () => {},
      readGlobal: async () => [item], setGlobalEnabled: async () => {},
    });
    await assert.rejects(shared.setSharedEnabled("native:global:read", false), /尚未确认/);
  } finally { store.close(); }
});

test("public refresh removes old MCP overrides from all known conversations while a disabled shared service stays disabled", async () => {
  const store = new WorkbenchStore(":memory:");
  try {
    const first = store.createBot({ name: "First", agentId: "first" });
    const second = store.createBot({ name: "Second", agentId: "second" });
    store.privateConversation(first.id);
    store.privateConversation(second.id);
    const group = store.createConversation("group", [first.id, second.id], "Group");
    for (const bot of [first, second]) {
      store.put("settings", { id: `service-access:${bot.id}`, services: { docs: false } });
    }
    let enabled = false;
    let publicChanges = 0;
    let fail = false;
    const overrides = new Map<string, Record<string, unknown>>();
    const initialOverrides = () => ({
      webSearch: false, skills: { private: false }, mcpToolsDeny: { unrelated: ["private"] },
      mcpServers: { docs: false, unrelated: false },
    });
    const native = new OpenClawCapabilities({
      async request<T>(method: string, params: unknown): Promise<T> {
        const input = params as { key: string; agentId: string; toolOverrides: Record<string, unknown> };
        if (method === "sessions.describe") {
          if (!overrides.has(input.key)) overrides.set(input.key, initialOverrides());
          return { session: {
            agentId: input.agentId, sessionId: input.key, toolOverrides: overrides.get(input.key),
          } } as T;
        }
        assert.equal(method, "sessions.patch");
        if (fail) throw new Error("Native session revision changed");
        overrides.set(input.key, input.toolOverrides);
        return { ok: true } as T;
      },
    });
    const readGlobal = async (): Promise<KernelCapability[]> => [{
      id: "service:mcp:docs", name: "Docs", description: "", kind: "service", source: "mcp",
      nativeName: "docs", nativeKind: "service", nativeSource: "mcp",
      enabled, ready: enabled, manageable: true, global: true,
    }];
    const provider: CapabilityProvider = {
      read: async () => readGlobal(),
      setEnabled: async () => { throw new Error("Legacy writes must not recreate per-Bot restrictions"); },
      readGlobal, refreshGlobal: async () => {},
      setGlobalEnabled: async (_capability, value) => { enabled = value; ++publicChanges; },
      prepareServices: native.prepareServices.bind(native),
    };
    const abilities = new Abilities(store, provider);
    const result = await abilities.refreshShared();
    assert.equal((result[0].configuration?.sharedAccess as { enabled: boolean }).enabled, false);
    assert.equal(enabled, false);
    assert.equal(publicChanges, 0);
    for (const bot of [first, second]) {
      const policy = store.get<{ services: Record<string, boolean>; sharedInheritance: boolean }>("settings", `service-access:${bot.id}`)!;
      assert.deepEqual(policy.services, { docs: true });
      assert.equal(policy.sharedInheritance, true);
      const state = overrides.get(store.engineSessionKey(group.id, bot.id))!;
      assert.deepEqual(state, {
        webSearch: false, skills: { private: false }, mcpToolsDeny: { unrelated: ["private"] },
        mcpServers: { unrelated: false },
      });
    }
    // Failed cleanup never reports a successful shared edit. Its persisted
    // cleanup intent survives a fresh Abilities instance and gates admission.
    for (const state of overrides.values()) (state.mcpServers as Record<string, boolean>).docs = false;
    fail = true;
    await assert.rejects(abilities.setSharedEnabled(result[0].id, true), /revision/);
    assert.equal(publicChanges, 1);
    const reopened = new Abilities(store, provider);
    let sent = false;
    const key = store.engineSessionKey(group.id, first.id);
    await assert.rejects(reopened.withAccess(first.id, key, async () => { sent = true; }), /revision/);
    assert.equal(sent, false);
    fail = false;
    await reopened.withAccess(first.id, key, async () => {
      assert.equal(Object.hasOwn(overrides.get(key)!.mcpServers as object, "docs"), false);
      sent = true;
    });
    assert.equal(sent, true);
    const late = store.createConversation("private", [first.id], "Another");
    const lateKey = store.engineSessionKey(late.id, first.id);
    await reopened.withAccess(first.id, lateKey, async () => {
      assert.equal(Object.hasOwn(overrides.get(lateKey)!.mcpServers as object, "docs"), false);
    });
    const secondResult = await reopened.setSharedEnabled(result[0].id, true);
    assert.equal((secondResult[0].configuration?.sharedAccess as { enabled: boolean }).enabled, true);
    for (const state of overrides.values()) {
      assert.equal(Object.hasOwn(state.mcpServers as object, "docs"), false);
    }
    // The compatibility endpoint now changes shared policy; it cannot persist
    // another false service-access entry for one Bot.
    const legacy = await reopened.refresh(first.id);
    await reopened.setEnabled(legacy[0].id, first.id, false);
    assert.equal(enabled, false);
    assert.deepEqual(store.get<{ services: Record<string, boolean> }>("settings", `service-access:${first.id}`)!.services, { docs: true });
    const added = store.createBot({ name: "New", agentId: "new" });
    assert.equal(store.get("settings", `service-access:${added.id}`), undefined);
    await reopened.withAccess(added.id, "agent:new:explicit:new", async () => {});
    await reopened.setSharedEnabled(result[0].id, true);
    assert.ok((await reopened.listShared())[0].botIds.includes(added.id));
  } finally { store.close(); }
});
