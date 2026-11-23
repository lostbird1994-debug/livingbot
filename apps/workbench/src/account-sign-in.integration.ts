import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { freeLoopbackPort, launchWorkbench } from "./main.ts";
import { buildKernelConfig, newGatewayToken } from "../../../packages/kernel-runtime/src/config.ts";
import { preparePaths, runtimePaths } from "../../../packages/kernel-runtime/src/paths.ts";
import {
  OpenClawAuthorizationCommands, OpenClawMcpAuthorizations,
} from "../../../packages/kernel-runtime/src/authorizations.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import { Marketplace } from "../../../packages/workbench/src/marketplace.ts";
import type { Bot } from "../../../packages/workbench/src/contracts.ts";

/**
 * Real account sign-in through the pinned OpenClaw CLI. A synthetic authorization
 * server and MCP endpoint stand in for the vendor on loopback; no hosted service,
 * no real credential and no external network access are involved. Only the browser
 * hop is simulated: the fixture follows the authorization redirect to the callback.
 */
const { values } = parseArgs({ options: {
  "kernel-entry": { type: "string" },
  // Serves the same synthetic provider for a real browser session instead of asserting.
  serve: { type: "boolean" },
} });
const kernelEntry = values["kernel-entry"];
const serving = values.serve === true;
if (!kernelEntry) throw new Error("--kernel-entry is required");
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-account-sign-in-"));
const paths = runtimePaths(join(root, "application"));
await preparePaths(paths);
const seed = new WorkbenchStore(join(paths.root, "workbench.sqlite"));
const bot: Bot = seed.createBot({ name: "Atlas", agentId: "atlas" });
seed.close();

const accessToken = "synthetic-access-" + randomUUID();
const codes = new Map<string, unknown>();
const issued = { register: 0, authorize: 0, token: 0, rejected: 0, calls: 0 };
let origin = "";

