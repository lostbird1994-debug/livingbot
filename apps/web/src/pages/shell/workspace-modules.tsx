import type { AgentSkillCatalogEntry, Bot } from "@livingbot/contracts";
import { PluginPreviewSchema } from "@livingbot/contracts";
import { installedPluginParts } from "@livingbot/core";
import { Button, Input, SectionHeading } from "@livingbot/ui-web";
import type { UseQueryResult } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Filter, Search, Wrench } from "lucide-react";
import { useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import { useLocation, useNavigate } from "react-router-dom";
import type { AuthorizationAttempt } from "../../../../../packages/kernel-runtime/src/authorizations";
import type { ServiceConnection } from "../../../../../packages/kernel-runtime/src/connections";
import { createLocalAbilitiesClient, localAbilityRequest } from "../../lib/local-abilities";
import { localConnected, localConnection } from "../../lib/local-workbench";
import { useSpaceQueries } from "../../lib/query";
import { ActivityList } from "../ActivityList";
import { ArtifactsPage } from "../Artifacts";
import { readShellOverlay, searchString, withShellOverlay } from "../shell-overlay";
import { LocalAbilityCenter } from "./local-ability-center";
import type { SidebarSearch } from "./use-sidebar-search";
import type { WorkspaceView } from "./workspace-navigation";
import "../local-knowledge-settings.css";

export function WorkspaceModules({
  view,
  search,
  bots,
  navigate,
  openIntegrations,
  openSkills,
}: {
  view: WorkspaceView | null;
  search: SidebarSearch;
  bots: Bot[];
  agentSkills: AgentSkillCatalogEntry[];
  navigate: NavigateFunction;
  openIntegrations: () => void;
  openSkills: () => void;
}) {
  if (view === "deliveries") return <ArtifactsPage embedded />;
  if (view === "tasks") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5 md:px-7">
          <h1 className="text-[15px] font-medium">任务</h1>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={search.activityFiltersExpanded}
            onClick={() => search.setActivityFiltersExpanded(!search.activityFiltersExpanded)}
          >
            <Filter className="size-4" />
            筛选
          </Button>
        </header>
        <div className="rk-scroll flex-1 overflow-y-auto p-5 md:p-7">
          <div className="relative mb-5 max-w-sm">
            <Search className="absolute start-3 top-2.5 size-4 text-muted-foreground" />
            <input
              aria-label="搜索任务"
              placeholder="搜索任务"
              type="search"
              value={search.activityFilters.query}
              onChange={(event) =>
                search.setActivityFilters({ ...search.activityFilters, query: event.target.value })
              }
              className="h-9 w-full rounded-lg border border-border bg-background pe-3 ps-9 text-sm outline-none focus:border-ring"
            />
          </div>
          <ActivityList
            filters={search.activityFilters}
            onFiltersChange={search.setActivityFilters}
            filtersExpanded={search.activityFiltersExpanded}
            filtersId="workspace-task-filters"
            onOpenRun={(run) =>
              navigate(run.groupId ? `/app/g/${run.groupId}` : `/app/${run.botId}`)
            }
          />
        </div>
      </div>
    );
  }
  if (localConnected()) return <LocalAbilities bots={bots} />;
  return (
    <Abilities
      bots={bots}
      navigate={navigate}
      openIntegrations={openIntegrations}
      openSkills={openSkills}
    />
  );
}

// The connection remains owned by the parent adapter; resolve it for every call
// so reconnect/sign-out cannot retain an obsolete bearer token in this module.
const localAbilities = createLocalAbilitiesClient(async (path, init) => {
  const connection = await localConnection();
  if (!connection) throw new Error("本机服务未连接");
  return localAbilityRequest(connection)(path, init);
});

export function LocalAbilities({ bots: _bots }: { bots: Bot[] }) {
  const navigate = useNavigate();
  const setupId = new URLSearchParams(useLocation().search).get("capability-setup");
  return (
    <LocalAbilityCenter
      client={localAbilities}
      setupId={setupId}
      onConfigure={async id => { const result = await localAbilities.startConfiguration(id); navigate(`/app/${result.botId}`); }}
      onAddition={async () => { const result = await localAbilities.startAddition(); navigate(`/app/${result.botId}`); }}
      renderConnections={(onChanged, selectedName) => (
        <LocalConnections onChanged={onChanged} expanded selectedName={selectedName} />
      )}
    />
  );
}

