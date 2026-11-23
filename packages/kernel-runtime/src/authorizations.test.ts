import assert from "node:assert/strict";
import test from "node:test";
import { authorizationReport, authorizationUrl, OpenClawMcpAuthorizations } from "./authorizations.ts";
import type { AuthorizationCommands, AuthorizationProcess } from "./authorizations.ts";

const status = {
  servers: [
    {
      name: "docs", auth: "oauth", launch: "https://private.example/mcp?token=synthetic-secret",
      headers: { Authorization: "Bearer synthetic-secret" },
      authStatus: { hasTokens: true, requiresAuthorization: false, state: "authorized", expiresAt: 1_800_000_000_000 },
    },
    { name: "mail", auth: "oauth", authStatus: { hasTokens: false, requiresAuthorization: true, state: "requires-authorization" } },
    { name: "notes", auth: "oauth", authStatus: { hasTokens: false, requiresAuthorization: false, state: "pending-authorization" } },
    { name: "local", command: "node", args: ["synthetic-secret"] },
    { name: "per-user", auth: "oauth", connectedPrincipals: 2 },
  ],
};

test("native status maps to product states without endpoints, headers or credentials", () => {
  const report = authorizationReport(status);
  assert.deepEqual(report.map((entry) => [entry.name, entry.state]), [
    ["docs", "authorized"], ["mail", "sign-in-required"], ["notes", "sign-in-pending"],
    ["local", "not-required"], ["per-user", "not-required"],
  ]);
  assert.equal(report[0].expiresAt, 1_800_000_000_000);
  assert.equal(report[3].authorization, "none");
  assert.ok(report[4].reason, "Per-requester sign-in states its own limitation");
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("synthetic-secret"));
  assert.ok(!serialized.includes("private.example"));
  assert.deepEqual(authorizationReport(status, ["mail"]).map((entry) => entry.name), ["mail"]);
  assert.deepEqual(authorizationReport({ servers: "not-a-list" }), []);
});

test("only a plain http authorization address is published", () => {
  assert.equal(authorizationUrl("https://accounts.example.com/authorize?client_id=x"), "https://accounts.example.com/authorize?client_id=x");
  assert.equal(authorizationUrl("  http://127.0.0.1:8989/oauth/authorize  "), "http://127.0.0.1:8989/oauth/authorize");
  assert.equal(authorizationUrl("https://user:secret@accounts.example.com/authorize"), undefined);
  assert.equal(authorizationUrl("file:///etc/passwd"), undefined);
  assert.equal(authorizationUrl("Open this URL to authorize \"docs\":"), undefined);
});

type FixtureOptions = { kernelBusy?: boolean; exitCode?: number; url?: string | null; status?: unknown; keepWaiting?: boolean };

function fixture(options: FixtureOptions = {}) {
  const calls: string[][] = [];
  let finish!: (value: { code: number | null }) => void;
  let rejectCode = false;
  const processes: AuthorizationProcess[] = [];
  const commands: AuthorizationCommands = {
    async run(args) {
      calls.push(args);
      if (args[0] === "mcp" && args[1] === "status") return JSON.stringify(options.status ?? status);
      if (rejectCode && args.includes("--code")) throw new Error("登录没有完成，请重试或改用授权码");
      return "";
    },
    start(args) {
      calls.push(args);
      const exit = new Promise<{ code: number | null }>((resolve) => { finish = resolve; });
      const url = options.url === null ? undefined : options.url ?? "https://accounts.example.com/authorize?state=synthetic";
      const process: AuthorizationProcess = {
        lines: (async function* () {
          yield 'Open this URL to authorize "docs":';
          if (url) yield url;
          yield "Waiting for the browser to return to OpenClaw...";
        })(),
        exit,
        cancel() { finish({ code: null }); },
      };
      processes.push(process);
      return process;
    },
  };
  let pauses = 0;
  const authorizations = new OpenClawMcpAuthorizations({
    commands,
    pauseKernel: async (operation) => {
      ++pauses;
      if (options.kernelBusy) throw new Error("Wait for native work to finish before memory maintenance");
      // The native child starts synchronously, then exits without a browser round trip.
      const pending = operation();
      if (!options.keepWaiting) setTimeout(() => finish?.({ code: options.exitCode ?? 0 }), 5);
      return await pending;
    },
    now: () => 1_000,
  });
  return {
    authorizations, calls, pauses: () => pauses, processes,
    finish: (code: number | null) => finish({ code }),
    rejectCode: () => { rejectCode = true; },
  };
}

function accountStatus(state: string) {
  return { servers: [{ name: "docs", auth: "oauth", authStatus: { hasTokens: state === "authorized", requiresAuthorization: false, state } }] };
}

