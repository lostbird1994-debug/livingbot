import { Trans, useLingui } from "@lingui/react/macro";
import { Button, SectionHeading } from "@rakazo/ui-web";
import { ImagePlus, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  CHAT_BACKGROUND_LIMITS,
  type ChatBackgroundSettings,
  DEFAULT_CHAT_BACKGROUND_SETTINGS,
  getChatBackgroundRevision,
  getChatBackgroundSettings,
  prepareChatBackgroundFile,
  readChatBackgroundImage,
  removeChatBackgroundImage,
  resetChatBackgroundSettings,
  saveChatBackgroundImage,
  setChatBackgroundSettings,
  subscribeChatBackground,
} from "../lib/chat-background";

/** Object URL for one bot's stored picture, refreshed whenever it changes. */
function useBackdropPreview(target: string, revision: number): string | null {
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
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-xs text-muted-foreground">
          {label}
        </label>
        <span className="text-xs tabular-nums text-muted-foreground">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-primary"
      />
    </div>
  );
}

/**
 * This bot's private-chat backdrop. Lives in the bot panel's Advanced tab
 * because the picture belongs to the bot, not to the app's global appearance.
 */
export function ChatBackgroundSection({ botId, botName }: { botId: string; botName: string }) {
  const { t } = useLingui();
  const revision = useSyncExternalStore(subscribeChatBackground, getChatBackgroundRevision, () => 0);
  const readSettings = useCallback(() => getChatBackgroundSettings(botId), [botId]);
  const settings = useSyncExternalStore(
    subscribeChatBackground,
    readSettings,
    () => DEFAULT_CHAT_BACKGROUND_SETTINGS,
  );
  const preview = useBackdropPreview(botId, revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const hasImage = preview !== null;

  const patch = useCallback(
    (next: Partial<ChatBackgroundSettings>) => {
      setChatBackgroundSettings(botId, next);
    },
    [botId],
  );

  async function pick(file: File | undefined) {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await prepareChatBackgroundFile(file);
      const saved = await saveChatBackgroundImage(botId, blob);
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
      await removeChatBackgroundImage(botId);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6" data-testid="bot-chat-background">
      <SectionHeading variant="label" className="mb-2">
        <Trans>Chat background</Trans>
      </SectionHeading>
      <div className="space-y-3 rounded-xl bg-muted/50 p-4">
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
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => void pick(event.currentTarget.files?.[0])}
        />

        {preview ? (
          <img
            src={preview}
            alt={t`Background preview for ${botName}`}
            className="h-28 w-full rounded-lg object-cover"
          />
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            <Trans>Only this bot's chat shows the picture. It stays on this device.</Trans>
          </p>
        )}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <div className="space-y-3 pt-1">
          <BackdropSlider
            label={t`Opacity`}
            value={settings.opacity}
            min={CHAT_BACKGROUND_LIMITS.opacity.min}
            max={CHAT_BACKGROUND_LIMITS.opacity.max}
            step={CHAT_BACKGROUND_LIMITS.opacity.step}
            display={`${Math.round(settings.opacity * 100)}%`}
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
            display={`${Math.round(settings.scrim * 100)}%`}
            onChange={(scrim) => patch({ scrim })}
          />
          <BackdropSlider
            label={t`Bubbles`}
            value={settings.bubble}
            min={CHAT_BACKGROUND_LIMITS.bubble.min}
            max={CHAT_BACKGROUND_LIMITS.bubble.max}
            step={CHAT_BACKGROUND_LIMITS.bubble.step}
            display={`${Math.round(settings.bubble * 100)}%`}
            onChange={(bubble) => patch({ bubble })}
          />
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            <Trans>These settings and the picture stay on this device.</Trans>
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => resetChatBackgroundSettings(botId)}
          >
            <RotateCcw size={14} aria-hidden="true" />
            <Trans>Reset</Trans>
          </Button>
        </div>
      </div>
    </section>
  );
}