function send(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const service = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");
  const path = url.pathname;
  if (path === "/.well-known/oauth-protected-resource") {
    send(response, 200, { resource: origin + "/mcp", authorization_servers: [origin], scopes_supported: ["read"] });
    return;
  }
  if (path === "/.well-known/oauth-authorization-server") {
    send(response, 200, {
      issuer: origin,
      authorization_endpoint: origin + "/authorize",
      token_endpoint: origin + "/token",
      registration_endpoint: origin + "/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["read"],
      authorization_response_iss_parameter_supported: true,
    });
    return;
  }
  if (path === "/register" && request.method === "POST") {
    ++issued.register;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    send(response, 201, {
      client_id: "synthetic-client",
      client_id_issued_at: 1,
      redirect_uris: Array.isArray(input.redirect_uris) ? input.redirect_uris : [],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    return;
  }
  if (path === "/authorize") {
    ++issued.authorize;
    const redirect = url.searchParams.get("redirect_uri");
    const challenge = url.searchParams.get("code_challenge");
    const state = url.searchParams.get("state");
    if (!redirect || !challenge || !state) { send(response, 400, { error: "invalid_request" }); return; }
    const code = "synthetic-code-" + randomUUID();
    codes.set(code, { challenge });
    const target = new URL(redirect);
    target.searchParams.set("code", code);
    target.searchParams.set("state", state);
    target.searchParams.set("iss", origin);
    // Approval: the browser now follows this redirect to the loopback callback.
    response.writeHead(302, { location: target.href });
    response.end();
    return;
  }
  if (path === "/token" && request.method === "POST") {
    ++issued.token;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = new URLSearchParams(Buffer.concat(chunks).toString());
    const code = input.get("code") ?? "";
    if (!codes.has(code) || input.get("grant_type") !== "authorization_code" || !input.get("code_verifier")) {
      send(response, 400, { error: "invalid_grant" });
      return;
    }
    codes.delete(code);
    send(response, 200, {
      access_token: accessToken, token_type: "Bearer", expires_in: 3600,
      refresh_token: "synthetic-refresh", scope: "read",
    });
    return;
  }
  if (path === "/mcp" && request.method === "DELETE") {
    if (request.headers.authorization !== "Bearer " + accessToken) {
      ++issued.rejected;
      response.writeHead(401);
      response.end();
      return;
    }
    response.writeHead(200);
    response.end();
    return;
  }
  if (path === "/mcp") {
    if (request.headers.authorization !== "Bearer " + accessToken) {
      ++issued.rejected;
      response.writeHead(401, {
        "www-authenticate": 'Bearer resource_metadata="' + origin + '/.well-known/oauth-protected-resource", scope="read"',
      });
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    // A client may probe with an empty body or close a session with DELETE.
    if (!raw.trim()) { response.writeHead(202); response.end(); return; }
    const input = JSON.parse(raw);
    if (input.id === undefined) { response.writeHead(202); response.end(); return; }
    let result: unknown = {};
    if (input.method === "initialize") {
      result = {
        protocolVersion: input.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: "synthetic-account", version: "1.0.0" },
      };
    } else if (input.method === "tools/list") {
      result = { tools: [{
        name: "lookup", description: "Read synthetic account evidence",
        inputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] },
      }] };
    } else if (input.method === "tools/call") {
      ++issued.calls;
      result = { content: [{ type: "text", text: "SIGNED-IN-EVIDENCE-4417" }] };
    } else if (input.method === "resources/list") result = { resources: [] };
    else if (input.method === "prompts/list") result = { prompts: [] };
    send(response, 200, { jsonrpc: "2.0", id: input.id, result });
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise<void>((done) => service.listen(0, "127.0.0.1", done));
origin = "http://127.0.0.1:" + String((service.address() as AddressInfo).port);

/** A prepared catalog submission so the author-side record entry is reviewable in the browser. */
async function prepareAuthorRecord(store: WorkbenchStore) {
  const commit = "a".repeat(40);
  const body = {
    format: "livingbot-package-v1", id: "example-researcher", kind: "bot", name: "示例研究伙伴",
    description: "整理你指定的资料，并在结论旁保留来源。", version: "1.0.0", license: "MIT", author: "示例作者",
    permissions: ["读取你选择的本机项目文件"],
    files: [
      { path: "SOUL.md", text: "# 研究伙伴\n\n区分事实与推断，每条结论保留来源。" },
      { path: "skills/research/SKILL.md", text: "---\nname: research\ndescription: 整理指定资料并保留来源\n---\n输出来源。" },
    ],
  };
  const market = new Marketplace(store, {
    read: async (input) => ({
      source: {
        repository: input.repository, path: input.path ?? "livingbot.json",
        commit, blob: "b".repeat(40),
      },
      bytes: Buffer.from(JSON.stringify(input.path === "livingbot-market.json" ? {
        format: "livingbot-market-v1", name: "示例目录", packages: [{
          id: body.id, name: body.name, description: body.description, kind: "bot",
          repository: "example/methods", commit, path: "livingbot.json", tags: ["研究"],
        }],
      } : body)),
    }),
  });
  const catalog = await market.readCatalog({ repository: "example/catalog" });
  const preview = await market.previewCatalogEntry(catalog.id, body.id);
  return market.prepareSubmission({
    catalogId: catalog.id, previewId: preview.id, digest: preview.digest, tags: ["研究", "资料"],
  });
}

let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
let commands: OpenClawAuthorizationCommands | undefined;
let headers: Record<string, string> = {};
const evidence: { scenarios: string[]; issued: typeof issued; error?: string } = { scenarios: [], issued };
const secretPattern = /synthetic-access|synthetic-refresh|synthetic-code-/u;

async function api<T>(path: string, body?: unknown): Promise<{ status: number; value: T }> {
  const response = await fetch(app!.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, value: (await response.json()) as T };
}

/** The gateway restarts after a config change; wait for it to admit work again. */
async function waitReady(deadlineMs = 180_000): Promise<void> {
  const startedAt = Date.now();
  let phase = "unknown";
  for (;;) {
    const snapshot = await api<{ kernel: { phase: string } }>("/api/snapshot").catch(() => undefined);
    phase = snapshot?.value.kernel.phase ?? "unreachable";
    if (phase === "ready") return;
    if (Date.now() - startedAt > deadlineMs) throw new Error("Kernel did not return to ready: " + phase);
    await new Promise((done) => setTimeout(done, 500));
  }
}

/** The browser hop, without a browser: follow the redirect to the loopback callback. */
async function approve(authorizationUrl: string): Promise<void> {
  const authorization = await fetch(authorizationUrl, { redirect: "manual" });
  assert.equal(authorization.status, 302, "the authorization server redirects to the loopback callback");
  const callback = authorization.headers.get("location");
  assert.ok(callback, "the redirect names a callback address");
  const answered = await fetch(callback);
  assert.ok(answered.ok, "the loopback callback answered " + String(answered.status));
}

/** Native connection with the stored account credential, without a model turn. */
async function probe(): Promise<{ tools: string[] }> {
  const report = await app!.kernel.offlineMaintenance(() =>
    commands!.run(["mcp", "probe", "account", "--json"], 120_000));
  const parsed = JSON.parse(report) as { tools?: string[] };
  return { tools: Array.isArray(parsed.tools) ? parsed.tools : [] };
}

type Attempt = { id: string; name: string; state: string; authorizationUrl?: string; reason?: string };
type Account = { name: string; state: string; authorization: string; checkedAt?: number };

try {
  if (serving) {
    // Same synthetic provider, same kernel, but served to a real browser. The
    // service is written into the kernel config first: saving it through the
    // gateway would restart the gateway mid-session.
    const config = buildKernelConfig(paths, await freeLoopbackPort(), newGatewayToken(), [{
      id: bot.agentId, workspace: join(paths.workspaces, bot.agentId), rememberAcrossConversations: true,
    }], {
      id: "synthetic", baseUrl: origin + "/v1", api: "openai-completions",
      apiKey: "synthetic", model: "synthetic", contextWindow: 32_000, maxTokens: 1000,
    });
    config.mcp = {
      ...(config.mcp as Record<string, unknown> | undefined),
      servers: {
        "示例资料": { transport: "streamable-http", url: origin + "/mcp", auth: "oauth", enabled: true },
      },
    };
    await writeFile(paths.config, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    app = await launchWorkbench({
      root: paths.root, kernelEntry: resolve(kernelEntry), nodeExecutable: process.execPath,
      webRoot: resolve("apps/workbench-web/dist"),
      connection: {
        id: "synthetic", baseUrl: origin + "/v1", api: "openai-completions",
        apiKey: "synthetic", model: "synthetic", contextWindow: 32_000, maxTokens: 1000,
      },
    });
    const served = JSON.parse(await readFile(app.authPath, "utf8")).token;
    headers = { authorization: "Bearer " + served };
    await waitReady();
    const listed = await api<{ name: string; auth: string }[]>("/api/connections");
    if (!listed.value.some((entry) => entry.name === "示例资料" && entry.auth === "oauth")) {
      throw new Error("The synthetic service is missing: " + JSON.stringify(listed.value));
    }
    const record = await prepareAuthorRecord(app.store);
    console.log(JSON.stringify({
      serving: true, url: app.url, token: served, root, pid: process.pid,
      connection: "示例资料", submission: record.id, submissionEntry: record.entry.name,
      submissionTags: record.entry.tags, issueUrl: record.issueUrl,
    }));
    await new Promise<void>((done) => {
      process.once("SIGTERM", () => done());
      process.once("SIGINT", () => done());
    });
    console.log(JSON.stringify({ served: true }));
  } else {
  app = await launchWorkbench({
    root: paths.root, kernelEntry: resolve(kernelEntry), nodeExecutable: process.execPath,
    // The kernel needs a configured model to admit an agent; no turn is dispatched here.
    connection: {
      id: "synthetic", baseUrl: origin + "/v1", api: "openai-completions",
      apiKey: "synthetic", model: "synthetic", contextWindow: 32_000, maxTokens: 1000,
    },
  });
  commands = new OpenClawAuthorizationCommands({
    nodeExecutable: process.execPath, entry: resolve(kernelEntry), paths,
  });
  const token = JSON.parse(await readFile(app.authPath, "utf8")).token;
  headers = { authorization: "Bearer " + token };

    const added = await api<{ name: string; auth: string }[]>("/api/connections", {
      name: "account", transport: "streamable-http", url: origin + "/mcp", auth: "oauth",
    });
    assert.equal(added.status, 201);
    assert.equal(added.value.find((entry) => entry.name === "account")?.auth, "oauth");
    const before = await api<Account[]>("/api/authorizations");
    assert.equal(before.status, 200);
    assert.equal(before.value.find((entry) => entry.name === "account")?.state, "signed-out");
    assert.ok(!secretPattern.test(JSON.stringify(before.value)), "the inventory carries no credential");
    evidence.scenarios.push("http-account-state-is-readable-from-the-official-cli-without-credentials");

    const inventory = await app.service.abilities!.refresh(bot.id);
    assert.ok(inventory.some((entry) => entry.name === "account"), "the service appears in the Bot's abilities");
    assert.ok(!secretPattern.test(JSON.stringify(inventory)), "the ability inventory carries no credential");
    await assert.rejects(probe(), "an unauthorized service cannot connect");
    evidence.scenarios.push("http-unauthorized-service-is-listed-but-cannot-connect");

    const started = await api<Attempt>("/api/authorizations/account/start", {});
    assert.equal(started.status, 201, JSON.stringify(started.value));
    assert.equal(started.value.state, "waiting");
    assert.ok(started.value.authorizationUrl?.startsWith(origin + "/authorize"), "the sign-in address is published");
    assert.ok(!secretPattern.test(JSON.stringify(started.value)), "the attempt carries no credential");
    await approve(started.value.authorizationUrl!);
    const settled = await api<Attempt>("/api/authorizations/attempts/" + started.value.id + "?timeoutMs=120000");
    assert.equal(settled.status, 200);
    assert.equal(settled.value.state, "authorized", settled.value.reason);
    assert.ok(issued.register > 0 && issued.authorize > 0 && issued.token > 0);
    const authorized = await api<Account[]>("/api/authorizations");
    assert.equal(authorized.value.find((entry) => entry.name === "account")?.state, "authorized");
    assert.ok(authorized.value.every((entry) => typeof entry.checkedAt === "number"));
    evidence.scenarios.push("http-sign-in-completes-through-the-loopback-callback-and-confirms-authorization");

    const signedIn = await probe();
    assert.ok(signedIn.tools.some((name) => name.endsWith("lookup")), "the signed-in service exposes its tool");
    evidence.scenarios.push("http-signed-in-account-connects-natively-with-its-stored-credential");

    const rejectedBefore = issued.rejected;
    await app.kernel.restart();
    assert.equal((await api<Account[]>("/api/authorizations")).value.find((entry) => entry.name === "account")?.state, "authorized");
    assert.ok((await probe()).tools.length > 0, "the authorized account still connects after a kernel restart");
    assert.equal(issued.rejected, rejectedBefore, "the stored credential was used rather than rejected");
    evidence.scenarios.push("http-account-authorization-survives-kernel-restart-without-a-poller");

    const unconfirmed = await api<Account>("/api/authorizations/account/revoke", {});
    assert.equal(unconfirmed.status, 400, "revocation needs explicit confirmation");
    const revoked = await api<Account>("/api/authorizations/account/revoke", { confirmed: true });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.value.state, "signed-out");
    assert.equal((await api<Account[]>("/api/authorizations")).value.find((entry) => entry.name === "account")?.state, "signed-out");
    const rejectedAfterRevoke = issued.rejected;
    await assert.rejects(probe(), "a revoked account cannot connect");
    assert.ok(issued.rejected > rejectedAfterRevoke, "the revoked credential was rejected by the service");
    assert.equal((await api<{ name: string; auth: string }[]>("/api/connections")).value
      .find((entry) => entry.name === "account")?.auth, "oauth");
    evidence.scenarios.push("http-revocation-clears-native-credentials-keeps-the-saved-service-and-blocks-connection");

    const again = await api<Attempt>("/api/authorizations/account/start", {});
    await approve(again.value.authorizationUrl!);
    const second = await api<Attempt>("/api/authorizations/attempts/" + again.value.id + "?timeoutMs=120000");
    assert.equal(second.value.state, "authorized");
    assert.ok((await probe()).tools.length > 0, "the account signs in again after revocation");
    evidence.scenarios.push("http-a-revoked-account-can-sign-in-again-and-connect");
  }

} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await app?.close();
  await new Promise<void>((done) => service.close(() => done()));
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ root, ...evidence }, null, 2));
}
