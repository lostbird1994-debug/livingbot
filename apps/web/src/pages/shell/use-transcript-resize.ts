import type { RefObject } from "react";
import { useLayoutEffect } from "react";

/** Keep the reader's message in place when a rail changes the chat width. */
export function useTranscriptResize(
  scrollRef: RefObject<HTMLDivElement | null>,
  following: RefObject<boolean>,
  jumpScrolling: RefObject<boolean>,
) {
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let width = element.clientWidth;
    const contentWidth = () => {
      const style = getComputedStyle(element);
      return element.clientWidth - parseFloat(style.paddingLeft || "0") -
        parseFloat(style.paddingRight || "0");
    };
    let measure = contentWidth();
    let anchor: { row: HTMLElement; top: number } | undefined;

    const remember = () => {
      // Layout can emit a scroll before ResizeObserver runs. Keep the old anchor
      // until the new width has been compensated.
      if (element.clientWidth !== width || contentWidth() !== measure) return;
      const top = element.getBoundingClientRect().top;
      const rows = element.querySelectorAll<HTMLElement>(
        "[data-message-id], [data-testid=time-separator]",
      );
      // Only measure logarithmically many rows, including in long histories.
      let start = 0;
      let end = rows.length;
      while (start < end) {
        const middle = (start + end) >>> 1;
        if (rows[middle]!.getBoundingClientRect().bottom <= top) start = middle + 1;
        else end = middle;
      }
      const row = rows[start];
      anchor = row ? { row, top: row.getBoundingClientRect().top - top } : undefined;
    };

    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width || contentWidth() !== measure) {
        width = element.clientWidth;
        measure = contentWidth();
        if (!jumpScrolling.current) {
          if (anchor && element.contains(anchor.row)) {
            element.scrollTop +=
              anchor.row.getBoundingClientRect().top -
              element.getBoundingClientRect().top -
              anchor.top;
          }
          // Reflow is not a new reply. Keep the visible content still even if
          // the reader was at the tail before the width changed.
          if (element.scrollHeight - element.scrollTop - element.clientHeight > 1)
            following.current = false;
        }
      }
      remember();
    });
    remember();
    element.addEventListener("scroll", remember, { passive: true });
    // The turn margin changes padding from its parent's ResizeObserver. Watch
    // the content box too, including a second reflow at the same viewport width.
    observer.observe(element, { box: "content-box" });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", remember);
    };
  }, [scrollRef, following, jumpScrolling]);
}
