import type { SkillDocument } from "../../../../packages/kernel-runtime/src/skill-documents";
import type { AgentSkillCatalogEntry, CapabilityInstall, Connection } from "@livingbot/contracts";
import type { AuthorizationAttempt } from "../../../../packages/kernel-runtime/src/authorizations";
import type {
  ServiceConnection,
  ServiceConnectionInput,
  ServiceConnectionUpdate,
} from "../../../../packages/kernel-runtime/src/connections";
import type { Ability } from "../../../../packages/workbench/src/contracts";
import type {
  MarketCatalog,
  PackageInstallation,
  PackagePreview,
} from "../../../../packages/workbench/src/marketplace";
import type { ServiceAuthorizationView } from "../../../../packages/workbench/src/service-authorizations";

/** The parent can pass (path, init) => request(connection, path, init). */
export type LocalAbilityRequest = <T>(path: string, init?: RequestInit) => Promise<T>;
export type LocalAbilityConnection = { origin: string; token: string };

/** Also used by the ability page before the parent RPC dispatcher is integrated. */
export function localAbilityRequest(connection: LocalAbilityConnection): LocalAbilityRequest {
  return async <T>(path: string, init?: RequestInit): Promise<T> => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${connection.token}`);
    if (init?.body) headers.set("content-type", "application/json");
    const response = await fetch(`${connection.origin}${path}`, { ...init, headers });
    if (!response.ok) {
      const failure = (await response.json().catch(() => undefined)) as
        | { error?: string; message?: string }
        | undefined;
      throw new Error(
        failure?.error ?? failure?.message ?? `能力服务请求失败 (${response.status})`,
      );
    }
    return response.json() as Promise<T>;
  };
}

/**
 * Source: workbench HTTP routes and workbench-web AbilityCenter,
 * ConnectionSettings and Marketplace callers. No second ability service.
 */
export function createLocalAbilitiesClient(request: LocalAbilityRequest) {
  const document = (id: string, path = "SKILL.md") => request<SkillDocument | null>(`/api/abilities/${encodeURIComponent(id)}/document?path=${encodeURIComponent(path)}`);
  const post = <T>(path: string, body: unknown = {}) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) });
  const botPath = (botId: string) => `/api/bots/${encodeURIComponent(botId)}/abilities`;
  return {
    document,
    startConfiguration: (id: string) => post<{botId:string;taskId:string}>(`/api/abilities/${encodeURIComponent(id)}/configure`),
    startAddition: () => post<{ botId: string; taskId: string }>("/api/abilities/addition"),
    listShared: () => request<Ability[]>("/api/abilities"),
    refreshShared: () => post<Ability[]>("/api/abilities/refresh"),
    setSharedEnabled: (id: string, enabled: boolean) =>
      post<Ability[]>(`/api/abilities/${encodeURIComponent(id)}/access`, { enabled }),
    refresh: (botId: string) => post<Ability[]>(`${botPath(botId)}/refresh`),
    setEnabled: (botId: string, id: string, enabled: boolean) =>
      post<Ability[]>(`${botPath(botId)}/${encodeURIComponent(id)}/access`, { enabled }),
    connections: () => request<ServiceConnection[]>("/api/connections"),
    addConnection: (input: ServiceConnectionInput) =>
      post<ServiceConnection[]>("/api/connections", input),
    updateConnection: (name: string, input: ServiceConnectionUpdate) =>
      post<ServiceConnection[]>(`/api/connections/${encodeURIComponent(name)}/update`, input),
    setConnectionEnabled: (name: string, enabled: boolean) =>
      post<ServiceConnection[]>(`/api/connections/${encodeURIComponent(name)}/access`, { enabled }),
    authorizations: () => request<ServiceAuthorizationView[]>("/api/authorizations"),
    startAuthorization: (name: string) =>
      post<AuthorizationAttempt>(`/api/authorizations/${encodeURIComponent(name)}/start`),
    completeAuthorization: (name: string, code: string, issuer?: string) =>
      post<ServiceAuthorizationView>(`/api/authorizations/${encodeURIComponent(name)}/code`, {
        code,
        ...(issuer ? { issuer } : {}),
      }),
    waitAuthorization: (id: string) =>
      request<AuthorizationAttempt>(
        `/api/authorizations/attempts/${encodeURIComponent(id)}?timeoutMs=0`,
      ),
    cancelAuthorization: (id: string) =>
      post<AuthorizationAttempt>(`/api/authorizations/attempts/${encodeURIComponent(id)}/cancel`),
    catalogs: () => request<MarketCatalog[]>("/api/marketplace/catalogs"),
    browseCatalog: (input: { repository: string; ref?: string; path?: string }) =>
      post<MarketCatalog>("/api/marketplace/catalog/preview", input),
    previewEntry: (catalogId: string, entryId: string) =>
      post<PackagePreview>("/api/marketplace/catalog/entry", { catalogId, entryId }),
    preview: (input: { repository: string; ref?: string; path?: string }) =>
      post<PackagePreview>("/api/marketplace/preview", input),
    installations: () => request<PackageInstallation[]>("/api/marketplace/installations"),
    install: (preview: PackagePreview, botId: string) => {
      if (preview.package.kind === "ability" && !botId) throw new Error("请选择 Bot");
      return post<PackageInstallation>("/api/marketplace/install", {
        previewId: preview.id,
        digest: preview.digest,
        ...(preview.package.kind === "ability" ? { botId } : {}),
      });
    },
    updatePackage: (installation: PackageInstallation, preview: PackagePreview) => {
      return post<PackageInstallation>("/api/marketplace/update", {
        id: installation.id,
        expectedDigest: installation.digest,
        previewId: preview.id,
        digest: preview.digest,
        replaceIdentity: false,
      });
    },
    setPackageEnabled: (id: string, enabled: boolean) =>
      post<PackageInstallation>("/api/marketplace/access", { id, enabled }),
  };
}

export type LocalAbilitiesClient = ReturnType<typeof createLocalAbilitiesClient>;

/**
 * Parent integration: call for handled paths BEFORE the generic unsupported
 * branch. Unknown procedures return undefined; unsupported legacy edits throw.
 * Old skill editing has no matching native endpoint and must never claim success.
 */
export async function localAbilitiesRpc(
  procedure: string,
  input: unknown,
  request: LocalAbilityRequest,
): Promise<unknown> {
  const path = procedure.replace(/^\//, "").replaceAll("/", ".");
  const client = createLocalAbilitiesClient(request);
  if (path === "agentSkills.list") {
    return (await client.listShared())
      .filter((item) => item.kind === "method")
      .map(
        (item): AgentSkillCatalogEntry => ({
          id: item.id,
          name: item.name,
          description: item.description,
          source: item.source === "builtin" ? "builtin" : "plugin",
          readOnly: true,
          onDemand: false,
        }),
      );
  }
  if (path === "capabilities.list") {
    return (await client.installations())
      .filter((item) => item.kind === "ability")
      .map(
        (item): CapabilityInstall => ({
          id: item.id,
          kind: "skill",
          name: item.name,
          source: `${item.source.repository}@${item.source.commit}/${item.source.path}`,
          version: item.version,
          digest: item.digest,
          secretConfigured: false,
          config: { botId: item.botId, state: item.state, skills: item.skills, error: item.error },
          createdAt: new Date(item.createdAt).toISOString(),
        }),
      );
  }
  if (path === "connections.list") {
    return (await client.authorizations())
      .filter((item) => item.authorization === "oauth")
      .map(
        (item): Connection => ({
          id: item.name,
          connectorId: "native",
          provider: item.name,
          displayName: item.name,
          status:
            item.state === "authorized"
              ? "connected"
              : item.state === "sign-in-pending"
                ? "pending"
                : item.state === "signed-out"
                  ? "revoked"
                  : "error",
          capabilities: [],
          // The native record exposes observation time, not account creation time.
          createdAt: new Date(item.checkedAt).toISOString(),
        }),
      );
  }
  if (path === "abilities.list") {
    const botId = (input as { botId?: string } | undefined)?.botId;
    return botId ? client.refresh(botId) : client.listShared();
  }
  if (path === "abilities.access") {
    const body = input as { botId?: string; id?: string; enabled?: boolean } | undefined;
    if (!body?.botId || !body.id || typeof body.enabled !== "boolean") {
      throw new Error("请选择 Bot、能力及启停状态");
    }
    return client.setEnabled(body.botId, body.id, body.enabled);
  }
  if (/^(agentSkills|capabilities|connections|mcp|marketplace)\./.test(path)) {
    throw new Error("请在统一能力中心管理本机能力；此旧接口没有对应的本机操作");
  }
  return undefined;
}
