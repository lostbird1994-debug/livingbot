// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getChatWidth } from "../lib/reading-prefs";
import { ResizableSidePanel } from "./ResizableSidePanel";

vi.mock("./shell/sidebar-layout", () => ({ useBotsSidebarWidth: () => 316 }));
vi.mock("../lib/reading-prefs", () => ({
  getChatWidth: vi.fn(() => "default"),
  subscribeReadingPrefs: () => () => {},
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const unmounted = vi.fn();
let resize: () => void;
let layoutWidth: number;

function Content() {
  const [draft, setDraft] = useState(0);
  useEffect(() => () => unmounted(), []);
  return (
    <button type="button" onClick={() => setDraft(draft + 1)}>
      Draft {draft}
    </button>
  );
}

function render(open: boolean) {
  act(() =>
    root.render(
      <ResizableSidePanel open={open} panel={open ? "settings" : "closed"}>
        {open ? <Content /> : null}
      </ResizableSidePanel>,
    ),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerWidth", 1500);
  layoutWidth = 1500;
  vi.mocked(getChatWidth).mockReturnValue("default");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  localStorage.clear();
  unmounted.mockClear();
  host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { get: () => layoutWidth });
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("retains content during exit and resumes the same draft when reopened mid-exit", () => {
  render(true);
  act(() => host.querySelector("button")!.click());
  render(false);
  expect(host.textContent).toBe("Draft 1");
  expect(host.querySelector("aside")!.hasAttribute("inert")).toBe(true);
  expect(unmounted).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(80));
  render(true);
  act(() => vi.advanceTimersByTime(200));
  expect(host.textContent).toBe("Draft 1");
  expect(unmounted).not.toHaveBeenCalled();
  expect(host.querySelector("aside")!.hasAttribute("inert")).toBe(false);

  render(false);
  act(() => vi.advanceTimersByTime(160));
  expect(host.textContent).toBe("");
  expect(unmounted).toHaveBeenCalledOnce();
});

it("unmounts immediately with reduced motion", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  render(true);
  render(false);
  expect(host.textContent).toBe("");
  expect(unmounted).toHaveBeenCalledOnce();
});

it("keeps the dock through exit and preserves keyboard resizing", () => {
  render(true);
  const slot = host.firstElementChild as HTMLDivElement;
  expect(slot.style.width).toBe("384px");
  act(() =>
    host.querySelector("hr")!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        bubbles: true,
      }),
    ),
  );
  expect(slot.style.width).toBe("416px");
  expect(localStorage.getItem("rakazo:right-panel-width")).toBe("416");
  render(false);
  expect(slot.style.width).toBe("416px");
  act(() => vi.advanceTimersByTime(160));
  expect(slot.style.width).toBe("0px");
  expect(host.querySelector("aside")!.style.getPropertyValue("--panel-width")).toBe("416px");
  render(true);
  layoutWidth = 800;
  act(() => resize());
  expect(host.querySelector("aside")!.dataset.overlay).toBe("true");
  expect(slot.style.width).toBe("0px");
});

it("overlays before docking would rewrap the selected reading width", () => {
  vi.mocked(getChatWidth).mockReturnValue("wide");
  render(true);
  expect(host.querySelector("aside")!.dataset.overlay).toBe("true");
  expect((host.firstElementChild as HTMLElement).style.width).toBe("0px");
  layoutWidth = 1800;
  act(() => resize());
  expect(host.querySelector("aside")!.dataset.overlay).toBeUndefined();
  expect((host.firstElementChild as HTMLElement).style.width).toBe("384px");
});

it("uses the scaled layout width rather than the unscaled window width", () => {
  layoutWidth = 1100;
  render(true);
  expect(host.querySelector("aside")!.dataset.overlay).toBe("true");
  expect((host.firstElementChild as HTMLElement).style.width).toBe("0px");
});

it("releases the dock when the surface's translate transition finishes", () => {
  render(true);
  render(false);
  const slot = host.firstElementChild as HTMLElement;
  expect(slot.style.width).toBe("384px");
  const event = new Event("transitionend", { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: "translate" });
  act(() => host.querySelector("aside")!.dispatchEvent(event));
  expect(slot.style.width).toBe("0px");
  expect(host.textContent).toBe("");
});

it("commits the hidden surface before opening and cancels a pending open on close", () => {
  render(false);
  render(true);
  expect(host.querySelector("aside")!.className).toContain("translate-x-full");
  expect((host.firstElementChild as HTMLElement).style.width).toBe("384px");
  act(() => vi.advanceTimersByTime(40));
  expect(host.querySelector("aside")!.className).toContain("translate-x-0");
  render(false);
  render(true);
  render(false);
  act(() => vi.advanceTimersByTime(200));
  expect(host.querySelector("aside")!.className).toContain("translate-x-full");
  expect((host.firstElementChild as HTMLElement).style.width).toBe("0px");
});
