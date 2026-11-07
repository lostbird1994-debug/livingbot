import { useEffect, useState, useSyncExternalStore } from "react";
import {
  type ChatBackgroundSettings,
  DEFAULT_CHAT_BACKGROUND_SETTINGS,
  getChatBackgroundRevision,
  getChatBackgroundSettings,
  resolveChatBackgroundImage,
  subscribeChatBackground,
} from "../lib/chat-background";

/** The picture resolved for one chat, plus the object URL that shows it. */
function useChatBackdrop(botId: string | null): { url: string | null; target: string | null } {
  const revision = useSyncExternalStore(
    subscribeChatBackground,
    getChatBackgroundRevision,
    () => 0,
  );
  const [backdrop, setBackdrop] = useState<{ url: string | null; target: string | null }>({
    url: null,
    target: null,
  });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    void resolveChatBackgroundImage(botId).then((found) => {
      if (cancelled) return;
      if (!found) {
        setBackdrop({ url: null, target: null });
        return;
      }
      objectUrl = URL.createObjectURL(found.blob);
      setBackdrop({ url: objectUrl, target: found.target });
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [botId, revision]);

  return backdrop;
}

/**
 * Paints the chat's backdrop behind the transcript.
 *
 * Sits in the transcript's relative wrapper rather than inside the scroll
 * container, so the picture stays put while messages scroll, and never
 * intercepts clicks.
 */
export function ChatBackgroundLayer({ botId }: { botId: string | null }) {
  const backdrop = useChatBackdrop(botId);
  const settings: ChatBackgroundSettings = useSyncExternalStore(
    subscribeChatBackground,
    getChatBackgroundSettings,
    () => DEFAULT_CHAT_BACKGROUND_SETTINGS,
  );

  if (!backdrop.url) return null;

  return (
    <div aria-hidden="true" data-testid="chat-background" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage: `url("${backdrop.url}")`,
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
