import {
  Button,
  Input,
  NativeSelect,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Switch,
} from "@livingbot/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { Ability } from "../../../../../packages/workbench/src/contracts";
import { abilityDisplay as presentAbility } from "../../lib/ability-display";
import type { LocalAbilitiesClient } from "../../lib/local-abilities";
import { SkillDocumentView } from "./skill-document";

type Access = { enabled: boolean; ready: boolean; manageable: boolean; reason?: string };
export function sharedAbilityAccess(ability: Ability): Access {
  const access = ability.configuration?.sharedAccess as Access | undefined;
  // Old cached inventories may predate the common policy endpoint.
  return access ?? { enabled: false, ready: false, manageable: false, reason: "请刷新能力状态" };
}
function status(ability: Ability) {
  const access = sharedAbilityAccess(ability);
  return !access.enabled ? "已停用" : access.ready ? "可用" : "需配置";
}
function native(ability: Ability) {
  return ability.configuration?.native as
    | { nativeName?: string; nativeKind?: string; serverName?: string }
    | undefined;
}
function serviceTools(ability: Ability, inventory: Ability[]) {
  if (native(ability)?.nativeKind !== "service") return [];
  const name = native(ability)?.nativeName;
  return inventory.filter(
    (item) =>
      native(item)?.nativeKind === "tool" &&
      (item.source === name || native(item)?.serverName === name),
  );
}

