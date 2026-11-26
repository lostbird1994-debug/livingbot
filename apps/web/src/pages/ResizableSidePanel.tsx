import { t } from "@lingui/core/macro";
import type { CSSProperties, PointerEvent, ReactNode } from "react";
import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { getChatWidth, subscribeReadingPrefs } from "../lib/reading-prefs";
import { CHAT_WIDTH_MEASURE } from "../lib/transcript-layout";
import { useBotsSidebarWidth } from "./shell/sidebar-layout";

const STORAGE_KEY = "rakazo:right-panel-width";
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 384;
const ABSOLUTE_MAX = 1000;
const MIN_CHAT_WIDTH = 320;
const CLOSE_DURATION = 160;

// Keep the last open tree through the exit, even when its parent clears the tab.
// Once closed, accept updates again so the hidden find panel retains its state.
const PanelContent = memo(
  function PanelContent({ children }: { children: ReactNode; frozen: boolean }) {
    return children;
  },
  (_previous, next) => next.frozen,
);

function maximumWidth(reservedLeadingPx: number, viewportWidth = window.innerWidth) {
  return Math.max(
    MIN_WIDTH,
    Math.min(ABSOLUTE_MAX, viewportWidth - reservedLeadingPx - MIN_CHAT_WIDTH),
  );
}

function readPreferredWidth() {
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    if (saved >= MIN_WIDTH) return Math.min(ABSOLUTE_MAX, saved);
  } catch {
    /* Storage may be disabled. */
  }
  return DEFAULT_WIDTH;
}

export function ResizableSidePanel({
  open,
  panel,
  children,
}: {
  open: boolean;
  panel: string;
  children: ReactNode;
}) {
  const reservedLeadingPx = useBotsSidebarWidth();
  const chatWidth = useSyncExternalStore(subscribeReadingPrefs, getChatWidth, getChatWidth);
  const [preferredWidth, setPreferredWidth] = useState(readPreferredWidth);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const slotRef = useRef<HTMLDivElement>(null);
  const maxWidth = maximumWidth(reservedLeadingPx, viewportWidth);
  const drag = useRef<{ x: number; width: number; direction: number } | null>(null);
  const width = Math.max(MIN_WIDTH, Math.min(maxWidth, preferredWidth));
  // Keep the selected reading measure, both gutters, and the turn strip beside it.
  // On smaller windows the panel slides over the chat instead of rewrapping it.
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const readingWidth = Number.parseFloat(CHAT_WIDTH_MEASURE[chatWidth]) * rem + 2 * rem + 25;
  const overlay = viewportWidth - reservedLeadingPx - width < readingWidth;
  const resizable = viewportWidth - reservedLeadingPx >= MIN_CHAT_WIDTH + MIN_WIDTH;
  const [present, setPresent] = useState(open);
  const [shown, setShown] = useState(open);

  useLayoutEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      setPresent(open);
      setShown(open);
      return;
    }
    if (open) {
      setPresent(true);
      // Commit the final layout and off-screen surface before starting the slide.
      let secondFrame = 0;
      const firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(firstFrame);
        cancelAnimationFrame(secondFrame);
      };
    }
    drag.current = null;
    setShown(false);
    const timer = window.setTimeout(() => setPresent(false), CLOSE_DURATION);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(preferredWidth));
    } catch {
      /* Storage may be disabled. */
    }
  }, [preferredWidth]);

  useLayoutEffect(() => {
    const container = slotRef.current!.parentElement!;
    const syncMax = () => setViewportWidth(container.clientWidth);
    syncMax();
    // The actual layout width also accounts for the interface's text-size zoom.
    const observer = new ResizeObserver(syncMax);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  function stopDrag(event: PointerEvent<HTMLHRElement>) {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function setWidthFromUser(next: number) {
    setPreferredWidth(Math.max(MIN_WIDTH, Math.min(maxWidth, next)));
  }

  return (
    <>
      {/* Keep the dock until its surface has finished sliding out. */}
      <div
        ref={slotRef}
        aria-hidden="true"
        className="hidden shrink-0 md:block"
        style={{ width: present && !overlay ? width : 0 }}
      />
      <aside
        data-testid="side-panel"
        data-panel={panel}
        data-overlay={overlay || undefined}
        aria-hidden={!open}
        inert={!open}
        onTransitionEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            (event.propertyName === "translate" || event.propertyName === "transform") &&
            !open
          )
            setPresent(false);
        }}
        style={{ "--panel-width": `${width}px` } as CSSProperties}
        className={`absolute inset-y-0 end-0 z-20 flex min-h-0 w-full max-w-[384px] flex-col overflow-hidden border-s border-sidebar-border bg-background transition-transform ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none md:w-(--panel-width) md:max-w-none ${shown ? "translate-x-0 duration-200" : "pointer-events-none translate-x-full duration-160 rtl:-translate-x-full"}`}
      >
        {open ? (
          <hr
            tabIndex={0}
            aria-label={t`Resize panel`}
            aria-orientation="vertical"
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={maxWidth}
            aria-valuenow={Math.round(width)}
            className={`absolute inset-y-0 start-0 z-30 m-0 hidden h-full w-2 touch-none cursor-col-resize border-0 bg-transparent hover:bg-border focus-visible:bg-border focus-visible:outline-none ${resizable ? "md:block" : ""}`}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = {
                x: event.clientX,
                width,
                direction: document.documentElement.dir === "rtl" ? -1 : 1,
              };
            }}
            onPointerMove={(event) => {
              if (drag.current)
                setWidthFromUser(
                  drag.current.width + (drag.current.x - event.clientX) * drag.current.direction,
                );
            }}
            onPointerUp={stopDrag}
            onPointerCancel={stopDrag}
            onLostPointerCapture={() => {
              drag.current = null;
            }}
            onKeyDown={(event) => {
              const direction = document.documentElement.dir === "rtl" ? -1 : 1;
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                setWidthFromUser(width + (event.key === "ArrowLeft" ? 32 : -32) * direction);
              } else if (event.key === "Home") {
                event.preventDefault();
                setWidthFromUser(MIN_WIDTH);
              } else if (event.key === "End") {
                event.preventDefault();
                setWidthFromUser(maxWidth);
              }
            }}
          />
        ) : null}
        <PanelContent frozen={!open && present}>{children}</PanelContent>
      </aside>
    </>
  );
}
