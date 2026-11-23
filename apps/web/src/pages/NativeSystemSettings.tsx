import {
  Button,
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
  Switch,
  Textarea,
} from "@livingbot/ui-web";
import { useEffect, useState } from "react";
import type {
  MemoryPreferences,
  MemoryPreferencesInput,
} from "../../../../packages/kernel-runtime/src/memory-settings";
import type {
  AuditSettingsInput,
  CapabilityAuditSettingsView,
} from "../../../../packages/workbench/src/system-policy";
import { WorkbenchClient } from "../../../workbench-web/src/client";
import { LoadingState } from "../components/ai/primitives";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";
import { localConnection } from "../lib/local-workbench";
import { LocalKnowledgeSettings } from "./LocalKnowledgeSettings";

type AuditView = CapabilityAuditSettingsView;
type Schedule = Pick<AuditSettingsInput, "cadence" | "hour" | "minute" | "weekday">;
function ScheduleFields({
  value,
  onChange,
  disabled,
}: {
  value: Schedule;
  onChange: (patch: Partial<Schedule>) => void;
  disabled: boolean;
}) {
  return (
    <>
      <SettingsRow
        label="周期"
        control={
          <NativeSelect
            aria-label="周期"
            value={value.cadence}
            disabled={disabled}
            onChange={(event) => onChange({ cadence: event.target.value as Schedule["cadence"] })}
          >
            <NativeSelectOption value="daily">每天</NativeSelectOption>
            <NativeSelectOption value="weekly">每周</NativeSelectOption>
          </NativeSelect>
        }
      />
      {value.cadence === "weekly" && (
        <SettingsRow
          label="星期"
          control={
            <NativeSelect
              aria-label="星期"
              value={value.weekday}
              disabled={disabled}
              onChange={(event) => onChange({ weekday: Number(event.target.value) })}
            >
              {["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map((label, index) => (
                <NativeSelectOption key={label} value={index}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          }
        />
      )}
      <SettingsRow
        label="开始时间"
        control={
          <Input
            type="time"
            aria-label="开始时间"
            value={`${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`}
            disabled={disabled}
            onChange={(event) => {
              const [hour, minute] = event.target.value.split(":").map(Number);
              onChange({ hour, minute });
            }}
            className="w-36"
          />
        }
      />
    </>
  );
}
function useNativeSettings<T>(path: string, onBusyChange?: (value: boolean) => void) {
  const [client, setClient] = useState<WorkbenchClient>();
  const [data, setData] = useState<T>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    let active = true;
    void localConnection()
      .then(async (connection) => {
        if (!connection) throw new Error("本机服务未连接");
        const next = new WorkbenchClient(connection.origin, connection.token);
        const result = await next.request<T>(path);
        if (active) {
          setClient(next);
          setData(result);
        }
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [path]);
  async function save(input: unknown, endpoint = path) {
    if (!client || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await client.request<T>(endpoint, input);
      setData(result);
      setNotice((result as {applyState?:string}).applyState === "pending" ? "已保存，等待当前任务结束后生效" : "已保存");
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const feedback = (
    <>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
    </>
  );
  return { data, client, busy, error, feedback, save };
}
function formatTime(timestamp?: number, timezone?: string) {
  return timestamp
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: timezone,
      }).format(timestamp)
    : "暂无";
}
export function NativeMemorySettings({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const state = useNativeSettings<MemoryPreferences>("/api/memory-settings");
  const [managementBusy, setManagementBusy] = useState(false);
  const busy = state.busy || managementBusy;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const [draft, setDraft] = useState<MemoryPreferencesInput>();
  useEffect(() => {
    if (!state.data) return;
    const fields = state.data.frequency.split(/\s+/);
    const daily = fields[4] === "*";
    setDraft({
      enabled: state.data.enabled,
      cadence: daily ? "daily" : "weekly",
      hour: Number(fields[1]) || 0,
      minute: Number(fields[0]) || 0,
      weekday: /^[0-6]$/.test(fields[4] ?? "") ? Number(fields[4]) : 1,
      recallMode: state.data.recallMode,
      flushBeforeCompaction: state.data.flushBeforeCompaction,
    });
  }, [state.data]);
  const patch = (value: Partial<MemoryPreferencesInput>) =>
    setDraft((current) => current && { ...current, ...value });
  return (
    <div className="max-w-[760px] space-y-6">
      {state.feedback}
      {!draft ? (
        !state.error && <LoadingState label="正在读取记忆设置" />
      ) : (
        <>
          {state.data?.applyState === "pending" && <p role="status" className="text-sm text-muted-foreground">已保存，等待当前任务结束后生效</p>}
          <SettingsGroup title="自动整理">
            <SettingsRow
              label={<Label htmlFor="memory-dreaming">整理长期记忆</Label>}
              control={
                <Switch
                  id="memory-dreaming"
                  checked={draft.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) => patch({ enabled })}
                />
              }
            />
            <ScheduleFields value={draft} onChange={patch} disabled={busy || !draft.enabled} />
            <SettingsRow
              label="时区"
              control={<span className="text-sm">{state.data?.timezone}</span>}
            />
          </SettingsGroup>
          <SettingsGroup title="回忆与保存">
            <SettingsRow
              label="回答前检索历史记忆"
              control={
                <NativeSelect
                  aria-label="回答前检索历史记忆"
                  value={draft.recallMode}
                  disabled={busy}
                  onChange={(event) =>
                    patch({ recallMode: event.target.value as MemoryPreferences["recallMode"] })
                  }
                >
                  <NativeSelectOption value="escalate">按需检索</NativeSelectOption>
                  <NativeSelectOption value="always">每次检索</NativeSelectOption>
                  <NativeSelectOption value="off">关闭深入检索</NativeSelectOption>
                </NativeSelect>
              }
            />
            <SettingsRow
              label={<Label htmlFor="memory-flush">压缩会话前保存记忆</Label>}
              control={
                <Switch
                  id="memory-flush"
                  checked={draft.flushBeforeCompaction}
                  disabled={busy}
                  onCheckedChange={(flushBeforeCompaction) => patch({ flushBeforeCompaction })}
                />
              }
            />
          </SettingsGroup>
          <Button disabled={busy} onClick={() => void state.save(draft)}>
            {state.busy ? "正在保存…" : "保存"}
          </Button>
          <SettingsGroup title="运行记录">
            <SettingsRow
              label="计划状态"
              control={
                <span className="text-sm">
                  {!state.data?.enabled
                    ? "已关闭"
                    : state.data.schedule?.enabled
                      ? "已启用"
                      : "未建立计划"}
                </span>
              }
            />
            <SettingsRow
              label="最近执行"
              control={
                <span className="text-sm">
                  {formatTime(state.data?.schedule?.lastRunAt, state.data?.timezone)}
                </span>
              }
            />
            <SettingsRow
              label="执行结果"
              control={
                <span className="text-sm">
                  {state.data?.schedule?.status === "ok"
                    ? "成功"
                    : (state.data?.schedule?.status ?? "暂无")}
                </span>
              }
            />
            <SettingsRow
              label="下次执行"
              control={
                <span className="text-sm">
                  {state.data?.enabled
                    ? formatTime(state.data.schedule?.nextRunAt, state.data.timezone)
                    : "已关闭"}
                </span>
              }
            />
          </SettingsGroup>
        </>
      )}
      <details className="border-t border-border pt-4">
        <summary className="cursor-pointer text-sm">记忆管理</summary>
        <div className="mt-5">
          <fieldset disabled={state.busy}>
            <LocalKnowledgeSettings onBusyChange={setManagementBusy} />
          </fieldset>
        </div>
      </details>
    </div>
  );
}
export function NativeAdvancedSettings({
  onBusyChange,
  botId,
}: {
  onBusyChange?: (busy: boolean) => void;
  botId?: string;
}) {
  const state = useNativeSettings<AuditView>(botId ? `/api/bots/${encodeURIComponent(botId)}/capability-audit` : "/api/system/advanced");
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const busy = state.busy || migrationBusy;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const [draft, setDraft] = useState<AuditSettingsInput>();
  useEffect(() => {
    if (state.data) {
      const { enabled, cadence, hour, minute, weekday, timezone } = state.data;
      setDraft({ enabled, cadence, hour, minute, weekday, timezone });
    }
  }, [state.data]);
  const patch = (value: Partial<AuditSettingsInput>) =>
    setDraft((current) => current && { ...current, ...value });
  return (
    <div className="max-w-[760px] space-y-6">
      {state.feedback}
      {!draft ? (
        !state.error && <LoadingState label="正在读取高级设置" />
      ) : (
        <>
          <SettingsGroup title={botId ? "专属能力审计" : "共享能力审计"}>
            <SettingsRow
              label={<Label htmlFor={botId ? `ability-audit-${botId}` : "ability-audit"}>定期审计</Label>}
              control={
                <Switch
                  id={botId ? `ability-audit-${botId}` : "ability-audit"}
                  checked={draft.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) => patch({ enabled })}
                />
              }
            />
            <ScheduleFields
              value={draft}
              onChange={patch}
              disabled={busy || !draft.enabled}
            />
            <SettingsRow label="时区" control={<span className="text-sm">{draft.timezone}</span>} />
            {state.data?.routine && (
              <SettingsRow
                label="下次执行"
                control={
                  <span className="text-sm">
                    {formatTime(state.data.routine.nextRunAt, draft.timezone)}
                  </span>
                }
              />
            )}
          </SettingsGroup>
          <details>
            <summary className="cursor-pointer text-sm">查看审计指令</summary>
            <Textarea
              aria-label="能力审计指令"
              className="mt-3 min-h-64 text-sm"
              readOnly
              value={state.data?.instructions ?? ""}
            />
          </details>
          <Button disabled={busy} onClick={() => void state.save(draft)}>
            {busy ? "正在保存…" : "保存"}
          </Button>
          {state.data?.routine?.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.data.routine.error}
            </p>
          )}
        </>
      )}
      {!botId && (
        <details
          className="border-t border-border pt-4"
          onToggle={(event) => setMigrationOpen(event.currentTarget.open)}
        >
          <summary
            className="cursor-pointer text-sm"
            onClick={(event) => { if (migrationBusy) event.preventDefault(); }}
          >迁移旧版数据</summary>
          {migrationOpen && (
            <fieldset className="mt-5" disabled={state.busy}>
              <LocalKnowledgeSettings view="data" onBusyChange={setMigrationBusy} />
            </fieldset>
          )}
        </details>
      )}
    </div>
  );
}
