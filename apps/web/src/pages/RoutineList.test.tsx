// @vitest-environment jsdom
import type { Routine } from "@livingbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { draftFromRoutine, RoutineEditor, RoutineList } from "./RoutineEditor";

function translate(parts: TemplateStringsArray, ...values: unknown[]) {
  return parts.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
}
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) => translate(parts, ...values),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ i18n: { locale: "en" }, t: translate }),
}));
vi.mock("../lib/rpc", () => ({
  rpc: { models: { credentials: async () => [], list: async () => [] } },
}));
vi.mock("./RoutineRunHistory", () => ({ RoutineRunHistory: () => null }));
const routine = {
  id: "review",
  name: "Daily review",
  builtinKind: "daily-review",
  active: true,
  crons: ["0 18 * * *"],
  timezone: "UTC",
} as Routine;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("saves from the switch, prevents duplicate requests and keeps the trigger visible when disabled", async () => {
  let finish!: (saved: Routine) => void;
  const toggle = vi.fn(
    () =>
      new Promise<Routine>((resolve) => {
        finish = resolve;
      }),
  );
  const open = vi.fn();
  act(() =>
    root.render(
      <RoutineList
        routines={[routine]}
        onCreate={() => {}}
        onEdit={open}
        onToggle={toggle}
        runningRoutineId={routine.id}
      />,
    ),
  );
  const control = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(control.getAttribute("aria-checked")).toBe("true");
  act(() => control.click());
  expect(toggle).toHaveBeenCalledWith(routine, false);
  expect(open).not.toHaveBeenCalled();
  expect(control.hasAttribute("data-disabled")).toBe(true);
  act(() => control.click());
  expect(toggle).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ...routine, active: false }));
  expect(control.getAttribute("aria-checked")).toBe("false");
  expect(container.textContent).toContain("6:00 PM");
  expect(container.textContent).toContain("System");
  expect(container.textContent).not.toContain("Stop");
  act(() =>
    Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Daily review"))!
      .click(),
  );
  expect(open).toHaveBeenCalledWith(routine);
});

it("keeps activation on a failed save and disables changes for read-only routines", async () => {
  const toggle = vi.fn().mockRejectedValue(new Error("Could not save routine"));
  const render = (row: Routine) =>
    root.render(
      <RoutineList routines={[row]} onCreate={() => {}} onEdit={() => {}} onToggle={toggle} />,
    );
  act(() => render(routine));
  const control = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async () => control.click());
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not save routine");
  act(() => render({ ...routine, editable: false }));
  expect(control.hasAttribute("data-disabled")).toBe(true);
});

it.each([
  "daily-review",
  "memory-organization",
  "context-audit",
  "workspace-organization",
] as const)(
  "offers a test run for a paused %s without allowing definition edits",
  async (builtinKind) => {
    const row = { ...routine, builtinKind, active: false, watch: null };
    const testRun = vi.fn();
    await act(async () =>
      root.render(
        <RoutineEditor
          draft={draftFromRoutine(row)}
          editing={row}
          timezone="UTC"
          webhook={{ path: "", secret: null, configured: false }}
          githubPath=""
          messageProviders={[]}
          saving={false}
          running={false}
          error={null}
          onChange={() => {}}
          onBack={() => {}}
          onClose={() => {}}
          onSave={() => {}}
          onTestRun={testRun}
          onDelete={() => {}}
          onEnsureWebhook={async () => {}}
        />,
      ),
    );
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Test run",
    )!;
    expect(button.disabled).toBe(false);
    act(() => button.click());
    expect(testRun).toHaveBeenCalledOnce();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("Delete");
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  },
);

it.each([
  { saving: true, running: false, editable: true },
  { saving: false, running: true, editable: true },
  { saving: false, running: false, editable: false },
])("disables a system test run when unavailable: %j", async ({ saving, running, editable }) => {
  const row = { ...routine, editable, watch: null };
  const testRun = vi.fn();
  await act(async () =>
    root.render(
      <RoutineEditor
        draft={draftFromRoutine(row)}
        editing={row}
        timezone="UTC"
        webhook={{ path: "", secret: null, configured: false }}
        githubPath=""
        messageProviders={[]}
        saving={saving}
        running={running}
        error="Could not run routine"
        onChange={() => {}}
        onBack={() => {}}
        onClose={() => {}}
        onSave={() => {}}
        onTestRun={testRun}
        onDelete={() => {}}
        onEnsureWebhook={async () => {}}
      />,
    ),
  );
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === (running ? "Running…" : "Test run"),
  )!;
  expect(button.disabled).toBe(true);
  act(() => button.click());
  expect(testRun).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not run routine");
});
