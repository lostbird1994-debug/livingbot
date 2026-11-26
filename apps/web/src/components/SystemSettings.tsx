import { Label, Switch, ToggleGroup, ToggleGroupItem } from "@livingbot/ui-web";
import { useEffect, useState, useSyncExternalStore } from "react";
import { desktopBridge } from "../lib/desktop";
import type { FileOpenMode, LinkOpenMode } from "../lib/opening-prefs";
import {
  getFileOpenMode,
  getLinkOpenMode,
  setFileOpenMode,
  setLinkOpenMode,
  subscribeOpeningPrefs,
} from "../lib/opening-prefs";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

/**
 * How the app hands work to the computer it runs on: where a link opens, what a delivered file
 * does when it is clicked, and whether the app starts with the machine. The shell owns all three,
 * so without one the rows stay visible but idle.
 */
export function SystemSettings() {
  const desktop = desktopBridge();
  const linkMode = useSyncExternalStore(subscribeOpeningPrefs, getLinkOpenMode);
  const fileMode = useSyncExternalStore(subscribeOpeningPrefs, getFileOpenMode);
  const [startsAtLogin, setStartsAtLogin] = useState(false);
  const [loginPending, setLoginPending] = useState(false);
  const canStartAtLogin = Boolean(desktop?.system);

  useEffect(() => {
    let cancelled = false;
    void desktop?.system
      ?.loginItem()
      .then((enabled) => {
        if (!cancelled) setStartsAtLogin(enabled);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  async function chooseStartsAtLogin(enabled: boolean) {
    if (!desktop?.system || loginPending) return;
    setLoginPending(true);
    try {
      // The system answers with what it actually registered, which is the state to show.
      setStartsAtLogin(await desktop.system.setLoginItem(enabled));
    } catch {
      setStartsAtLogin(enabled === false);
    } finally {
      setLoginPending(false);
    }
  }

  function choices<T extends string>(
    value: T,
    options: { value: T; label: string; testId: string }[],
    onChange: (next: T) => void,
    labelId: string,
    disabled: boolean,
  ) {
    return (
      <ToggleGroup
        aria-labelledby={labelId}
        value={[value]}
        onValueChange={([next]) => {
          if (next) onChange(next as T);
        }}
        spacing={1}
        className="grid min-w-0 grid-cols-2 rounded-lg bg-muted p-1"
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            data-testid={option.testId}
            disabled={disabled}
            className="text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm"
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    );
  }

  return (
    <div className="settings-overview" data-testid="system-settings">
      <SettingsGroup>
        <SettingsRow
          label={<span id="link-open-mode">链接打开方式</span>}
          description="网页链接用系统浏览器打开，还是在应用自己的窗口里打开。"
          control={choices<LinkOpenMode>(
            linkMode,
            [
              { value: "system", label: "系统浏览器", testId: "link-open-system" },
              { value: "in-app", label: "应用内窗口", testId: "link-open-in-app" },
            ],
            (next) => setLinkOpenMode(next),
            "link-open-mode",
            !desktop?.links,
          )}
        />
        <SettingsRow
          label={<span id="file-open-mode">文件打开方式</span>}
          description="点击对话里的文件时，先在应用内预览，还是直接交给系统默认应用。"
          control={choices<FileOpenMode>(
            fileMode,
            [
              { value: "preview", label: "应用内预览", testId: "file-open-preview" },
              { value: "system", label: "系统应用", testId: "file-open-system" },
            ],
            (next) => setFileOpenMode(next),
            "file-open-mode",
            false,
          )}
        />
        <SettingsRow
          label={
            <Label htmlFor="start-at-login" className="text-[14px] text-foreground">
              开机自动启动
            </Label>
          }
          control={
            <Switch
              id="start-at-login"
              data-testid="start-at-login-toggle"
              checked={startsAtLogin}
              disabled={!canStartAtLogin || loginPending}
              onCheckedChange={(enabled) => void chooseStartsAtLogin(enabled)}
            />
          }
        />
      </SettingsGroup>
    </div>
  );
}
