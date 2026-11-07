import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  DEFAULT_CHAT_BACKGROUND_SETTINGS,
  getChatBackgroundRevision,
  getChatBackgroundSettings,
  readChatBackgroundImage,
  subscribeChatBackground,
} from "../lib/chat-background";

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
      if (cancelled || !blob) return;
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
 * Paints this bot's backdrop behind the transcript.
 *
 * Sits in the transcript's relative wrapper rather than inside the scroll
 * container, so the picture stays put while messages scroll and never
 * intercepts clicks.
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

  if (!url) return null;

  return (
    <div
      aria-hidden="true"
      data-testid="chat-background"
      className="pointer-events-none absolute inset-0 overflow-hidden"
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
    </div>
  );
}
