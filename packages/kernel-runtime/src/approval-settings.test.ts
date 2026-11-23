import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import type { GatewayRequests } from "./contracts.ts";
import { OpenClawApprovalSettings } from "./approval-settings.ts";

function fixture() {
  const config: Record<string, any> = {
    tools: { exec: { mode: "full", timeoutSec: 60 }, deny: ["example"] },
    agents: {
      defaults: { model: { primary: "synthetic/model" } },
      entries: { example: { identity: { name: "Example" }, tools: { exec: { mode: "full" } } } },
    },
  };
  let file: Record<string, any> = {
    version: 1,
    defaults: { security: "full", ask: "off" },
    agents: {
      example: {
        security: "full",
        ask: "off",
        allowlist: [{ id: "grant-one", pattern: "/usr/bin/example", lastUsedAt: 1000 }],
        mcpTools: [{ server: "example", tool: "read", source: "allow-always", addedAt: 1000 }],
      },
    },
  };
  let hash = 0;
  let failConfig = false;
  const calls: { method: string; params: any }[] = [];
  function merge(target: any, patch: any) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete target[key];
      else if (typeof value === "object" && value && !Array.isArray(value)) {
        target[key] ??= {};
        merge(target[key], value);
      } else target[key] = value;
    }
  }
  const gateway: GatewayRequests = {
    async request<T>(method: string, params: any): Promise<T> {
      calls.push({ method, params });
      if (method === "config.get") return structuredClone({ hash: "config-revision", config }) as T;
      if (method === "exec.approvals.get")
        return structuredClone({ hash: String(hash), file }) as T;
      if (method === "exec.approvals.set") {
        assert.equal(params.baseHash, String(hash));
        hash++;
        file = structuredClone(params.file);
        return structuredClone({ hash: String(hash), file }) as T;
      }
      if (method === "config.patch") {
        if (failConfig) throw new Error("synthetic write failure");
        assert.equal(params.baseHash, "config-revision");
        merge(config, JSON.parse(params.raw));
        return { ok: true } as T;
      }
      throw new Error(`Unexpected native call: ${method}`);
    },
  };
  return {
    adapter: new OpenClawApprovalSettings(gateway),
    calls,
    config,
    file: () => file,
    failConfig: () => {
      failConfig = true;
    },
  };
}

test("settings read native policy and durable command/MCP grants without changing them", async () => {
  const f = fixture();
  assert.deepEqual(await f.adapter.read(), {
    mode: "never",
    enabled: false,
    skipApprovals: true,
    checkerAvailable: true,
    native: {
      requestedMode: "full",
      mode: "full",
      security: "full",
      ask: "off",
      hasOverrides: true,
    },
  });
  const rules = await f.adapter.listRules();
  assert.equal(rules.length, 2);
  assert.ok(rules.every((rule) => rule.matchKind === "category" && rule.effect === "always_allow"));
  assert.ok(f.calls.every((call) => call.method.endsWith(".get")));
});

test("native ask, auto and full modes persist while identities, tools and existing grants stay intact", async () => {
  const f = fixture();
  for (const mode of ["ask", "auto", "never"] as const) {
    assert.equal((await f.adapter.setMode(mode)).mode, mode);
    assert.equal((await f.adapter.read()).mode, mode);
    assert.equal(f.file().defaults.ask, mode === "never" ? "off" : "on-miss");
    assert.equal(f.file().agents.example.ask, mode === "never" ? "off" : "on-miss");
    assert.equal(f.file().agents.example.allowlist.length, 1);
    assert.equal(f.file().agents.example.mcpTools.length, 1);
    assert.deepEqual(f.config.agents.entries.example.identity, { name: "Example" });
    assert.equal(f.config.tools.exec.timeoutSec, 60);
    assert.deepEqual(f.config.tools.deny, ["example"]);
    assert.equal(f.config.agents.entries.example.tools.exec.mode, undefined);
  }
});

test("revoking an exact native grant retains the other grant and rejects stale identities", async () => {
  const f = fixture();
  const [command, mcp] = await f.adapter.listRules();
  await f.adapter.removeRule(command!.id);
  assert.deepEqual(
    (await f.adapter.listRules()).map((rule) => rule.id),
    [mcp!.id],
  );
  await assert.rejects(f.adapter.removeRule(command!.id), /不存在/);
  await f.adapter.removeRule(mcp!.id);
  assert.deepEqual(await f.adapter.listRules(), []);
});

