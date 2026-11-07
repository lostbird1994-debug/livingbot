import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { ImagePlus, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  CHAT_BACKGROUND_LIMITS,
  type ChatBackgroundSettings,
  DEFAULT_CHAT_BACKGROUND_SETTINGS,
  GLOBAL_BACKGROUND_TARGET,
  getChatBackgroundRevision,
  getChatBackgroundSettings,
  listChatBackgroundTargets,
  prepareChatBackgroundFile,
  readChatBackgroundImage,
  removeChatBackgroundImage,
  resetChatBackgroundSettings,
  saveChatBackgroundImage,
  setChatBackgroundSettings,
  subscribeChatBackground,
} from "../lib/chat-background";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

/** Object URL for one target's stored picture, refreshed when it changes. */
function useTargetPreview(target: string, revision: number): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    void readChatBackgroundImage(target).then((blob) => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [target, revision]);

  return url;
}

function Percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function BackdropSlider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (next: number) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <label htmlFor={id} className="w-20 shrink-0 text-[13px] text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
      />
      <span className="w-12 shrink-0 text-right text-[13px] tabular-nums text-muted-foreground">
        {display}
      </span>
    </div>
  );
}

/**
 * Backdrop controls for the chat transcript: one picture per bot, with a
 * shared default for every chat that has none of its own.
 */
export function ChatBackgroundSettingsPanel({
  bot,
}: {
  bot?: { id: string; name: string } | null;
}) {
  const { t } = useLingui();
  const revision = useSyncExternalStore(subscribeChatBackground, getChatBackgroundRevision, () => 0);
  const settings = useSyncExternalStore(
    subscribeChatBackground,
    getChatBackgroundSettings,
    () => DEFAULT_CHAT_BACKGROUND_SETTINGS,
  );
  const [scope, setScope] = useState(bot?.id ?? GLOBAL_BACKGROUND_TARGET);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setScope(bot?.id ?? GLOBAL_BACKGROUND_TARGET);
  }, [bot?.id]);

  const scopeIsBot = Boolean(bot && scope === bot.id);
  const preview = useTargetPreview(scope, revision);
  const hasImage = preview !== null;
  const [targets, setTargets] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void listChatBackgroundTargets().then((list) => {
      if (!cancelled) setTargets(list);
    });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const sharedPresent = targets.includes(GLOBAL_BACKGROUND_TARGET);

  const patch = useCallback((next: Partial<ChatBackgroundSettings>) => {
    setChatBackgroundSettings(next);
  }, []);

  async function pick(file: File | undefined) {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await prepareChatBackgroundFile(file);
      const saved = await saveChatBackgroundImage(scope, blob);
      if (!saved) setError(t`Couldn't save this image on this device`);
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : "";
      setError(reason === "too-large" ? t`That image is too large` : t`Couldn't read this image`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function clear() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await removeChatBackgroundImage(scope);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsGroup title={<Trans>Chat background</Trans>} data-testid="chat-background-settings">
      {bot ? (
        <SettingsRow
          label={<Trans>Applies to</Trans>}
          control={
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
              {[
                { value: bot.id, label: t`This chat` },
                { value: GLOBAL_BACKGROUND_TARGET, label: t`All chats` },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setScope(option.value)}
                  aria-pressed={scope === option.value}
                  className="rounded-md px-3 py-1 text-[13px] text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
                >
                  {option.label}
                </button>
              ))}
            </div>
          }
        >
          <p className="mt-2 text-[12px] text-muted-foreground">
            {scopeIsBot
              ? t`Only ${bot?.name ?? ""} sees this picture.`
              : t`Used by every chat that has no picture of its own.`}
          </p>
        </SettingsRow>
      ) : (
        <SettingsRow label={<Trans>Applies to</Trans>}>
          <p className="mt-1 text-[12px] text-muted-foreground">
            <Trans>Open a bot's chat, then come back here to give that chat its own picture.</Trans>
          </p>
        </SettingsRow>
      )}

      <SettingsRow
        label={<Trans>Background image</Trans>}
        control={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus size={15} aria-hidden="true" />
              {hasImage ? <Trans>Replace</Trans> : <Trans>Choose image</Trans>}
            </Button>
            {hasImage ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void clear()}
              >
                <Trash2 size={15} aria-hidden="true" />
                <Trans>Remove</Trans>
              </Button>
            ) : null}
          </div>
        }
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => void pick(event.currentTarget.files?.[0])}
        />
        {preview ? (
          <div className="mt-3 overflow-hidden rounded-lg border border-border">
            <img src={preview} alt={t`Background preview`} className="h-28 w-full object-cover" />
          </div>
        ) : (
          <p className="mt-2 text-[12px] text-muted-foreground">
            {scopeIsBot
              ? sharedPresent
                ? t`No picture for this chat, so it uses the one shared by all chats.`
                : t`No picture yet.`
              : t`No picture yet.`}
          </p>
        )}
        {error ? <p className="mt-2 text-[12px] text-destructive">{error}</p> : null}
      </SettingsRow>

      <SettingsRow label={<Trans>Display</Trans>}>
        <div className="mt-1 flex flex-col gap-3">
          <BackdropSlider
            label={t`Opacity`}
            value={settings.opacity}
            min={CHAT_BACKGROUND_LIMITS.opacity.min}
            max={CHAT_BACKGROUND_LIMITS.opacity.max}
            step={CHAT_BACKGROUND_LIMITS.opacity.step}
            display={Percent(settings.opacity)}
            onChange={(opacity) => patch({ opacity })}
          />
          <BackdropSlider
            label={t`Blur`}
            value={settings.blur}
            min={CHAT_BACKGROUND_LIMITS.blur.min}
            max={CHAT_BACKGROUND_LIMITS.blur.max}
            step={CHAT_BACKGROUND_LIMITS.blur.step}
            display={`${Math.round(settings.blur)}px`}
            onChange={(blur) => patch({ blur })}
          />
          <BackdropSlider
            label={t`Dim`}
            value={settings.scrim}
            min={CHAT_BACKGROUND_LIMITS.scrim.min}
            max={CHAT_BACKGROUND_LIMITS.scrim.max}
            step={CHAT_BACKGROUND_LIMITS.scrim.step}
            display={Percent(settings.scrim)}
            onChange={(scrim) => patch({ scrim })}
          />
        </div>
      </SettingsRow>

      <SettingsRow
        label={
          <span className="flex items-center gap-1.5">
            <Trans>Restore defaults</Trans>
          </span>
        }
        control={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => resetChatBackgroundSettings()}
          >
            <RotateCcw size={15} aria-hidden="true" />
            <Trans>Reset</Trans>
          </Button>
        }
      >
        <p className="mt-1 text-[12px] text-muted-foreground">
          <Trans>Pictures stay in this browser. Clearing site data removes them.</Trans>
        </p>
      </SettingsRow>
    </SettingsGroup>
  );
}
