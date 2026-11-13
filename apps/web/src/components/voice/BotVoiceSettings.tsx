import type { Bot } from "@livingbot/contracts";
import { Button, Input, SectionHeading, Switch } from "@livingbot/ui-web";
import { useId, useState } from "react";
import type { BotVoicePreferences } from "../../lib/voice-assistant-pref";
import { readBotVoicePreferences, writeBotVoicePreferences } from "../../lib/voice-assistant-pref";
import { defaultWakeName } from "../../lib/wake-word";

export function BotVoiceSettings({ bot }: { bot: Pick<Bot, "id" | "name"> }) {
  const id = useId();
  const [prefs, setPrefs] = useState(() => readBotVoicePreferences(bot.id));
  const [aliases, setAliases] = useState(prefs.aliases.join("、"));
  const [error, setError] = useState("");
  function save(next: BotVoicePreferences) {
    try {
      writeBotVoicePreferences(bot.id, next);
      setPrefs(next);
      setError("");
    } catch {
      setError("无法保存此设备的语音设置，请检查本地存储权限。");
    }
  }
  return (
    <section className="mt-6 space-y-3" data-testid="bot-voice-settings">
      <SectionHeading variant="label">语音 · 此设备</SectionHeading>
      <div className="space-y-4 rounded-xl bg-muted/50 p-4">
        <label className="flex items-center justify-between gap-3 text-sm" htmlFor={`${id}-wake`}>
          允许语音唤醒
          <Switch
            id={`${id}-wake`}
            checked={prefs.wakeEnabled}
            onCheckedChange={(wakeEnabled) => save({ ...prefs, wakeEnabled })}
          />
        </label>
        {prefs.wakeEnabled ? (
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground" htmlFor={`${id}-aliases`}>
              唤醒别名
            </label>
            <Input
              id={`${id}-aliases`}
              value={aliases}
              maxLength={200}
              placeholder={defaultWakeName(bot.name)}
              onChange={(event) => setAliases(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              默认可喊“{defaultWakeName(bot.name)}”；多个别名用顿号或逗号分隔。
            </p>
            {aliases !== prefs.aliases.join("、") ? (
              <Button
                size="sm"
                onClick={() => {
                  const names = [
                    ...new Set(
                      aliases
                        .split(/[、,，;\n；]/u)
                        .map((s) => s.trim())
                        .filter(Boolean),
                    ),
                  ];
                  if (names.some((name) => [...name].length < 2)) {
                    setError("唤醒别名至少需要两个字或字母。");
                    return;
                  }
                  save({ ...prefs, aliases: names });
                  setAliases(names.join("、"));
                }}
              >
                保存别名
              </Button>
            ) : null}
          </div>
        ) : null}
        <label className="flex items-center justify-between gap-3 text-sm" htmlFor={`${id}-notify`}>
          语音通知
          <Switch
            id={`${id}-notify`}
            checked={prefs.notifyEnabled}
            onCheckedChange={(notifyEnabled) => save({ ...prefs, notifyEnabled })}
          />
        </label>
        {prefs.notifyEnabled ? (
          <p className="text-xs text-muted-foreground">
            AI 将新回复总结为 20 字内通知，当前正在看的会话不播报。
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
