import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  DEFAULT_CHAT_BACKGROUND_SETTINGS,
  getChatBackgroundRevision,
  getChatBackgroundSettings,
  readChatBackgroundImage,
  subscribeChatBackground,
} from "../lib/chat-background";

/** CSS variables the surface rules read; cleared when this chat unmounts. */
const SURFACE_VARIABLES = [
  "--rk-bubble-alpha",
  "--rk-alpha-panel",
  "--rk-alpha-sidebar",
  "--rk-alpha-dialog",
  "--rk-alpha-menu",
  "--rk-alpha-input",
  "--rk-alpha-code",
  "--rk-alpha-emphasis",
  "--rk-glass-blur",
] as const;

/** The object URL for this bot's picture, or null when it has none. */
function useChatBackdrop(botId: string | null): string | null {
  const revision = useSyncExternalStore(
    subscribeChatBackground,
    getChatBackgroundRevision,
    () => 0,
  );
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!botId) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void readChatBackgroundImage(botId).then((blob) => {
      if (cancelled) return;
      if (!blob) {
        // Removing the picture must clear it in place, not wait for a reload.
        setUrl(null);
        return;
      }
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [botId, revision]);

  return url;
}

/**
 * Paints the backdrop behind the whole window and publishes this bot's surface
 * opacities as CSS variables.
 *
 * The picture is fixed rather than scrolled, so every translucent surface the
 * shell paints sits on the same image. Surfaces stay opaque at the default
 * values, which is what someone who never opens these settings keeps seeing.
 */
export function ChatBackgroundLayer({ botId }: { botId: string | null }) {
  const url = useChatBackdrop(botId);
  const readSettings = useCallback(
    () => (botId ? getChatBackgroundSettings(botId) : DEFAULT_CHAT_BACKGROUND_SETTINGS),
    [botId],
  );
  const settings = useSyncExternalStore(
    subscribeChatBackground,
    readSettings,
    () => DEFAULT_CHAT_BACKGROUND_SETTINGS,
  );

  // Published even without a picture, so the dialogs a chat opens keep the
  // opacities the user dialled in.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--rk-bubble-alpha", String(settings.bubble));
    root.style.setProperty("--rk-alpha-panel", String(settings.panel));
    root.style.setProperty("--rk-alpha-sidebar", String(settings.sidebar));
    root.style.setProperty("--rk-alpha-dialog", String(settings.dialog));
    root.style.setProperty("--rk-alpha-menu", String(settings.menu));
    root.style.setProperty("--rk-alpha-input", String(settings.input));
    root.style.setProperty("--rk-alpha-code", String(settings.code));
    root.style.setProperty("--rk-alpha-emphasis", String(settings.emphasis));
    root.style.setProperty("--rk-glass-blur", `${settings.glass}px`);
    return () => {
      for (const name of SURFACE_VARIABLES) root.style.removeProperty(name);
    };
  }, [settings]);

  // Only an actual picture turns the translucent surfaces on.
  useEffect(() => {
    const root = document.documentElement;
    if (url) root.dataset.rkBackdrop = "on";
    else delete root.dataset.rkBackdrop;
    return () => {
      delete root.dataset.rkBackdrop;
    };
  }, [url]);

  if (!url) return null;

  // Portalled to the body: the picture has to sit under the sidebar too, and
  // every stacking context between here and the window would trap it.
  return createPortal(
    <div
      aria-hidden="true"
      data-testid="chat-background"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage: `url("${url}")`,
          opacity: settings.opacity,
          filter: settings.blur > 0 ? `blur(${settings.blur}px)` : undefined,
          // Blur samples past the edges; scaling up hides the pale fringe it leaves behind.
          transform: settings.blur > 0 ? "scale(1.08)" : undefined,
        }}
      />
      {settings.scrim > 0 ? (
        // A scrim in the page's own background colour dims the picture in dark
        // themes and lightens it in light ones, so text keeps its contrast.
        <div
          className="absolute inset-0"
          style={{ backgroundColor: "var(--background)", opacity: settings.scrim }}
        />
      ) : null}
    </div>,
    document.body,
  );
}
