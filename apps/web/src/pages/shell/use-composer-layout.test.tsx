// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerLayout } from "./use-composer-layout";

// jsdom has no layout, so the geometry below stands in for it: one row of
// [attach][gap][text slot][gap][actions], with a chip sharing the text's line.
// The draft fits on one line at the expanded width and wraps at the one-row width,
// which is exactly the draft that used to flip the composer back and forth.
const ATTACH = { left: 12, right: 44, width: 32 };
const ACTIONS = { left: 412, right: 500, width: 88 };
const ONE_ROW_GAP = 14;
const FIELD_ONE_ROW_WIDTH = ACTIONS.left - ATTACH.right - 2 * ONE_ROW_GAP;
const FIELD_EXPANDED_WIDTH = 428;
const CHIP_WIDTH = 100;
const CHIP_GAP = 6;
const ONE_LINE_WIDTH = 260;
const ONE_LINE_HEIGHT = 28;
const TWO_LINE_HEIGHT = 48;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let originalOffsetWidth: PropertyDescriptor | undefined;
let originalScrollHeight: PropertyDescriptor | undefined;
let originalGetRect: typeof HTMLElement.prototype.getBoundingClientRect;

function rect(left: number, right: number, height = ONE_LINE_HEIGHT): DOMRect {
  return {
    left,
    right,
    top: 0,
    bottom: height,
    width: right - left,
    height,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function isExpanded(el: Element) {
  return el.closest("[data-expanded]")?.getAttribute("data-expanded") === "true";
}

function textWidth(el: Element) {
  const field = isExpanded(el) ? FIELD_EXPANDED_WIDTH : FIELD_ONE_ROW_WIDTH;
  const chip = el.closest('[data-testid="field"]')?.querySelector('[data-testid="chip"]');
  return field - (chip ? CHIP_WIDTH + CHIP_GAP : 0);
}

function Harness({ draft, chip }: { draft: string; chip: boolean }) {
  const layout = useComposerLayout(draft, false);
  return (
    <div ref={layout.composerBarRef} data-testid="bar" data-expanded={layout.expanded}>
      <button ref={layout.attachButtonRef} data-testid="attach" type="button" />
      <div ref={layout.composerFieldRef} data-testid="field">
        {chip ? <span data-testid="chip" /> : null}
        <div data-testid="line">
          <textarea ref={layout.textareaRef} value={draft} readOnly />
          <div ref={layout.mirrorRef} />
        </div>
      </div>
      <div ref={layout.composerActionsRef} data-testid="actions" />
    </div>
  );
}

function render(draft: string, chip = true) {
  act(() => root?.render(<Harness draft={draft} chip={chip} />));
}

function expanded() {
  return container?.querySelector('[data-testid="bar"]')?.getAttribute("data-expanded") === "true";
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Reduced motion skips the resize animation, which jsdom cannot run.
  window.matchMedia = (() => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;

  originalGetRect = HTMLElement.prototype.getBoundingClientRect;
  originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  originalScrollHeight = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "scrollHeight",
  );

  HTMLElement.prototype.getBoundingClientRect = function rectFor(this: HTMLElement) {
    switch (this.dataset.testid) {
      case "bar":
        return rect(0, 500, 60);
      case "field":
        return rect(56, 456);
      case "attach":
        return rect(ATTACH.left, ATTACH.right, 32);
      case "actions":
        return rect(ACTIONS.left, ACTIONS.right, 32);
      case "textarea": {
        const width = textWidth(this);
        return rect(56, 56 + width);
      }
      default:
        return rect(0, 0, 0);
    }
  };
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === "chip" ? CHIP_WIDTH : 0;
    },
  });
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      // An explicit width is a probe measurement; otherwise the live slot width applies.
      const probe = Number.parseFloat(this.style.width);
      const width = Number.isFinite(probe) ? probe : textWidth(this);
      return width >= ONE_LINE_WIDTH ? ONE_LINE_HEIGHT : TWO_LINE_HEIGHT;
    },
  });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<Harness draft="" chip />));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  HTMLElement.prototype.getBoundingClientRect = originalGetRect;
  if (originalOffsetWidth)
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
  if (originalScrollHeight)
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", originalScrollHeight);
  vi.restoreAllMocks();
});

describe("composer one-row layout", () => {
  it("stays expanded while the draft only fits once expanded", () => {
    const draft = "麻烦把这两份表转给财务核对一下";
    expect(expanded()).toBe(false);
    for (const next of [draft, `${draft}，`, `${draft}，谢`, `${draft}，谢谢`]) {
      render(next);
      expect([next, expanded()]).toEqual([next, true]);
    }
  });

  it("keeps a draft that fits beside the controls on one row", () => {
    render("短消息", false);
    expect(expanded()).toBe(false);
    render("短消息啊", false);
    expect(expanded()).toBe(false);
  });
});