/** Existing native inventory and connection forms, presented as one shared list. */
export function LocalAbilityCenter({
  client,
  renderConnections,
  onAddition,
  onConfigure,
  setupId,
}: {
  client: LocalAbilitiesClient;
  onAddition?: () => Promise<void>;
  onConfigure?: (id: string) => Promise<void>;
  setupId?: string | null;
  renderConnections: (onChanged: () => Promise<unknown>, name?: string) => ReactNode;
}) {
  const [search, setSearch] = useState("");
  const [type, setType] = useState("全部");
  const [origin, setOrigin] = useState("");
  const [state, setState] = useState("");
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const inventory = useQuery({
    queryKey: ["local-abilities", "shared"],
    queryFn: () => client.refreshShared(),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const items = inventory.data ?? [];
  const current = items.find((item) => item.id === selected);
  const display = current && presentAbility(current);
  useEffect(() => {
    if (setupId) setSelected(setupId);
  }, [setupId]);
  const childIds = new Set(
    items.flatMap((item) => serviceTools(item, items).map((child) => child.id)),
  );
  const term = search.trim().toLocaleLowerCase();
  const visible = items.filter((item) => {
    const info = presentAbility(item);
    const children = serviceTools(item, items);
    const haystack = [
      info.name,
      info.description,
      info.originalName,
      item.description,
      ...children.flatMap((child) => [child.name, child.description, presentAbility(child).name]),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return (
      (type === "工具" || !childIds.has(item.id)) &&
      (type === "全部" ||
        (type === "工具" ? native(item)?.nativeKind === "tool" : info.type === type)) &&
      (!origin || origin === info.origin) &&
      (!state || state === status(item)) &&
      haystack.includes(term)
    );
  });
  async function refresh() {
    setError("");
    try {
      await inventory.refetch({ throwOnError: true });
    } catch (cause) {
      setError(String(cause));
    }
  }
  async function change(ability: Ability, enabled: boolean) {
    setBusy(ability.id);
    setError("");
    try {
      await client.setSharedEnabled(ability.id, enabled);
      await inventory.refetch({ throwOnError: true });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy("");
    }
  }
  async function configure(id: string) {
    setBusy(id);
    setError("");
    try {
      if (onConfigure) await onConfigure(id);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border px-5 md:px-7">
        <h1 className="text-[15px] font-medium">共享能力</h1>
        <span className="border-l border-border pl-4 text-xs text-muted-foreground">
          所有 Bot 共用
        </span>
        <Button
          size="sm"
          className="ml-auto"
          disabled={Boolean(busy)}
          onClick={async () => {
            setBusy("addition");
            setError("");
            try {
              if (onAddition) await onAddition();
            } catch (cause) {
              setError(String(cause));
            } finally {
              setBusy("");
            }
          }}
        >
          <Plus className="size-4" />
          添加能力
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col px-5 pt-4 md:px-7">
        <fieldset className="flex shrink-0 gap-6 border-b border-border" aria-label="能力类型">
          {["全部", "技能", "应用连接", "工具"].map((label) => (
            <button
              key={label}
              type="button"
              aria-pressed={type === label}
              onClick={() => setType(label)}
              className={`border-b-2 pb-3 text-sm transition-colors ${type === label ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              {label}
            </button>
          ))}
        </fieldset>
        <div className="flex shrink-0 flex-wrap gap-2 py-4">
          <div className="relative min-w-44 flex-1">
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input
              aria-label="搜索能力"
              placeholder="搜索能力名称或用途"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-9"
            />
          </div>
          <NativeSelect
            aria-label="筛选来源"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
          >
            <option value="">全部来源</option>
            <option>系统内置</option>
            <option>自行添加</option>
          </NativeSelect>
          <NativeSelect
            aria-label="筛选状态"
            value={state}
            onChange={(event) => setState(event.target.value)}
          >
            <option value="">全部状态</option>
            <option>可用</option>
            <option>需配置</option>
            <option>已停用</option>
          </NativeSelect>
          <Button
            variant="outline"
            size="icon"
            aria-label="刷新能力"
            disabled={inventory.isFetching || Boolean(busy)}
            onClick={() => void refresh()}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
        {(error || inventory.isError) && (
          <p role="alert" className="pb-3 text-sm text-destructive">
            {error || String(inventory.error)}
          </p>
        )}
        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto rounded-t-xl border border-b-0 border-border">
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col />
              <col className="hidden w-24 md:table-column" />
              <col className="hidden w-28 lg:table-column" />
              <col className="w-20 md:w-24" />
              <col className="w-24 md:w-28" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-normal">能力</th>
                <th className="hidden px-3 text-left font-normal md:table-cell">类型</th>
                <th className="hidden px-3 text-left font-normal lg:table-cell">来源</th>
                <th className="text-left font-normal">状态</th>
                <th className="pr-4 text-right font-normal">启用</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map((item) => {
                const info = presentAbility(item),
                  access = sharedAbilityAccess(item),
                  value = status(item);
                return (
                  <tr key={item.id}>
                    <td className="min-w-0 px-4 py-3">
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(item.id);
                        }}
                        className="max-w-full truncate text-left font-medium hover:underline"
                      >
                        {info.name}
                      </button>
                      <p className="truncate text-xs text-muted-foreground">{info.description}</p>
                    </td>
                    <td className="hidden px-3 text-xs text-muted-foreground md:table-cell">
                      {info.type}
                    </td>
                    <td className="hidden px-3 text-xs text-muted-foreground lg:table-cell">
                      {info.origin}
                    </td>
                    <td className="text-xs">
                      <span
                        className={`mr-1.5 inline-block size-1.5 rounded-full ${value === "可用" ? "bg-success" : value === "需配置" ? "bg-warning" : "bg-muted-foreground"}`}
                      />
                      {value}
                    </td>
                    <td className="pr-4">
                      <div className="flex items-center justify-end gap-3">
                        {value === "需配置" && (
                          <button
                            type="button"
                            className="text-xs underline underline-offset-2"
                            disabled={Boolean(busy)}
                            onClick={() => void configure(item.id)}
                          >
                            配置
                          </button>
                        )}
                        <Switch
                          aria-label={`${access.enabled ? "停用" : "启用"}${info.name}`}
                          checked={access.enabled}
                          disabled={Boolean(busy) || !access.manageable}
                          onCheckedChange={(enabled) => void change(item, enabled)}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!visible.length && (
            <p role="status" className="p-8 text-center text-sm text-muted-foreground">
              {inventory.isPending ? "正在加载能力…" : "没有找到相关能力"}
            </p>
          )}
        </div>
        <p className="shrink-0 py-3 text-xs text-muted-foreground">共 {visible.length} 项能力</p>
      </div>
      <Sheet
        open={Boolean(current)}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(undefined);
          }
        }}
      >
        <SheetContent className="w-full sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{display?.name}</SheetTitle>
          </SheetHeader>
          <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-6">
            {current && display && (
              <>
                <p className="text-sm text-muted-foreground">{display.description}</p>
                <dl className="my-5 space-y-4 text-sm">
                  {[
                    ["类型", display.type],
                    ["来源", display.origin],
                    ["原始名称", display.originalName],
                    ["状态", status(current)],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="mt-1 break-words">{value}</dd>
                    </div>
                  ))}
                </dl>
                {sharedAbilityAccess(current).reason && (
                  <p className="mb-4 text-sm text-muted-foreground">
                    {sharedAbilityAccess(current).reason}
                  </p>
                )}
                {display.type === "应用连接" ? (
                  setupId === current.id ? (
                    renderConnections(refresh, native(current)?.nativeName ?? current.source)
                  ) : (
                    <Button
                      variant="outline"
                      disabled={Boolean(busy)}
                      onClick={() => void configure(current.id)}
                    >
                      让超级管理员配置
                    </Button>
                  )
                ) : native(current)?.nativeKind === "skill" ? (
                  <SkillDocumentView
                    key={current.id}
                    identity={current.id}
                    load={(path) => client.document(current.id, path)}
                  />
                ) : (
                  <p className="border-t border-border pt-4 text-sm text-muted-foreground">
                    {current.description || "暂无文档"}
                  </p>
                )}
                {serviceTools(current, items).length > 0 && (
                  <div className="mt-6 border-t border-border pt-4">
                    <p className="mb-3 text-sm font-medium">包含的工具</p>
                    {serviceTools(current, items).map((child) => (
                      <p key={child.id} className="py-1 text-sm text-muted-foreground">
                        {presentAbility(child).name}
                      </p>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
