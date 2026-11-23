import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@livingbot/ui-web/components/ui/alert-dialog";
import { Button } from "@livingbot/ui-web/components/ui/button";
import { Input } from "@livingbot/ui-web/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@livingbot/ui-web/components/ui/native-select";
import { Textarea } from "@livingbot/ui-web/components/ui/textarea";
import { Pencil, Plug, Plus, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { AuthorizationAttempt } from "../../../packages/kernel-runtime/src/authorizations.ts";
import type {
  ServiceConnection,
  ServiceConnectionInput,
  ServiceConnectionUpdate,
} from "../../../packages/kernel-runtime/src/connections.ts";
import type { ServiceAuthorizationView } from "../../../packages/workbench/src/service-authorizations.ts";
import type { WorkbenchClient } from "./client.ts";

export function ConnectionSettings({
  client,
  onChanged,
  embedded = false,
  onBusyChange,
}: {
  client: WorkbenchClient;
  onChanged(): void;
  embedded?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const formId = useId();
  const [open, setOpen] = useState(embedded);
  const [connections, setConnections] = useState<ServiceConnection[]>([]);
  const [authorizations, setAuthorizations] = useState<ServiceAuthorizationView[]>([]);
  const [attempt, setAttempt] = useState<AuthorizationAttempt>();
  const [code, setCode] = useState("");
  const [issuer, setIssuer] = useState("");
  const [codeFor, setCodeFor] = useState<string>();
  const [cancelling, setCancelling] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ServiceConnection>();
  const [removing, setRemoving] = useState<ServiceConnection>();
  const [revoking, setRevoking] = useState<ServiceConnection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<ServiceConnection["transport"]>("streamable-http");
  const [address, setAddress] = useState("");
  const [args, setArgs] = useState("");
  const [argsChanged, setArgsChanged] = useState(false);
  const [parameters, setParameters] = useState("");
  const [account, setAccount] = useState(false);
  const [scope, setScope] = useState("");

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  function reset() {
    setAdding(false);
    setEditing(undefined);
    setName("");
    setAddress("");
    setArgs("");
    setArgsChanged(false);
    setParameters("");
    setAccount(false);
    setScope("");
    setCode("");
    setIssuer("");
    setCodeFor(undefined);
    setError(undefined);
  }

  useEffect(() => {
    if (!open) return;
    let live = true;
    setBusy(true);
    setError(undefined);
    void Promise.all([
      client.request<ServiceConnection[]>("/api/connections"),
      client
        .request<ServiceAuthorizationView[]>("/api/authorizations")
        .catch(() => [] as ServiceAuthorizationView[]),
    ])
      .then(([items, accounts]) => {
        if (live) {
          setConnections(items);
          setAuthorizations(accounts);
        }
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [client, open]);

  function accountFor(connection: ServiceConnection) {
    return authorizations.find((item) => item.name === connection.name);
  }

  function accountLabel(connection: ServiceConnection): string | undefined {
    if (connection.auth !== "oauth") return undefined;
    const state = accountFor(connection)?.state;
    if (state === "authorized") return "已登录";
    if (state === "sign-in-pending") return "授权未完成";
    if (state === "not-required") return accountFor(connection)?.reason ?? "不需要登录";
    return state === undefined ? undefined : "未登录";
  }

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      let extra: Record<string, string | null> | null | undefined;
      if (parameters.trim()) {
        const parsed: unknown = JSON.parse(parameters);
        if (parsed === null && editing) extra = null;
        else {
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            Object.values(parsed).some(
              (value) => typeof value !== "string" && !(editing && value === null),
            )
          ) {
            throw new Error("参数应为名称与文字值组成的 JSON 对象");
          }
          extra = parsed as Record<string, string | null>;
        }
      }
      // Local programs cannot use account sign-in, so they never send the setting.
      const signIn =
        transport === "stdio" ? undefined : account ? ("oauth" as const) : ("none" as const);
      const oauth = signIn === "oauth" && scope.trim() ? { scope: scope.trim() } : undefined;
      const input: ServiceConnectionInput | ServiceConnectionUpdate = editing
        ? {
            ...(transport === "stdio"
              ? {
                  ...(address ? { command: address } : {}),
                  ...(argsChanged ? { args: args ? args.split("\n") : [] } : {}),
                  ...(extra !== undefined ? { env: extra } : {}),
                }
              : {
                  ...(address ? { url: address } : {}),
                  ...(extra !== undefined ? { headers: extra } : {}),
                  ...(signIn ? { auth: signIn } : {}),
                  ...(oauth ? { oauth } : {}),
                }),
          }
        : {
            name,
            transport,
            ...(transport === "stdio"
              ? {
                  command: address,
                  args: args ? args.split("\n") : [],
                  ...(extra ? { env: extra as Record<string, string> } : {}),
                }
              : {
                  url: address,
                  ...(extra ? { headers: extra as Record<string, string> } : {}),
                  ...(signIn ? { auth: signIn } : {}),
                  ...(oauth ? { oauth } : {}),
                }),
          };
      setConnections(
        await client.request<ServiceConnection[]>(
          editing
            ? `/api/connections/${encodeURIComponent(editing.name)}/update`
            : "/api/connections",
          input,
        ),
      );
      // A newly saved account connection should show its real state immediately.
      setAuthorizations(
        await client
          .request<ServiceAuthorizationView[]>("/api/authorizations")
          .catch(() => authorizations),
      );
      reset();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    setError(undefined);
    try {
      setConnections(
        await client.request<ServiceConnection[]>(
          `/api/connections/${encodeURIComponent(removing.name)}/remove`,
          { confirmed: true },
        ),
      );
      if (editing?.name === removing.name) reset();
      setRemoving(undefined);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(connection: ServiceConnection) {
    setBusy(true);
    setError(undefined);
    try {
      setConnections(
        await client.request<ServiceConnection[]>(
          `/api/connections/${encodeURIComponent(connection.name)}/access`,
          { enabled: !connection.enabled },
        ),
      );
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function signIn(connection: ServiceConnection) {
    setBusy(true);
    setError(undefined);
    setAttempt(undefined);
    setCodeFor(undefined);
    try {
      setAttempt(
        await client.request<AuthorizationAttempt>(
          `/api/authorizations/${encodeURIComponent(connection.name)}/start`,
          {},
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function checkSignIn() {
    if (!attempt) return;
    setBusy(true);
    setError(undefined);
    try {
      const settled = await client.request<AuthorizationAttempt>(
        `/api/authorizations/attempts/${encodeURIComponent(attempt.id)}?timeoutMs=120000`,
      );
      setAttempt(settled);
      setAuthorizations(await client.request<ServiceAuthorizationView[]>("/api/authorizations"));
      if (settled.state === "authorized") {
        setAttempt(undefined);
        onChanged();
      } else if (settled.state !== "waiting") {
        setCodeFor(settled.name);
        onChanged();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function cancelSignIn() {
    if (!attempt) return;
    setBusy(true);
    setCancelling(true);
    setError(undefined);
    try {
      await client.request<AuthorizationAttempt>(
        `/api/authorizations/attempts/${encodeURIComponent(attempt.id)}/cancel`,
        {},
      );
      // Re-read after cancelling: the cancelled attempt no longer defines the row.
      setAuthorizations(await client.request<ServiceAuthorizationView[]>("/api/authorizations"));
      setAttempt(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setCancelling(false);
    }
  }

  async function submitCode() {
    if (!codeFor || !code.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const confirmed = await client.request<ServiceAuthorizationView>(
        `/api/authorizations/${encodeURIComponent(codeFor)}/code`,
        {
          code: code.trim(),
          ...(issuer.trim() ? { issuer: issuer.trim() } : {}),
        },
      );
      setAuthorizations((items) =>
        [...items.filter((item) => item.name !== confirmed.name), confirmed].sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      );
      setCodeFor(undefined);
      setAttempt(undefined);
      setCode("");
      setIssuer("");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    setError(undefined);
    try {
      const removed = await client.request<ServiceAuthorizationView>(
        `/api/authorizations/${encodeURIComponent(revoking.name)}/revoke`,
        { confirmed: true },
      );
      setAuthorizations((items) =>
        [...items.filter((item) => item.name !== removed.name), removed].sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      );
      setRevoking(undefined);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details
      className="connection-settings"
      open={embedded || undefined}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className={embedded ? "sr-only" : undefined}>
        <Plug size={16} /> 连接与账号
      </summary>
      {open && (
        <div className="connection-content">
          <p className="empty-label">所有伙伴共用</p>
          {error && !removing && !revoking && (
            <p className="text-destructive" role="alert">
              {error}
            </p>
          )}
          {connections.map((connection) => {
            const label = accountLabel(connection);
            const authorized = accountFor(connection)?.state === "authorized";
            return (
              <div className="connection-row" key={connection.name}>
                <span>
                  {connection.name}
                  {label && <small className="empty-label"> · {label}</small>}
                </span>
                <div className="connection-actions">
                  {connection.auth === "oauth" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-label={`${authorized ? "撤销授权" : "登录"} ${connection.name}`}
                      onClick={() =>
                        authorized ? setRevoking(connection) : void signIn(connection)
                      }
                    >
                      {authorized ? "撤销授权" : "登录"}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void toggle(connection)}
                    aria-label={`${connection.enabled ? "全局停用" : "全局启用"} ${connection.name}`}
                  >
                    {connection.enabled ? "全局停用" : "全局启用"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                    aria-label={`编辑 ${connection.name}`}
                    onClick={() => {
                      reset();
                      setEditing(connection);
                      setName(connection.name);
                      setTransport(connection.transport);
                      setAccount(connection.auth === "oauth");
                    }}
                  >
                    <Pencil size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                    aria-label={`移除 ${connection.name}`}
                    onClick={() => setRemoving(connection)}
                  >
                    <X size={14} />
                  </Button>
                </div>
              </div>
            );
          })}
          {attempt && (
            <div className="connection-form">
              <p className="empty-label">
                {attempt.reason ?? `在浏览器完成 ${attempt.name} 的登录，然后回到这里确认。`}
              </p>
              {attempt.authorizationUrl && (
                <a
                  className="marketplace-link"
                  href={attempt.authorizationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  打开登录页面
                </a>
              )}
              <div className="marketplace-actions">
                {attempt.state === "waiting" && (
                  <Button disabled={busy} onClick={() => void checkSignIn()}>
                    {busy ? "确认中…" : "完成登录"}
                  </Button>
                )}
                <Button variant="ghost" disabled={busy} onClick={() => void cancelSignIn()}>
                  {cancelling ? "正在取消…" : "取消"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setCodeFor(attempt.name);
                    setAttempt(undefined);
                  }}
                >
                  改用授权码
                </Button>
              </div>
            </div>
          )}
          {codeFor && (
            <form
              className="connection-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitCode();
              }}
            >
              <p className="empty-label">浏览器没有回到本机时，粘贴它给出的授权码。</p>
              <label htmlFor={`${formId}-code`}>
                授权码
                <Input
                  id={`${formId}-code`}
                  value={code}
                  disabled={busy}
                  onChange={(event) => setCode(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label htmlFor={`${formId}-issuer`}>
                授权来源（浏览器地址里的 iss，可不填）
                <Input
                  id={`${formId}-issuer`}
                  value={issuer}
                  disabled={busy}
                  onChange={(event) => setIssuer(event.target.value)}
                  type="url"
                  autoComplete="off"
                />
              </label>
              <div className="ability-bots">
                <Button type="submit" disabled={busy || !code.trim()}>
                  {busy ? "确认中…" : "完成登录"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setCodeFor(undefined)}
                >
                  取消
                </Button>
              </div>
            </form>
          )}
          {!adding && !editing ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                reset();
                setTransport("streamable-http");
                setAdding(true);
              }}
            >
              <Plus size={15} /> 添加服务
            </Button>
          ) : (
            <form
              className="connection-form"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <label htmlFor={`${formId}-name`}>
                名称
                <Input
                  id={`${formId}-name`}
                  value={name}
                  disabled={busy}
                  readOnly={Boolean(editing)}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={100}
                  autoComplete="off"
                />
              </label>
              <label htmlFor={`${formId}-transport`}>
                连接方式
                <NativeSelect
                  id={`${formId}-transport`}
                  value={transport}
                  disabled={busy || Boolean(editing)}
                  onChange={(event) => {
                    setTransport(event.target.value as ServiceConnection["transport"]);
                    setAddress("");
                    setArgs("");
                    setParameters("");
                    setAccount(false);
                  }}
                >
                  <NativeSelectOption value="streamable-http">远程服务</NativeSelectOption>
                  <NativeSelectOption value="sse">远程服务（SSE）</NativeSelectOption>
                  <NativeSelectOption value="stdio">本机程序</NativeSelectOption>
                </NativeSelect>
              </label>
              <label htmlFor={`${formId}-address`}>
                {transport === "stdio" ? "程序命令" : "服务地址"}
                <Input
                  id={`${formId}-address`}
                  value={address}
                  disabled={busy}
                  onChange={(event) => setAddress(event.target.value)}
                  required={!editing}
                  placeholder={editing ? "留空保留当前设置" : undefined}
                  type={transport === "stdio" ? "text" : "url"}
                  autoComplete="off"
                />
              </label>
              {transport !== "stdio" && (
                <label className="marketplace-review">
                  <input
                    type="checkbox"
                    checked={account}
                    disabled={busy}
                    onChange={(event) => setAccount(event.target.checked)}
                  />
                  需要账号登录
                </label>
              )}
              {account && transport !== "stdio" && (
                <label htmlFor={`${formId}-scope`}>
                  授权范围（可不填）
                  <Input
                    id={`${formId}-scope`}
                    value={scope}
                    disabled={busy}
                    onChange={(event) => setScope(event.target.value)}
                    autoComplete="off"
                  />
                </label>
              )}
              {transport === "stdio" && (
                <div>
                  <label htmlFor={`${formId}-args`}>
                    程序参数（每行一个）
                    <Textarea
                      id={`${formId}-args`}
                      value={args}
                      disabled={busy}
                      placeholder={editing ? "留空保留当前参数" : undefined}
                      onChange={(event) => {
                        setArgs(event.target.value);
                        setArgsChanged(true);
                      }}
                    />
                  </label>
                  {editing && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setArgs("");
                        setArgsChanged(true);
                      }}
                    >
                      {argsChanged && !args ? "将清空程序参数" : "清空程序参数"}
                    </Button>
                  )}
                </div>
              )}
              <details>
                <summary>高级参数</summary>
                <label htmlFor={`${formId}-parameters`}>
                  {transport === "stdio" ? "环境变量（JSON）" : "请求头（JSON）"}
                  <Textarea
                    id={`${formId}-parameters`}
                    value={parameters}
                    disabled={busy}
                    onChange={(event) => setParameters(event.target.value)}
                    placeholder={editing ? "留空保留；输入 null 清空" : undefined}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              </details>
              <div className="ability-bots">
                <Button type="submit" disabled={busy}>
                  {busy ? "保存中…" : editing ? "保存修改" : "保存连接"}
                </Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={reset}>
                  取消
                </Button>
              </div>
            </form>
          )}
          <AlertDialog
            open={Boolean(removing)}
            onOpenChange={(next) => {
              if (!next && !busy) setRemoving(undefined);
            }}
          >
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>移除 {removing?.name}？</AlertDialogTitle>
                <AlertDialogDescription>
                  所有伙伴将停止使用此连接。重新使用时需要添加。
                </AlertDialogDescription>
              </AlertDialogHeader>
              {error && (
                <p className="text-destructive" role="alert">
                  {error}
                </p>
              )}
              <AlertDialogFooter>
                <Button variant="ghost" disabled={busy} onClick={() => setRemoving(undefined)}>
                  取消
                </Button>
                <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
                  {busy ? "移除中…" : "移除连接"}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <AlertDialog
            open={Boolean(revoking)}
            onOpenChange={(next) => {
              if (!next && !busy) setRevoking(undefined);
            }}
          >
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>撤销 {revoking?.name} 的登录？</AlertDialogTitle>
                <AlertDialogDescription>
                  已保存的登录凭据会被清除，服务会保留。再次使用时需要重新登录。
                </AlertDialogDescription>
              </AlertDialogHeader>
              {error && (
                <p className="text-destructive" role="alert">
                  {error}
                </p>
              )}
              <AlertDialogFooter>
                <Button variant="ghost" disabled={busy} onClick={() => setRevoking(undefined)}>
                  取消
                </Button>
                <Button variant="destructive" disabled={busy} onClick={() => void revoke()}>
                  {busy ? "撤销中…" : "撤销授权"}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
    </details>
  );
}