test("sign-in publishes the address while the kernel is paused and confirms the natively reported outcome", async () => {
  const f = fixture();
  const attempt = await f.authorizations.start("docs");
  assert.equal(attempt.state, "waiting");
  assert.equal(attempt.authorizationUrl, "https://accounts.example.com/authorize?state=synthetic");
  assert.equal(f.pauses(), 1);
  assert.deepEqual(f.calls.at(-1), ["mcp", "login", "docs"]);
  assert.equal(f.authorizations.attempt(attempt.id)?.state, "waiting");
  const settled = await f.authorizations.wait(attempt.id, 5_000);
  assert.equal(settled?.state, "authorized");
  assert.equal(settled?.finishedAt, 1_000);
  assert.ok(!JSON.stringify(settled).includes("synthetic-secret"));
});

test("a failed native sign-in reports no success and keeps its attempt identity", async () => {
  const f = fixture({ exitCode: 1 });
  const attempt = await f.authorizations.start("docs");
  const settled = await f.authorizations.wait(attempt.id, 5_000);
  assert.equal(settled?.state, "failed");
  assert.match(settled.reason ?? "", /重试/u);
  assert.equal(f.authorizations.attempt("missing"), undefined);
});

test("cancelling keeps the cancelled state instead of the killed process outcome", async () => {
  const f = fixture();
  const attempt = await f.authorizations.start("docs");
  await f.authorizations.cancel(attempt.id);
  const settled = await f.authorizations.wait(attempt.id, 1_000);
  assert.equal(settled?.state, "cancelled");
  assert.match(settled.reason ?? "", /取消/u);
});

test("one connection runs one sign-in at a time and only configured accounts can start", async () => {
  const f = fixture();
  const attempt = await f.authorizations.start("docs");
  await assert.rejects(f.authorizations.start("docs"), /正在登录/u);
  await assert.rejects(f.authorizations.start("local"), /账号登录/u);
  await assert.rejects(f.authorizations.start("unknown"), /找不到/u);
  await f.authorizations.cancel(attempt.id);
});

test("kernel admission errors become ordinary-language waiting, not a failed login", async () => {
  const f = fixture({ kernelBusy: true });
  await assert.rejects(f.authorizations.start("docs"), /等当前工作结束后/u);
});

test("a sign-in without a published address fails instead of claiming success", async () => {
  const f = fixture({ url: null, exitCode: 1 });
  await assert.rejects(f.authorizations.start("docs"), /重试|没有开始/u);
});

test("authorization code completion and revoke are confirmed against native status", async () => {
  const signedOut = fixture({ status: accountStatus("unauthenticated") });
  await assert.rejects(signedOut.authorizations.complete("docs", "bad code"), /授权码/u);
  assert.ok(!signedOut.calls.some((args) => args.includes("--code")));
  await assert.rejects(signedOut.authorizations.complete("docs", "abc"), /还没有确认登录/u);
  assert.deepEqual(signedOut.calls.find((args) => args.includes("--code")), ["mcp", "login", "docs", "--code", "abc"]);

  const authorized = fixture({ status: accountStatus("authorized") });
  const confirmed = await authorized.authorizations.complete("docs", "abc", "https://accounts.example.com");
  assert.equal(confirmed.state, "authorized");
  assert.deepEqual(authorized.calls.find((args) => args.includes("--code")),
    ["mcp", "login", "docs", "--code", "abc", "--issuer", "https://accounts.example.com/"]);

  await assert.rejects(authorized.authorizations.revoke("docs"), /还没有确认撤销/u);
  assert.deepEqual(authorized.calls.find((args) => args[1] === "logout"), ["mcp", "logout", "docs"]);
  const revoked = await signedOut.authorizations.revoke("docs");
  assert.equal(revoked.state, "signed-out");
  assert.deepEqual(signedOut.calls.find((args) => args[1] === "logout"), ["mcp", "logout", "docs"]);
});

test("a rejected authorization code says so instead of repeating the generic sign-in failure", async () => {
  const f = fixture({ status: accountStatus("signed-out") });
  f.rejectCode();
  await assert.rejects(f.authorizations.complete("docs", "abc"), /授权码没有通过/u);
});

test("a waiting browser attempt is released before the authorization code is used", async () => {
  const f = fixture({ status: accountStatus("authorized"), keepWaiting: true });
  const attempt = await f.authorizations.start("docs");
  assert.equal(f.authorizations.attempt(attempt.id)?.state, "waiting");
  const confirmed = await f.authorizations.complete("docs", "abc");
  assert.equal(confirmed.state, "authorized");
  assert.equal(f.authorizations.attempt(attempt.id)?.state, "cancelled");
  assert.deepEqual(f.calls.find((args) => args.includes("--code")), ["mcp", "login", "docs", "--code", "abc"]);
  assert.equal(f.pauses(), 2, "the waiting attempt releases the kernel before the code path pauses it");
});

test("an invalid issuer address is refused before any native command runs", async () => {
  const f = fixture();
  await assert.rejects(f.authorizations.complete("docs", "abc", "http://accounts.example.com"), /授权来源/u);
  await assert.rejects(f.authorizations.complete("docs", "abc", "https://user:secret@accounts.example.com"), /授权来源/u);
});
