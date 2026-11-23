import { useEffect, useState } from "react";
import { Button } from "@livingbot/ui-web/components/ui/button";
import { Input } from "@livingbot/ui-web/components/ui/input";
import { SectionHeading } from "../../../packages/ui-web/src/section-heading.tsx";
import type { ModelSettings as Settings } from "../../../packages/kernel-runtime/src/model-settings.ts";
import type { WorkbenchClient } from "./client.ts";

export function ModelSettings({ client }: { client: WorkbenchClient }) {
  const [settings, setSettings] = useState<Settings>();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    void client.request<Settings>("/api/model-settings").then((value) => {
      if (active) setSettings(value);
    }).catch(() => { if (active) setError("无法读取模型配置"); });
    return () => { active = false; };
  }, [client]);
  return <section className="model-settings">
    <SectionHeading as="h2">模型</SectionHeading>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {settings && <form onSubmit={(event) => {
      event.preventDefault(); setBusy(true); setError(undefined); setSaved(false);
      void client.request<Settings>("/api/model-settings", {
        id: settings.id, baseUrl: settings.baseUrl, api: settings.api, model: settings.model, input: settings.input,
        ...(apiKey ? { apiKey } : {}),
      }).then((value) => { setSettings(value); setApiKey(""); setSaved(true); })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "保存失败"))
        .finally(() => setBusy(false));
    }}>
      <fieldset disabled={busy}>
        <label htmlFor="model-endpoint">服务地址</label>
        <Input id="model-endpoint" type="url" required value={settings.baseUrl}
          onChange={(event) => { setSaved(false); setSettings({ ...settings, baseUrl: event.target.value }); }} />
        <label htmlFor="model-protocol">接口格式</label>
        <select id="model-protocol" value={settings.api}
          onChange={(event) => { setSaved(false); setSettings({ ...settings, api: event.target.value as Settings["api"] }); }}>
          <option value="openai-completions">OpenAI Chat Completions</option>
          <option value="openai-responses">OpenAI Responses</option>
          <option value="anthropic-messages">Anthropic Messages</option>
        </select>
        <label htmlFor="model-name">模型名称</label>
        <Input id="model-name" required value={settings.model}
          onChange={(event) => { setSaved(false); setSettings({ ...settings, model: event.target.value }); }} />
        <label className="marketplace-review"><input type="checkbox" checked={settings.input.includes("image")}
          onChange={(event) => { setSaved(false); setSettings({ ...settings, input: event.target.checked ? ["text", "image"] : ["text"] }); }} />
          支持图片
        </label>
        <label htmlFor="model-key">API 密钥{settings.hasKey ? "（已保存，留空保留）" : "（可选）"}</label>
        <Input id="model-key" type="password" autoComplete="off" value={apiKey}
          onChange={(event) => { setSaved(false); setApiKey(event.target.value); }} />
        <Button type="submit" disabled={busy}>{busy ? "保存中" : "保存"}</Button>
        {saved && <span role="status">已保存</span>}
      </fieldset>
    </form>}
  </section>;
}
