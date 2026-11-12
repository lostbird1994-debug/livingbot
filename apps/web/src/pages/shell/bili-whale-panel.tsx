import { Trans, useLingui } from "@lingui/react/macro";
import type { BiliWhaleSettings, BiliWhaleStatus, Bot } from "@rakazo/contracts";
import { Button, Input, SectionHeading, Switch } from "@rakazo/ui-web";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { cloneElement, isValidElement, useCallback, useEffect, useId, useState } from "react";
import { rpc } from "../../lib/rpc";

/**
 * 养鱼设置 —— 只出现在带 `spawnKey === "bili-whale"` 的 bot 上。
 *
 * 这里改的每一个值，最终都写进该 bot 文件夹里 `bili-whale/config.json`；
 * 命令行工具链读的是同一份文件，所以「界面改了但脚本没变」这种事不会发生。
 *
 * 凭据区的三个 cookie 只写不读：界面永远只显示「已配置 / 未配置」。
 */

type Props = {
  bot: Bot;
  /** 标签页可见时才拉数据，避免每开一次面板都请求。 */
  active: boolean;
};

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {isValidElement<{ id?: string }>(children) ? cloneElement(children, { id }) : children}
      {hint ? <p className="text-[11px] leading-relaxed text-muted-foreground/80">{hint}</p> : null}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3 rounded-xl bg-muted/40 p-4">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex min-h-9 items-center justify-between gap-3">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      {isValidElement<{ id?: string }>(children) ? cloneElement(children, { id }) : children}
    </div>
  );
}

const splitList = (value: string) =>
  value
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter(Boolean);

