import { useLingui } from "@lingui/react/macro";
import { cn } from "@livingbot/ui-web";
import { useEffect, useMemo, useRef } from "react";
import type { ChatTurn } from "../../lib/turn-titles";

/**
 * The chat's margin: one hairline per turn, left-aligned to the pane's own edge and starting under
 * the header's name. Pointing at the lines — or tabbing to them — widens the same column into a
 * list, so the titles unfold out of the margin instead of replacing it with a card. The strip keeps
 * at most the chosen number of lines, centered on the turn being read; the open list still holds
 * every turn.
 */
export function TurnRail({
  turns,
  activeId,
  onJump,
  visibleCount = 25,
}: {
  turns: readonly ChatTurn[];
  activeId: string | null;
  onJump: (messageId: string) => void;
  visibleCount?: number;
}) {
  const { t } = useLingui();
  const listRef = useRef<HTMLDivElement>(null);
  // A window around the reader, so a long chat still shows where they are rather than a wall of
  // lines that has to be scrolled through for a hint.
  const marks = useMemo(() => {
    if (turns.length <= visibleCount) return turns;
    const active = turns.findIndex((turn) => turn.id === activeId);
    const start = Math.min(
      Math.max(active < 0 ? turns.length - visibleCount : active - Math.floor(visibleCount / 2), 0),
      turns.length - visibleCount,
    );
    return turns.slice(start, start + visibleCount);
  }, [turns, activeId, visibleCount]);
  // Follow the reader: bring the active turn back into the open list without touching the list
  // while they are scrolling it themselves.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !activeId) return;
    const item = [...list.querySelectorAll<HTMLElement>("[data-turn-id]")].find(
      (entry) => entry.dataset.turnId === activeId,
    );
    if (!item) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight)
      list.scrollTop = bottom - list.clientHeight;
  }, [activeId, visibleCount]);
  return (
    <nav
      aria-label={t`Turns in this chat`}
      data-testid="turn-rail"
      // The header draws its name at 22px from the pane's edge, so the strip holds that lane open
      // and starts on the same x: the margin reads as one left edge, and the text never runs under
      // it. Narrow panes have no room for the lane.
      className="rk-turn-rail group/rail relative hidden w-[38px] shrink-0 flex-col justify-center md:flex"
    >
      <button
        type="button"
        className="flex w-full flex-col items-start gap-[9px] py-2 ps-[22px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="sr-only">{t`Turns in this chat`}</span>
        {marks.map((turn) => (
          <span
            key={turn.id}
            aria-hidden="true"
            className={cn(
              "block h-[2px] w-[10px] shrink-0 rounded-full transition-colors duration-150 motion-reduce:transition-none",
              turn.id === activeId
                ? "bg-foreground/80"
                : "bg-foreground/20 group-hover/rail:bg-foreground/30",
            )}
          />
        ))}
      </button>
      <div
        // Its content starts on the strip's x, so the rows' own lines open exactly where the
        // closed lines sat.
        className="rk-turn-rail-panel absolute start-[10px] top-1/2 z-20 -translate-y-1/2 overflow-hidden rounded-2xl bg-popover shadow-lg"
      >
        <div className="w-[20rem] px-3 py-2.5">
          <div
            ref={listRef}
            data-testid="turn-rail-list"
            style={{ maxHeight: `min(${visibleCount * 24}px, 60vh)` }}
            className="overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {turns.map((turn) => {
              const active = turn.id === activeId;
              return (
                <button
                  key={turn.id}
                  type="button"
                  data-turn-id={turn.id}
                  title={turn.title}
                  aria-current={active ? "location" : undefined}
                  onClick={() => onJump(turn.id)}
                  className="group/turn flex h-6 w-full items-center gap-2"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "block h-[2px] shrink-0 rounded-full transition-[width,background-color] duration-200 ease-out motion-reduce:transition-none",
                      active
                        ? "w-[20px] bg-foreground/80 group-hover/turn:w-[24px]"
                        : "w-[10px] bg-foreground/20 group-hover/turn:w-[20px] group-hover/turn:bg-foreground/40",
                    )}
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-start text-[12.5px] leading-none transition-colors duration-150 motion-reduce:transition-none",
                      active
                        ? "font-medium text-foreground"
                        : "text-muted-foreground group-hover/turn:text-foreground",
                    )}
                  >
                    {turn.title}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
}
