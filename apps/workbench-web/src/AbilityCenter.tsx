import { useEffect, useState } from "react";
import { Blocks, RefreshCw } from "lucide-react";
import { Button } from "@livingbot/ui-web/components/ui/button";
import { Input } from "@livingbot/ui-web/components/ui/input";
import { SectionHeading } from "../../../packages/ui-web/src/section-heading.tsx";
import type { Ability, Bot } from "../../../packages/workbench/src/contracts.ts";
import type { WorkbenchClient } from "./client.ts";
import { ConnectionSettings } from "./ConnectionSettings.tsx";
import { Marketplace } from "./Marketplace.tsx";

/** One ordinary-language place for methods, services, tools, accounts and Bot access. */
const groups: { kind: Ability["kind"]; label: string }[] = [
  { kind: "method", label: "方法" },
  { kind: "service", label: "外部服务" },
  { kind: "tool", label: "工具" },
  { kind: "connector", label: "连接" },
  { kind: "executor", label: "外部执行" },
];

export function AbilityCenter({ client, bots, abilities, onChanged }: {
  client: WorkbenchClient; bots: Bot[]; abilities: Ability[]; onChanged(abilities: Ability[]): void;
}) {
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [loading, setLoading] = useState(false);
  const [changing, setChanging] = useState<string>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!botId) return;
    let live = true;
    setLoading(true); setError(undefined);
    void client.request<Ability[]>(`/api/bots/${encodeURIComponent(botId)}/abilities/refresh`, {})
      .then((items) => { if (live) onChanged(items); })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // Inventory refresh follows a selected Bot, never a clock.
  }, [client, botId, onChanged, refresh]);

  async function change(ability: Ability, enabled: boolean) {
    setChanging(botId); setError(undefined);
    try {
      onChanged(await client.request<Ability[]>(
        `/api/bots/${encodeURIComponent(botId)}/abilities/${encodeURIComponent(ability.id)}/access`, { enabled },
      ));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setChanging(undefined); }
  }

  const visible = abilities.filter((ability) => ability.access?.[botId] &&
    `${ability.name} ${ability.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const sections = groups.map((group) => ({ ...group, items: visible.filter((ability) => ability.kind === group.kind) }))
    .filter((section) => section.items.length);
  const unlisted = visible.filter((ability) => !groups.some((group) => group.kind === ability.kind));
  if (unlisted.length) sections.push({ kind: "method", label: "其他", items: unlisted });

  return <section className="catalog-page">
    <p className="eyebrow">WHAT YOUR PARTNERS CAN DO</p><h1>能力</h1>
    <ConnectionSettings client={client} onChanged={() => setRefresh((value) => value + 1)} />
    <Marketplace client={client} botId={botId} onInstalled={() => setRefresh((value) => value + 1)} />
    <div className="ability-bots" aria-label="选择伙伴">{bots.map((bot) =>
      <Button key={bot.id} variant={bot.id === botId ? "default" : "outline"} aria-pressed={bot.id === botId}
        onClick={() => setBotId(bot.id)}>{bot.name}</Button>)}
      <Button variant="ghost" size="icon-sm" disabled={loading} aria-label="重新读取能力" onClick={() => setRefresh((value) => value + 1)}><RefreshCw /></Button></div>
    <Input aria-label="查找能力" placeholder="查找能力…" value={query} onChange={(event) => setQuery(event.target.value)} />
    {error && <p className="text-destructive" role="alert">{error}</p>}
    {loading && <p className="empty-label"><RefreshCw size={14} /> 正在读取能力</p>}
    {!loading && !visible.length && !error && <p className="empty-label">{query ? "没有找到相关能力" : "暂无已安装能力"}</p>}
    {!loading && sections.map((section) => <div key={section.label}>
      <p className="eyebrow">{section.label}</p>
      {section.items.map((ability) => {
        const access = ability.access![botId];
        return <article className="ability-row" key={ability.id}><Blocks size={19} /><div>
          <SectionHeading>{ability.name}</SectionHeading><p>{ability.description}</p>
          {access.reason && <small>{access.reason}</small>}
        </div>{!access.manageable ? <span>{!access.enabled ? "已停用" : access.ready ? "可用" : "待就绪"}</span> :
        <Button variant="outline" size="sm" disabled={loading || changing === botId}
          aria-label={`${access.enabled ? "停用" : "启用"} ${ability.name}`}
          onClick={() => void change(ability, !access.enabled)}>{access.enabled ? "停用" : "启用"}</Button>}</article>;
      })}
    </div>)}
  </section>;
}