function LocalConnections({
  onChanged,
  expanded = false,
  selectedName,
}: {
  onChanged: () => Promise<unknown>;
  expanded?: boolean;
  selectedName?: string;
}) {
  const [open, setOpen] = useState(expanded);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [transport, setTransport] = useState<ServiceConnection["transport"]>("streamable-http");
  const [args, setArgs] = useState("");
  const [account, setAccount] = useState(false);
  const [attempt, setAttempt] = useState<AuthorizationAttempt>();
  const [code, setCode] = useState("");
  const [issuer, setIssuer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const connections = useQuery({
    queryKey: ["local-ability-connections"],
    queryFn: () => localAbilities.connections(),
    enabled: open,
    retry: false,
  });
  const accounts = useQuery({
    queryKey: ["local-ability-accounts"],
    queryFn: () => localAbilities.authorizations(),
    enabled: open,
    retry: false,
  });
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await Promise.all([
        connections.refetch({ throwOnError: true }),
        accounts.refetch({ throwOnError: true }),
        onChanged(),
      ]);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="mb-4 border-b border-border pb-4"
      open={expanded || undefined}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className={`cursor-pointer text-sm ${expanded ? "sr-only" : ""}`}>应用连接</summary>
      {open && (
        <div className="mt-3 space-y-3">
          <InventoryStatus label="连接" query={connections} />
          <InventoryStatus label="账号" query={accounts} />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {(connections.data ?? [])
            .filter((item) => !selectedName || item.name === selectedName)
            .map((item) => (
              <div key={item.name} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="flex-1 break-words">{item.name}</span>
                {item.auth === "oauth" && (
                  <span className="text-xs text-muted-foreground">
                    {accounts.isError
                      ? "状态读取失败"
                      : accounts.data?.find((entry) => entry.name === item.name)?.state ===
                          "authorized"
                        ? "已登录"
                        : "待授权"}
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act(() => localAbilities.setConnectionEnabled(item.name, !item.enabled))
                  }
                >
                  {item.enabled ? "停用" : "启用"}
                </Button>
                {item.auth === "oauth" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || attempt?.state === "waiting"}
                    onClick={() =>
                      void act(async () =>
                        setAttempt(await localAbilities.startAuthorization(item.name)),
                      )
                    }
                  >
                    登录
                  </Button>
                )}
              </div>
            ))}
          {attempt && (
            <div className="space-y-2 text-sm">
              <p>
                {attempt.name} ·{" "}
                {attempt.state === "authorized"
                  ? "已登录"
                  : attempt.state === "waiting"
                    ? "等待授权"
                    : (attempt.reason ?? attempt.state)}
              </p>
              {attempt.state === "waiting" && (
                <>
                  {attempt.authorizationUrl && /^https?:\/\//i.test(attempt.authorizationUrl) && (
                    <a
                      href={attempt.authorizationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      打开授权页面
                    </a>
                  )}
                  <Input
                    aria-label="授权码"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    autoComplete="off"
                  />
                  <Input
                    aria-label="授权服务器（可不填）"
                    placeholder="授权服务器（可不填）"
                    value={issuer}
                    onChange={(event) => setIssuer(event.target.value)}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !code.trim()}
                    onClick={() =>
                      void act(async () => {
                        await localAbilities.completeAuthorization(
                          attempt.name,
                          code.trim(),
                          issuer.trim(),
                        );
                        setCode("");
                        setIssuer("");
                        setAttempt(undefined);
                      })
                    }
                  >
                    提交授权码
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(async () =>
                        setAttempt(await localAbilities.waitAuthorization(attempt.id)),
                      )
                    }
                  >
                    检查授权
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(async () =>
                        setAttempt(await localAbilities.cancelAuthorization(attempt.id)),
                      )
                    }
                  >
                    取消登录
                  </Button>
                </>
              )}
            </div>
          )}
          {!selectedName && (
            <details open={expanded || undefined}>
              <summary className="cursor-pointer text-sm">添加连接</summary>
              <form
                className="mt-3 space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(async () => {
                    await localAbilities.addConnection({
                      name: name.trim(),
                      transport,
                      ...(transport === "stdio"
                        ? { command: address.trim(), args: args ? args.split("\n") : [] }
                        : { url: address.trim(), auth: account ? "oauth" : "none" }),
                    });
                    setName("");
                    setAddress("");
                    setArgs("");
                  });
                }}
              >
                <Input
                  aria-label="连接名称"
                  placeholder="名称"
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <details>
                  <summary className="cursor-pointer text-sm">连接方式</summary>
                  <select
                    aria-label="连接方式"
                    className="mt-2 rounded border border-border bg-background p-2 text-sm"
                    value={transport}
                    onChange={(event) => {
                      setTransport(event.target.value as ServiceConnection["transport"]);
                      setAddress("");
                    }}
                  >
                    <option value="streamable-http">远程服务</option>
                    <option value="sse">远程服务（SSE）</option>
                    <option value="stdio">本机程序</option>
                  </select>
                </details>
                <Input
                  aria-label={transport === "stdio" ? "程序命令" : "服务地址"}
                  placeholder={transport === "stdio" ? "程序命令" : "服务地址"}
                  type={transport === "stdio" ? "text" : "url"}
                  required
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                />
                {transport === "stdio" ? (
                  <textarea
                    aria-label="程序参数（每行一个）"
                    placeholder="程序参数（每行一个）"
                    value={args}
                    className="w-full rounded border border-border bg-background p-2 text-sm"
                    onChange={(event) => setArgs(event.target.value)}
                  />
                ) : (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={account}
                      onChange={(event) => setAccount(event.target.checked)}
                    />
                    需要账号登录
                  </label>
                )}
                <Button variant="outline" size="sm" disabled={busy}>
                  保存连接
                </Button>
              </form>
            </details>
          )}
        </div>
      )}
    </details>
  );
}