export function BiliWhaleSection({ bot, active }: Props) {
  const { t } = useLingui();
  const [settings, setSettings] = useState<BiliWhaleSettings | null>(null);
  const [status, setStatus] = useState<BiliWhaleStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [depsOutput, setDepsOutput] = useState<string | null>(null);
  const [likeText, setLikeText] = useState("");
  const [dislikeText, setDislikeText] = useState("");
  const [credentials, setCredentials] = useState({ sessdata: "", biliJct: "", buvid3: "" });
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await rpc.biliWhale.get({ botId: bot.id });
      setSettings(result.settings);
      setStatus(result.status);
      setLikeText(result.settings.preferences.like.join("、"));
      setDislikeText(result.settings.preferences.dislike.join("、"));
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [bot.id]);

  useEffect(() => {
    if (!active || loaded) return;
    void load();
  }, [active, loaded, load]);

  function patch(next: (draft: BiliWhaleSettings) => BiliWhaleSettings) {
    setSettings((current) => (current ? next(current) : current));
    setNotice(null);
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await rpc.biliWhale.save({
        botId: bot.id,
        settings: {
          ...settings,
          preferences: {
            like: splitList(likeText),
            dislike: splitList(dislikeText),
          },
        },
      });
      setNotice(t`已保存，下一次醒来就按这个来`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function saveCredentials() {
    if (!Object.values(credentials).some((value) => value.trim())) {
      setError(t`请至少填写一项需要更新的凭据`);
      return;
    }
    if (
      !status?.credentials.configured &&
      (!credentials.sessdata.trim() || !credentials.biliJct.trim())
    ) {
      setError(t`首次配置请同时填写 SESSDATA 和 bili_jct`);
      return;
    }
    setBusy("credentials");
    setError(null);
    setNotice(null);
    try {
      await rpc.biliWhale.saveCredentials({ botId: bot.id, ...credentials });
      setCredentials({ sessdata: "", biliJct: "", buvid3: "" });
      setNotice(t`凭据已保存（内容不会回显）`);
      const result = await rpc.biliWhale.get({ botId: bot.id });
      setStatus(result.status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function runDeps() {
    setBusy("deps");
    setError(null);
    try {
      const result = await rpc.biliWhale.deps({ botId: bot.id });
      setDepsOutput(result.text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function rollPlan() {
    setBusy("plan");
    setError(null);
    try {
      const plan = await rpc.biliWhale.planNow({ botId: bot.id });
      setStatus((current) => (current ? { ...current, plan } : current));
      setNotice(
        plan.action === "skip"
          ? t`今晚不想看：${plan.reason ?? ""}`
          : t`今晚 ${plan.atText ?? "稍后"} 醒过来`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  if (loading && !settings) {
    return (
      <div className="flex items-center gap-2 pt-5 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <Trans>正在读她的设置…</Trans>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="space-y-3 pt-5">
        <p className="text-sm text-muted-foreground">
          {error ?? t`读不到设置。她可能还没有自己的文件夹。`}
        </p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <Trans>重试</Trans>
        </Button>
      </div>
    );
  }

  const ready = status?.ready ?? false;
  const creds = status?.credentials;

  return (
    <div className="space-y-5 pt-5" data-testid="bili-whale-settings">
      <div className="flex items-start gap-2 rounded-xl bg-muted/40 p-4 text-sm">
        {ready ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        ) : (
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
        )}
        <div className="space-y-1">
          <div className="font-medium">{ready ? t`工具链就位` : t`工具链还没就位`}</div>
          <div className="break-all text-[11px] leading-relaxed text-muted-foreground">
            {status?.projectDir}
          </div>
          {status?.plan ? (
            <div className="text-[11px] text-muted-foreground">
              {status.plan.action === "skip"
                ? t`今天：不看（${status.plan.reason ?? "自己决定的"}）`
                : t`今天：${status.plan.atText ?? "待定"} 醒`}
            </div>
          ) : null}
        </div>
      </div>

      <SectionHeading>
        <Trans>她是谁</Trans>
      </SectionHeading>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t`角色名`}>
          <Input
            value={settings.persona.name}
            placeholder={bot.name}
            onChange={(event) =>
              patch((draft) => ({
                ...draft,
                persona: { ...draft.persona, name: event.target.value },
              }))
            }
          />
        </Field>
        <Field label={t`怎么称呼你`}>
          <Input
            value={settings.persona.ownerTitle}
            onChange={(event) =>
              patch((draft) => ({
                ...draft,
                persona: { ...draft.persona, ownerTitle: event.target.value },
              }))
            }
          />
        </Field>
        <Field label={t`她怎么自称`}>
          <Input
            value={settings.persona.selfClaim}
            onChange={(event) =>
              patch((draft) => ({
                ...draft,
                persona: { ...draft.persona, selfClaim: event.target.value },
              }))
            }
          />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t`你的 B 站 mid`} hint={t`分享评论要 @ 的人；在个人空间地址栏里能看到`}>
          <Input
            value={settings.owner.mid}
            onChange={(event) =>
              patch((draft) => ({ ...draft, owner: { ...draft.owner, mid: event.target.value } }))
            }
          />
        </Field>
        <Field label={t`你的昵称`} hint={t`@ 的时候用这个，改过记得同步`}>
          <Input
            value={settings.owner.name}
            onChange={(event) =>
              patch((draft) => ({ ...draft, owner: { ...draft.owner, name: event.target.value } }))
            }
          />
        </Field>
      </div>

      <SectionHeading>
        <Trans>作息</Trans>
      </SectionHeading>
      <Group title={t`什么时候醒`}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t`从`}>
            <Input
              value={settings.night.windows[0]?.start ?? "20:00"}
              onChange={(event) =>
                patch((draft) => ({
                  ...draft,
                  night: {
                    ...draft.night,
                    windows: [
                      {
                        ...(draft.night.windows[0] ?? { start: "20:00", end: "24:00", wakes: 1 }),
                        start: event.target.value,
                      },
                      ...draft.night.windows.slice(1),
                    ],
                  },
                }))
              }
            />
          </Field>
          <Field label={t`到`}>
            <Input
              value={settings.night.windows[0]?.end ?? "24:00"}
              onChange={(event) =>
                patch((draft) => ({
                  ...draft,
                  night: {
                    ...draft.night,
                    windows: [
                      {
                        ...(draft.night.windows[0] ?? { start: "20:00", end: "24:00", wakes: 1 }),
                        end: event.target.value,
                      },
                      ...draft.night.windows.slice(1),
                    ],
                  },
                }))
              }
            />
          </Field>
          <Field label={t`醒几次`}>
            <Input
              type="number"
              min={0}
              max={3}
              value={settings.night.windows[0]?.wakes ?? 1}
              onChange={(event) =>
                patch((draft) => ({
                  ...draft,
                  night: {
                    ...draft.night,
                    windows: [
                      {
                        ...(draft.night.windows[0] ?? { start: "20:00", end: "24:00", wakes: 1 }),
                        wakes: Number(event.target.value) || 0,
                      },
                      ...draft.night.windows.slice(1),
                    ],
                  },
                }))
              }
            />
          </Field>
        </div>
        <Field
          label={t`今天不想看的概率：${Math.round(settings.night.skipChance * 100)}%`}
          hint={t`摆烂也是一种活法；她掷到不看时会写日记说明理由`}
        >
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(settings.night.skipChance * 100)}
            onChange={(event) =>
              patch((draft) => ({
                ...draft,
                night: { ...draft.night, skipChance: Number(event.target.value) / 100 },
              }))
            }
            className="w-full accent-foreground"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t`一次最多看几条`}>
            <Input
              type="number"
              min={1}
              max={20}
              value={settings.night.maxVideos}
              onChange={(event) =>
                patch((draft) => ({
                  ...draft,
                  night: { ...draft.night, maxVideos: Number(event.target.value) || 1 },
                }))
              }
            />
          </Field>
          <Field label={t`两次之间至少隔（分钟）`}>
            <Input
              type="number"
              min={0}
              max={240}
              value={settings.night.minGapMin}
              onChange={(event) =>
                patch((draft) => ({
                  ...draft,
                  night: { ...draft.night, minGapMin: Number(event.target.value) || 0 },
                }))
              }
            />
          </Field>
        </div>
      </Group>

      <SectionHeading>
        <Trans>爱看什么</Trans>
      </SectionHeading>
      <Group title={t`用顿号或逗号分隔`}>
        <Field label={t`爱看`}>
          <Input value={likeText} onChange={(event) => setLikeText(event.target.value)} />
        </Field>
        <Field label={t`不爱看`}>
          <Input value={dislikeText} onChange={(event) => setDislikeText(event.target.value)} />
        </Field>
      </Group>

      <SectionHeading>
        <Trans>分享</Trans>
      </SectionHeading>
      <Group title={t`打扰你的方式与额度`}>
        <Row label={t`允许分享`}>
          <Switch
            checked={settings.share.enabled}
            onCheckedChange={(checked) =>
              patch((draft) => ({ ...draft, share: { ...draft.share, enabled: checked } }))
            }
          />
        </Row>
        <Row label={t`发到 B 站私信`}>
          <Switch
            checked={settings.share.via === "dm"}
            onCheckedChange={(checked) =>
              patch((draft) => ({
                ...draft,
                share: { ...draft.share, via: checked ? "dm" : "comment" },
              }))
            }
          />
        </Row>
        <p className="text-[11px] leading-relaxed text-muted-foreground/80">
          <Trans>关掉就在评论区 @ 你；打开走私信（需要两个号互关）。两条路共用同一份额度。</Trans>
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t`每天最多几条`}>
            <Input
              type="number"
              min={0}
              max={10}
              value={settings.quota.shareDaily}
              onChange={(event) =>
                patch((draft) => ({
                  ...draft,
                  quota: { ...draft.quota, shareDaily: Number(event.target.value) || 0 },
                }))
              }
            />
          </Field>
          <Field label={t`值得发的分数线（0–20）`}>
            <Input
              type="number"
              min={0}
              max={20}
              value={settings.share.minScore}
              onChange={(event) =>
                patch((draft) => ({
                  ...draft,
                  share: { ...draft.share, minScore: Number(event.target.value) || 0 },
                }))
              }
            />
          </Field>
        </div>
      </Group>

      <SectionHeading>
        <Trans>听人找她</Trans>
      </SectionHeading>
      <Group title={t`监听会真的发请求，新号别开`}>
        <Row label={t`私信监听（只认你）`}>
          <Switch
            checked={settings.listen.dm}
            onCheckedChange={(checked) =>
              patch((draft) => ({ ...draft, listen: { ...draft.listen, dm: checked } }))
            }
          />
        </Row>
        <Row label={t`评论区监听`}>
          <Switch
            checked={settings.listen.comment}
            onCheckedChange={(checked) =>
              patch((draft) => ({ ...draft, listen: { ...draft.listen, comment: checked } }))
            }
          />
        </Row>
        <Row label={t`直播间弹幕`}>
          <Switch
            checked={settings.listen.live}
            onCheckedChange={(checked) =>
              patch((draft) => ({ ...draft, listen: { ...draft.listen, live: checked } }))
            }
          />
        </Row>
        <Row label={t`全天监听`}>
          <Switch
            checked={settings.listen.allDay}
            onCheckedChange={(checked) =>
              patch((draft) => ({ ...draft, listen: { ...draft.listen, allDay: checked } }))
            }
          />
        </Row>
      </Group>

      <SectionHeading>
        <Trans>B 站凭据</Trans>
      </SectionHeading>
      <Group title={t`凭据只写不读，留空保留原值`}>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          <Trans>
            在 bilibili.com 按 F12 → Application → Cookies →
            https://www.bilibili.com，复制这三个值。 SESSDATA 是 HttpOnly，用 document.cookie
            拿不到，必须手动复制。
          </Trans>
        </p>
        <div className="flex flex-wrap gap-2 text-[11px]">
          {(
            [
              ["SESSDATA", creds?.sessdata],
              ["bili_jct", creds?.biliJct],
              ["buvid3", creds?.buvid3],
            ] as const
          ).map(([name, present]) => (
            <span
              key={name}
              className={`rounded-full px-2 py-0.5 ${present ? "bg-emerald-500/10 text-emerald-700" : "bg-muted text-muted-foreground"}`}
            >
              {name} {present ? t`已配置` : t`未配置`}
            </span>
          ))}
        </div>
        <Field label="SESSDATA">
          <Input
            type="password"
            autoComplete="off"
            value={credentials.sessdata}
            onChange={(event) => setCredentials((c) => ({ ...c, sessdata: event.target.value }))}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="bili_jct">
            <Input
              type="password"
              autoComplete="off"
              value={credentials.biliJct}
              onChange={(event) => setCredentials((c) => ({ ...c, biliJct: event.target.value }))}
            />
          </Field>
          <Field label="buvid3">
            <Input
              type="password"
              autoComplete="off"
              value={credentials.buvid3}
              onChange={(event) => setCredentials((c) => ({ ...c, buvid3: event.target.value }))}
            />
          </Field>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy === "credentials"}
          onClick={() => void saveCredentials()}
        >
          {busy === "credentials" ? <Loader2 className="size-4 animate-spin" /> : null}
          <Trans>保存凭据</Trans>
        </Button>
      </Group>

      <SectionHeading>
        <Trans>工具</Trans>
      </SectionHeading>
      <Group title={t`确认她真的能干活`}>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy === "deps"}
            onClick={() => void runDeps()}
          >
            {busy === "deps" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            <Trans>依赖体检</Trans>
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy === "plan"}
            onClick={() => void rollPlan()}
          >
            {busy === "plan" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            <Trans>重掷今晚计划</Trans>
          </Button>
        </div>
        {depsOutput ? (
          <pre className="max-h-64 overflow-auto rounded-lg bg-background p-3 text-[11px] leading-relaxed whitespace-pre-wrap">
            {depsOutput}
          </pre>
        ) : null}
      </Group>

      <div className="flex items-center gap-3 pb-2">
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          <Trans>保存设置</Trans>
        </Button>
        {notice ? <span className="text-xs text-emerald-700">{notice}</span> : null}
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}
