import {
  AgentSkillCatalogEntrySchema,
  CapabilityInstallSchema,
  ConnectionSchema,
} from "@livingbot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ability } from "../../../../packages/workbench/src/contracts";
import type { PackagePreview } from "../../../../packages/workbench/src/marketplace";
import type { LocalAbilityRequest } from "./local-abilities";
import {
  createLocalAbilitiesClient,
  localAbilitiesRpc,
  localAbilityRequest,
} from "./local-abilities";

const method: Ability = {
  id: "native:skill:shared:documents",
  name: "文档处理",
  description: "处理文档",
  kind: "method",
  source: "builtin",
  version: "native",
  permissions: [],
  botIds: ["bot-a"],
  state: "enabled",
  access: { "bot-a": { enabled: true, ready: true, manageable: true } },
};
const preview: PackagePreview = {
  id: "preview-a",
  digest: "exact-digest",
  createdAt: 1,
  source: {
    repository: "example/abilities",
    commit: "a".repeat(40),
    path: "livingbot.json",
    blob: "blob-a",
  },
  package: {
    format: "livingbot-package-v1",
    id: "documents",
    name: "文档",
    kind: "ability",
    description: "处理文档",
    version: "1.0.0",
    license: "MIT",
    author: "Example",
    permissions: [],
    files: [{ path: "skills/documents/SKILL.md", text: "Example" }],
  },
};
function fixture() {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const request: LocalAbilityRequest = async <T>(path: string, init?: RequestInit): Promise<T> => {
    calls.push({
      path,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    let value: unknown;
    if (path === "/api/abilities") value = [{ ...method, botIds: ["bot-a", "bot-b"] }];
    else if (path.endsWith("/refresh")) {
      const botId = path.includes("bot-b") ? "bot-b" : "bot-a";
      value = [{ ...method, botIds: [botId], access: { [botId]: method.access!["bot-a"] } }];
    } else if (path === "/api/authorizations")
      value = [
        { name: "calendar", authorization: "oauth", state: "authorized", checkedAt: 1000 },
        { name: "pending", authorization: "oauth", state: "sign-in-pending", checkedAt: 1000 },
        { name: "revoked", authorization: "oauth", state: "signed-out", checkedAt: 1000 },
        { name: "public", authorization: "none", state: "not-required", checkedAt: 1000 },
      ];
    else if (path === "/api/marketplace/installations")
      value = [
        {
          ...preview,
          id: "installed-a",
          previewId: preview.id,
          packageId: preview.package.id,
          name: preview.package.name,
          version: preview.package.version,
          kind: "ability",
          botId: "bot-a",
          agentId: "agent-a",
          state: "failed",
          skills: [],
          error: "Native installation failed",
        },
      ];
    else if (path === "/api/marketplace/install") value = { id: "installed-a", state: "ready" };
    else if (path.includes("/marketplace/")) value = preview;
    else if (path.includes("/access"))
      value = [
        { ...method, access: { "bot-a": { enabled: false, ready: false, manageable: true } } },
      ];
    else if (path === "/api/connections")
      value = [{ name: "calendar", transport: "sse", enabled: false, auth: "oauth" }];
    else value = { id: "attempt-a", name: "calendar", state: "waiting" };
    return value as T;
  };
  return { request, calls, client: createLocalAbilitiesClient(request) };
}

afterEach(() => vi.unstubAllGlobals());

describe("original capability RPC adaptation", () => {
  it("uses the shared native catalog instead of duplicating workspace skills across Bots", async () => {
    const { request, calls } = fixture();
    const result = await localAbilitiesRpc("/agentSkills/list", undefined, request);
    expect(AgentSkillCatalogEntrySchema.array().parse(result)).toEqual([
      {
        id: method.id,
        name: method.name,
        description: method.description,
        source: "builtin",
        readOnly: true,
        onDemand: false,
      },
    ]);
    expect(calls.map((call) => call.path)).toEqual(["/api/abilities"]);
    const inventory = (await localAbilitiesRpc("abilities.list", undefined, request)) as Ability[];
    expect(inventory).toHaveLength(1);
    expect(inventory[0]!.botIds).toEqual(["bot-a", "bot-b"]);
    const own = (await localAbilitiesRpc(
      "abilities.list",
      { botId: "bot-b" },
      request,
    )) as Ability[];
    expect(own[0]!.botIds).toEqual(["bot-b"]);
    expect(calls.map((call) => call.path)).toEqual([
      "/api/abilities",
      "/api/abilities",
      "/api/bots/bot-b/abilities/refresh",
    ]);
  });

  it("keeps failed package installation state and pinned provenance", async () => {
    const { request } = fixture();
    const installs = CapabilityInstallSchema.array().parse(
      await localAbilitiesRpc("capabilities.list", {}, request),
    );
    expect(installs[0]).toMatchObject({
      id: "installed-a",
      digest: preview.digest,
      config: { state: "failed", error: "Native installation failed", botId: "bot-a" },
    });
    expect(installs[0]!.source).toContain(preview.source.commit);
  });

  it("maps account facts without marking pending or revoked accounts connected", async () => {
    const { request } = fixture();
    const accounts = ConnectionSchema.array().parse(
      await localAbilitiesRpc("connections.list", {}, request),
    );
    expect(accounts.map((item) => item.status)).toEqual(["connected", "pending", "revoked"]);
  });

  it("does not swallow inventory failures or invent unsupported edit successes", async () => {
    const request: LocalAbilityRequest = async () => {
      throw new Error("Native offline");
    };
    await expect(localAbilitiesRpc("agentSkills.list", {}, request)).rejects.toThrow(
      "Native offline",
    );
    await expect(localAbilitiesRpc("mcp.servers.list", {}, request)).rejects.toThrow("旧接口");
    await expect(localAbilitiesRpc("capabilities.remove", { id: "one" }, request)).rejects.toThrow(
      "旧接口",
    );
    expect(await localAbilitiesRpc("threads.get", {}, request)).toBeUndefined();
  });
});

describe("existing native operations", () => {
  it("encodes identities and returns confirmed access rather than an optimistic toggle", async () => {
    const { client, calls } = fixture();
    const result = await client.setEnabled("bot-a", "native:service:mcp:calendar/a", false);
    expect(calls.at(-1)).toEqual({
      path: "/api/bots/bot-a/abilities/native%3Aservice%3Amcp%3Acalendar%2Fa/access",
      method: "POST",
      body: { enabled: false },
    });
    expect(result[0]!.access!["bot-a"]!.enabled).toBe(false);
  });

  it("uses existing connection and account endpoints with native input names", async () => {
    const { client, calls } = fixture();
    await client.addConnection({
      name: "calendar",
      transport: "sse",
      url: "https://example.test/mcp",
      auth: "oauth",
    });
    await client.updateConnection("calendar/a", { url: "https://example.test/new" });
    await client.setConnectionEnabled("calendar/a", false);
    await client.startAuthorization("calendar/a");
    await client.completeAuthorization("calendar/a", "synthetic-code", "https://example.test");
    await client.waitAuthorization("attempt/a");
    await client.cancelAuthorization("attempt/a");
    expect(calls).toMatchObject([
      { path: "/api/connections", method: "POST", body: { transport: "sse", auth: "oauth" } },
      { path: "/api/connections/calendar%2Fa/update", body: { url: "https://example.test/new" } },
      { path: "/api/connections/calendar%2Fa/access", body: { enabled: false } },
      { path: "/api/authorizations/calendar%2Fa/start" },
      {
        path: "/api/authorizations/calendar%2Fa/code",
        body: { code: "synthetic-code", issuer: "https://example.test" },
      },
      { path: "/api/authorizations/attempts/attempt%2Fa?timeoutMs=0" },
      { path: "/api/authorizations/attempts/attempt%2Fa/cancel" },
    ]);
  });

  it("uses GitHub catalog and preview contracts and installs the exact reviewed digest to one Bot", async () => {
    const { client, calls } = fixture();
    await client.browseCatalog({
      repository: "example/abilities",
      ref: "main",
      path: "livingbot-market.json",
    });
    await client.previewEntry("catalog-a", "entry-a");
    await client.preview({ repository: "example/abilities", path: "livingbot.json" });
    await client.install(preview, "bot-a");
    await client.setPackageEnabled("installed-a", false);
    expect(calls).toMatchObject([
      {
        path: "/api/marketplace/catalog/preview",
        body: { repository: "example/abilities", path: "livingbot-market.json" },
      },
      {
        path: "/api/marketplace/catalog/entry",
        body: { catalogId: "catalog-a", entryId: "entry-a" },
      },
      { path: "/api/marketplace/preview" },
      {
        path: "/api/marketplace/install",
        body: { previewId: preview.id, digest: preview.digest, botId: "bot-a" },
      },
      { path: "/api/marketplace/access", body: { id: "installed-a", enabled: false } },
    ]);
    await client.install({ ...preview, package: { ...preview.package, kind: "bot" } }, "");
    expect(calls.at(-1)).toEqual({
      path: "/api/marketplace/install",
      method: "POST",
      body: { previewId: preview.id, digest: preview.digest },
    });
    expect(() => client.install(preview, "")).toThrow("请选择 Bot");
  });

  it("validates the access RPC before sending", async () => {
    const { request, calls } = fixture();
    await expect(
      localAbilitiesRpc(
        "abilities.access",
        { botId: "bot-a", id: "one", enabled: "false" },
        request,
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("updates an ability using the installed and reviewed digests without replacing Bot identity", async () => {
    const { client, calls } = fixture();
    const [installation] = await client.installations();
    await client.updatePackage(installation!, preview);
    expect(calls.at(-1)).toMatchObject({
      path: "/api/marketplace/update",
      body: {
        id: "installed-a",
        expectedDigest: installation!.digest,
        previewId: preview.id,
        digest: preview.digest,
        replaceIdentity: false,
      },
    });
  });
});

it("authenticates JSON requests and surfaces HTTP errors without an empty fallback", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify([method])))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Policy refused" }), { status: 409 }),
    )
    .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  const request = localAbilityRequest({ origin: "http://127.0.0.1:1234", token: "synthetic" });
  const client = createLocalAbilitiesClient(request);
  expect(await client.refresh("bot-a")).toEqual([method]);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe("http://127.0.0.1:1234/api/bots/bot-a/abilities/refresh");
  expect(init.headers.get("authorization")).toBe("Bearer synthetic");
  expect(init.headers.get("content-type")).toBe("application/json");
  await expect(client.setEnabled("bot-a", method.id, false)).rejects.toThrow("Policy refused");
  await expect(client.connections()).rejects.toThrow("503");
});