function InventoryStatus({
  label,
  query,
}: {
  label: string;
  query: Pick<UseQueryResult, "isPending" | "isError" | "isFetching" | "refetch">;
}) {
  if (query.isError) {
    return (
      <div role="alert" className="flex items-center gap-3 py-3 text-sm text-destructive">
        <span>{label}加载失败</span>
        <Button
          variant="ghost"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          重试
        </Button>
      </div>
    );
  }
  return query.isPending ? (
    <p role="status" className="py-3 text-sm text-muted-foreground">
      正在加载{label}…
    </p>
  ) : null;
}

function Abilities({
  bots,
  navigate,
  openIntegrations,
  openSkills,
}: {
  bots: Bot[];
  navigate: NavigateFunction;
  openIntegrations: () => void;
  openSkills: () => void;
}) {
  const queries = useSpaceQueries();
  const location = useLocation();
  // Management dialogs also write their own caches; read fresh inventory when they close.
  const inventoryOptions = {
    enabled: readShellOverlay(new URLSearchParams(location.search)) === null,
    staleTime: 0,
  };
  const connections = useQuery(queries.connections.list.queryOptions(inventoryOptions));
  const servers = useQuery(queries.mcp.servers.list.queryOptions(inventoryOptions));
  const installs = useQuery(queries.capabilities.list.queryOptions(inventoryOptions));
  const skills = useQuery(queries.agentSkills.list.queryOptions(inventoryOptions));
  const appInstalls = (installs.data ?? []).filter(
    (install) =>
      install.kind === "mcp" ||
      install.kind === "api" ||
      install.kind === "graphql" ||
      (install.kind === "plugin" && installedPluginParts(install.config).includes("connector")),
  );
  const appInstallIds = new Set(appInstalls.map((install) => install.id));
  const standaloneServers = (servers.data ?? []).filter(
    (server) => !server.installId || !appInstallIds.has(server.installId),
  );
  const accounts = (connections.data ?? []).filter((connection) => connection.status !== "revoked");
  const skillSets = (installs.data ?? []).flatMap((install) => {
    if (install.kind !== "plugin" || !installedPluginParts(install.config).includes("skills"))
      return [];
    const preview = PluginPreviewSchema.safeParse(install.config);
    return preview.success && preview.data.skills.length > 0 ? [install] : [];
  });
  const connectionQueries = [
    { label: "连接", query: connections },
    { label: "工具", query: servers },
    { label: "已安装应用", query: installs },
  ];
  const skillQueries = [
    { label: "技能", query: skills },
    { label: "技能包", query: installs },
  ];
  const rowClassName =
    "flex w-full items-start gap-3 px-1 py-4 text-start hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  function openBotSettings(botId: string) {
    navigate({
      pathname: location.pathname,
      search: searchString(
        withShellOverlay(new URLSearchParams(location.search), {
          kind: "settings",
          section: "bot-tools",
          spaceId: null,
          botId,
        }),
      ),
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center border-b border-border px-5 md:px-7">
        <h1 className="text-[15px] font-medium">共享能力</h1>
      </header>
      <div className="rk-scroll flex-1 overflow-y-auto p-5 md:p-7">
        <div className="mb-7 flex flex-wrap gap-3">
          <Button variant="outline" onClick={openIntegrations}>
            <Wrench className="size-4" />
            应用与工具
          </Button>
          <Button variant="outline" onClick={openSkills}>
            <BookOpen className="size-4" />
            技能
          </Button>
        </div>
        <SectionHeading className="mb-3">应用与工具</SectionHeading>
        <div className="max-w-3xl divide-y divide-border border-y border-border">
          {connectionQueries.map(({ label, query }) => (
            <InventoryStatus key={label} label={label} query={query} />
          ))}
          {accounts.map((connection) => (
            <button
              key={`connection:${connection.id}`}
              type="button"
              onClick={openIntegrations}
              className={rowClassName}
            >
              <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 break-words text-sm font-medium">
                {connection.displayName}
              </span>
              <span
                className={`shrink-0 text-xs ${connection.status === "error" ? "text-destructive" : "text-muted-foreground"}`}
              >
                {connection.status === "connected"
                  ? "已连接"
                  : connection.status === "pending"
                    ? "待授权"
                    : "连接异常"}
              </span>
            </button>
          ))}
          {appInstalls.map((install) => (
            <button
              key={`install:${install.id}`}
              type="button"
              onClick={openIntegrations}
              className={rowClassName}
            >
              <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 break-words text-sm font-medium">{install.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">已安装</span>
            </button>
          ))}
          {standaloneServers.map((server) => (
            <button
              key={`server:${server.id}`}
              type="button"
              onClick={openIntegrations}
              className={rowClassName}
            >
              <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm font-medium">{server.name}</span>
                {server.description ? (
                  <span className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {server.description}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {!server.enabled
                  ? "已停用"
                  : server.oauthStatus === "reconnect"
                    ? "需重新授权"
                    : server.health.status === "ok"
                      ? "可用"
                      : server.health.status === "error"
                        ? "连接异常"
                        : server.health.status === "installing"
                          ? "安装中"
                          : "待检查"}
              </span>
            </button>
          ))}
          {connectionQueries.every(({ query }) => query.isSuccess) &&
          accounts.length + appInstalls.length + standaloneServers.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">暂无应用与工具</p>
          ) : null}
        </div>
        <SectionHeading className="mb-3 mt-8">已安装技能</SectionHeading>
        <div className="max-w-3xl divide-y divide-border border-y border-border">
          {skillQueries.map(({ label, query }) => (
            <InventoryStatus key={label} label={label} query={query} />
          ))}
          {(skills.data ?? []).map((skill) => (
            <button key={skill.id} type="button" onClick={openSkills} className={rowClassName}>
              <BookOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{skill.name}</span>
                <span className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {skill.description}
                </span>
              </span>
            </button>
          ))}
          {skillSets.map((install) => (
            <button
              key={`pack:${install.id}`}
              type="button"
              onClick={openSkills}
              className={rowClassName}
            >
              <BookOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 break-words text-sm font-medium">{install.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">技能包</span>
            </button>
          ))}
          {skillQueries.every(({ query }) => query.isSuccess) &&
          !skills.data?.length &&
          !skillSets.length ? (
            <p className="py-6 text-sm text-muted-foreground">暂无已安装技能</p>
          ) : null}
        </div>
        <SectionHeading className="mb-3 mt-8">Bot 能力配置</SectionHeading>
        <div className="flex flex-wrap gap-2">
          {bots.map((bot) => (
            <Button
              key={bot.id}
              variant="outline"
              size="sm"
              onClick={() => openBotSettings(bot.id)}
            >
              {bot.name}
            </Button>
          ))}
          {bots.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">暂无 Bot</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
