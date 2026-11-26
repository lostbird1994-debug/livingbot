// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTranscriptResize } from "./use-transcript-resize";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let scroller: HTMLDivElement;
let resize: () => void;
let width = 900;
let rowShift = 0;
let scrollHeight = 2000;
const following = { current: false };
const jumping = { current: false };
const disconnect = vi.fn();

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  useTranscriptResize(ref, following, jumping);
  return (
    <div ref={ref}>
      <div data-message-id="earlier" />
      <div data-message-id="reading" />
      <div data-message-id="later" />
    </div>
  );
}

beforeEach(() => {
  width = 900;
  rowShift = 0;
  scrollHeight = 2000;
  following.current = false;
  jumping.current = false;
  disconnect.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe(element: HTMLDivElement) {
        scroller = element;
        Object.defineProperty(element, "clientWidth", { get: () => width });
        Object.defineProperty(element, "scrollHeight", { get: () => scrollHeight });
        Object.defineProperty(element, "clientHeight", { get: () => 600 });
        element.scrollTop = 400;
        element.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
        const rows = element.querySelectorAll<HTMLElement>("[data-message-id]");
        rows.forEach((row, index) => {
          row.getBoundingClientRect = () =>
            ({
              top: index * 300 - element.scrollTop + rowShift + 100,
              bottom: (index + 1) * 300 - element.scrollTop + rowShift + 100,
            }) as DOMRect;
        });
      }
      disconnect = disconnect;
    },
  );
  host = document.createElement("div");
  root = createRoot(host);
  act(() => root.render(<Harness />));
  // The initial observer notification establishes the layout anchor.
  resize();
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("keeps the visible message offset across both width changes, even if scroll fires first", () => {
  width = 516;
  rowShift = 180;
  scroller.dispatchEvent(new Event("scroll"));
  resize();
  expect(scroller.scrollTop).toBe(580);
  width = 900;
  rowShift = 0;
  resize();
  expect(scroller.scrollTop).toBe(400);
});

it("captures the new reading position after the user scrolls", () => {
  scroller.scrollTop = 700;
  scroller.dispatchEvent(new Event("scroll"));
  width = 516;
  rowShift = 100;
  resize();
  expect(scroller.scrollTop).toBe(800);
});

it("anchors a visible time separator rather than the message below it", () => {
  const rows = scroller.querySelectorAll<HTMLElement>("[data-message-id]");
  const separator = document.createElement("h3");
  separator.dataset.testid = "time-separator";
  rows[1]!.before(separator);
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => ({
      top: index * 400 - scroller.scrollTop + rowShift + 150,
      bottom: index * 400 - scroller.scrollTop + rowShift + 180,
    }) as DOMRect;
  });
  separator.getBoundingClientRect = () => ({
    top: 520 - scroller.scrollTop,
    bottom: 540 - scroller.scrollTop,
  }) as DOMRect;
  scroller.dispatchEvent(new Event("scroll"));
  width = 516;
  rowShift = 150;
  resize();
  // The separator did not move; growth inside other messages must not scroll it away.
  expect(scroller.scrollTop).toBe(400);
});

it("preserves the reading position at the tail when narrower text makes the content taller", () => {
  scrollHeight = 1000;
  scroller.scrollTop = 400;
  scroller.dispatchEvent(new Event("scroll"));
  following.current = true;
  width = 516;
  scrollHeight = 1300;
  rowShift = 100;
  resize();
  expect(scroller.scrollTop).toBe(500);
  expect(following.current).toBe(false);
});

it("lets explicit message jumps win over width compensation", () => {
  scroller.scrollTop = 250;
  jumping.current = true;
  width = 516;
  rowShift = 100;
  resize();
  expect(scroller.scrollTop).toBe(250);
});

it("ignores height-only changes and disconnects on unmount", () => {
  rowShift = 100;
  resize();
  expect(scroller.scrollTop).toBe(400);
  act(() => root.unmount());
  expect(disconnect).toHaveBeenCalledOnce();
  root = createRoot(host);
});
