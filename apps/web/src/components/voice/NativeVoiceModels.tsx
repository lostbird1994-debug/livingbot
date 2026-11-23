import type { SettingsScope } from "@livingbot/contracts";
import {
  Button,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SectionHeading,
  Textarea,
} from "@livingbot/ui-web";
import { useEffect, useId, useState } from "react";
import type { VoiceModelEntry } from "../../../../../packages/contracts/src/voice-models";
import { DEFAULT_NOTIFICATION_TEMPLATE } from "../../../../../packages/workbench/src/voice-notification";
import { WorkbenchClient } from "../../../../workbench-web/src/client";
import { localConnection } from "../../lib/local-workbench";
import { selectedSpaceId } from "../../lib/rpc";

async function voiceRequest<T>(operation: string, input: unknown): Promise<T> {
  const connection = await localConnection();
  if (!connection) throw new Error("本机服务未连接");
  return new WorkbenchClient(connection.origin, connection.token).request<T>(
    `/api/voice/rpc/${operation}`,
    input,
  );
}
type Models = {
  provider: string;
  ttsModel: string;
  sttModel: string;
  selectable: boolean;
  transcribe: boolean;
};
function ModelField({
  label,
  value,
  onChange,
  models,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  models: VoiceModelEntry[];
  disabled: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const matches = models.filter((model) =>
    `${model.id} ${model.label}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          aria-label={label}
          value={value}
          disabled={disabled}
          maxLength={200}
          placeholder="输入模型名称"
          onChange={(event) => onChange(event.target.value)}
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button variant="outline" disabled={disabled || !models.length}>
                选择
              </Button>
            }
          />
          <PopoverContent className="w-80 p-2">
            <Input
              aria-label={`搜索${label}`}
              type="search"
              placeholder="搜索上游模型"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div
              className="mt-2 max-h-64 overflow-y-auto"
              role="listbox"
              aria-label={`${label}列表`}
            >
              {matches.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  role="option"
                  aria-selected={model.id === value}
                  onClick={() => {
                    onChange(model.id);
                    setOpen(false);
                  }}
                  className="block w-full rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                >
                  <span className="block break-all">{model.id}</span>
                  {model.label !== model.id && (
                    <span className="text-xs text-muted-foreground">{model.label}</span>
                  )}
                </button>
              ))}
              {!matches.length && (
                <p className="p-2 text-sm text-muted-foreground">没有匹配的模型</p>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
export function NativeVoiceModels({
  provider,
  scope,
  spaceId,
  onBusyChange,
}: {
  provider: string;
  scope: SettingsScope;
  spaceId?: string | null;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [data, setData] = useState<Models>();
  const [models, setModels] = useState<VoiceModelEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    void voiceRequest<Models>("modelSettings", {
      provider,
      scope,
      spaceId: spaceId ?? selectedSpaceId() ?? "local",
    })
      .then((value) => {
        if (active) setData(value);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [provider, scope, spaceId]);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  async function act(operation: "discoverModels" | "saveModels") {
    if (!data || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (operation === "discoverModels") {
        const result = await voiceRequest<{ models: VoiceModelEntry[]; supported: boolean }>(
          operation,
          { provider, scope, spaceId: spaceId ?? selectedSpaceId() ?? "local" },
        );
        setModels(result.models);
        setNotice(
          !result.supported
            ? "上游未提供模型列表，可手填。"
            : result.models.length
              ? `已获取 ${result.models.length} 个上游模型；语音兼容性以试听或识别结果为准。`
              : "上游返回空列表，可手填。",
        );
      } else {
        setData(
          await voiceRequest<Models>(operation, {
            ...data,
            provider,
            scope,
            spaceId: spaceId ?? selectedSpaceId() ?? "local",
            selectable: undefined,
            transcribe: undefined,
          }),
        );
        setNotice("模型已保存");
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-6 space-y-4">
      <SectionHeading>语音模型</SectionHeading>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {data?.selectable ? (
        <>
          <ModelField
            label="合成模型"
            value={data.ttsModel}
            disabled={busy}
            models={models.filter((model) => model.synthesis !== false)}
            onChange={(ttsModel) => setData({ ...data, ttsModel })}
          />
          {data.transcribe && (
            <ModelField
              label="识别模型"
              value={data.sttModel}
              disabled={busy}
              models={models.filter((model) => model.transcription !== false)}
              onChange={(sttModel) => setData({ ...data, sttModel })}
            />
          )}
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void act("discoverModels")}>
              {busy ? "处理中…" : "探测上游模型"}
            </Button>
            <Button disabled={busy} onClick={() => void act("saveModels")}>
              保存模型
            </Button>
          </div>
        </>
      ) : (
        data && <p className="text-sm text-muted-foreground">当前使用系统语音，不需要指定模型。</p>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </section>
  );
}
export function NativeVoiceNotification({
  scope,
  spaceId,
  onBusyChange,
}: {
  scope: SettingsScope;
  spaceId?: string | null;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [template, setTemplate] = useState(DEFAULT_NOTIFICATION_TEMPLATE);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const id = useId();
  useEffect(() => {
    let active = true;
    void voiceRequest<{ template: string }>("notificationSettings", {
      scope,
      spaceId: spaceId ?? selectedSpaceId() ?? "local",
    })
      .then((value) => {
        if (active) {
          setTemplate(value.template);
          setLoaded(true);
        }
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [scope, spaceId]);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await voiceRequest<{ template: string }>("saveNotificationSettings", {
        scope,
        spaceId: spaceId ?? selectedSpaceId() ?? "local",
        template,
      });
      setTemplate(value.template);
      setNotice("播报模板已保存");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-8 space-y-3 border-t border-border pt-6">
      <SectionHeading>语音通知</SectionHeading>
      <Label htmlFor={id}>播报模板</Label>
      <Textarea
        id={id}
        aria-label="播报模板"
        value={template}
        maxLength={300}
        disabled={!loaded || busy}
        onChange={(event) => setTemplate(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        {"{botName} 为 Bot 名称，{message} 为简短消息。"}
      </p>
      <div className="flex gap-2">
        <Button disabled={!loaded || busy} onClick={() => void save()}>
          保存模板
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => setTemplate(DEFAULT_NOTIFICATION_TEMPLATE)}
        >
          恢复默认
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </section>
  );
}