test("a failed requested-policy update restores the native host snapshot", async () => {
  const f = fixture();
  const before = structuredClone(f.file());
  f.failConfig();
  await assert.rejects(f.adapter.setMode("ask"), /synthetic write failure/);
  assert.deepEqual(f.file(), before);
  assert.equal((await f.adapter.read()).mode, "never");
});

test("display follows the pinned native mode and stricter-host rules, including blocked policies", async () => {
  // Pure native helpers: no gateway, subprocess, model or shared database.
  const require = createRequire(import.meta.url);
  const {
    d: resolveMode,
    l: modeFromPolicy,
  } = require("../node_modules/openclaw/dist/exec-approvals-core-puBAw1bE.mjs");
  const {
    r: minSecurity,
    n: maxAsk,
  } = require("../node_modules/openclaw/dist/exec-approvals-policy-BGzNHuNm.mjs");
  for (const requested of ["deny", "allowlist", "ask", "auto", "full"]) {
    for (const security of [undefined, "deny", "allowlist", "full"]) {
      for (const ask of [undefined, "off", "on-miss", "always"]) {
        const f = fixture();
        f.config.tools.exec = { mode: requested, security: "full", ask: "off" };
        f.file().defaults = { security, ask };
        const policy = resolveMode(requested);
        const effectiveSecurity = minSecurity(policy.security, security ?? policy.security);
        const effectiveAsk = maxAsk(policy.ask, ask ?? policy.ask);
        const expected =
          policy.security === effectiveSecurity && policy.ask === effectiveAsk
            ? requested
            : modeFromPolicy({ security: effectiveSecurity, ask: effectiveAsk });
        const result = await f.adapter.read();
        assert.equal(result.native.mode, expected, JSON.stringify({ requested, security, ask }));
        assert.equal(result.skipApprovals, expected === "full");
        assert.equal(result.enabled, expected === "auto");
        assert.equal(f.calls.filter((call) => !call.method.endsWith(".get")).length, 0);
      }
    }
  }
});

test("reviewer overrides and string model shorthand are recognized without claiming live model readiness", async () => {
  const f = fixture();
  f.config.agents.defaults.model = "example/primary";
  assert.equal((await f.adapter.read()).checkerAvailable, true);
  f.config.agents.defaults.model = {};
  f.config.tools.exec.reviewer = { model: "example/reviewer" };
  assert.equal((await f.adapter.read()).checkerAvailable, true);
  f.config.tools.exec.reviewer = { model: { primary: "example/reviewer" } };
  assert.equal((await f.adapter.read()).checkerAvailable, true);
  f.config.tools.exec.reviewer = {};
  assert.equal((await f.adapter.read()).checkerAvailable, false);
});

test("choosing native Auto clears old stricter overrides in one config patch and retains guardrails", async () => {
  const f = fixture();
  f.file().agents["*"] = { security: "deny", ask: "always", askFallback: "deny" };
  f.config.agents.defaults.tools = { exec: { mode: "ask", strictInlineEval: true } };
  f.config.agents.entries.example.tools.exec = {
    ask: "always",
    reviewer: { model: "example/reviewer" },
  };
  assert.equal((await f.adapter.read()).native.hasOverrides, true);
  const result = await f.adapter.setMode("auto");
  assert.equal(result.native.hasOverrides, false);
  assert.equal(f.calls.filter((call) => call.method === "config.patch").length, 1);
  assert.equal(f.file().agents["*"].askFallback, "deny");
  assert.equal(f.config.agents.defaults.tools.exec.strictInlineEval, true);
  assert.deepEqual(f.config.agents.entries.example.tools.exec.reviewer, {
    model: "example/reviewer",
  });
  assert.equal(f.file().agents.example.allowlist.length, 1);
  assert.equal(f.file().agents.example.mcpTools.length, 1);
  // New agents have no local override and inherit this same tools.exec policy.
  assert.equal(f.config.tools.exec.mode, "auto");
  assert.equal(f.file().defaults.security, "allowlist");
  assert.equal(f.file().defaults.ask, "on-miss");
});
