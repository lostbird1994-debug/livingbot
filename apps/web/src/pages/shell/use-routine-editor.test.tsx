// @vitest-environment jsdom
import type { Bot, Routine } from "@livingbot/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/rpc";
import { useRoutineEditor } from "./use-routine-editor";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: (parts: TemplateStringsArray) => parts.join("") }),
}));

const routine: Routine = {
  id: "routine-1",
  botId: "bot-1",
  name: "Daily",
  prompt: "",
  crons: ["0 9 * * *"],
  timezone: "UTC",
  active: true,
  notify: true,
  requireOutput: false,
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  watch: null,
  watchState: null,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};

let root: Root;
let editor: ReturnType<typeof useRoutineEditor>;
let finishUpdate: (saved: Routine) => void;
const update = vi.fn();
const testRun = vi.fn();
const refreshThread = vi.fn(async () => ({}) as never);

function Harness() {
  editor = useRoutineEditor({
    rpc: { routines: { update, testRun } } as unknown as ReturnType<typeof createSpaceRpc>,
    active: { id: "bot-1", webhookConfigured: false } as Bot,
    activeBotId: { current: "bot-1" },
    timezone: "UTC",
    messageProviders: [],
    setBots: () => {},
    refreshThread,
    setPanel: () => {},
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  update.mockImplementation(() => new Promise<Routine>((resolve) => (finishUpdate = resolve)));
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("keeps edits made while a save is in flight", async () => {
  act(() => editor.editRoutine(routine));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, name: "Weekly" }));

  let saving!: Promise<void>;
  act(() => {
    saving = editor.editorProps!.onSave() as unknown as Promise<void>;
  });
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ name: "Weekly" }));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, name: "Monthly" }));

  await act(async () => {
    finishUpdate({ ...routine, name: "Weekly", prompt: "Check in." });
    await saving;
  });

  expect(editor.editingRoutine?.name).toBe("Weekly");
  expect(editor.editorProps!.draft.name).toBe("Monthly");
  expect(editor.editorProps!.draft.prompt).toBe("Check in.");
});

it("sends on/off only when the save changes it", async () => {
  update.mockResolvedValue(routine);
  act(() => editor.editRoutine(routine));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, name: "Renamed" }));
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update.mock.calls[0]![0]).not.toHaveProperty("active");

  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, active: false }));
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update.mock.calls[1]![0]).toMatchObject({ active: false });
});

it("saves only the toggle for built-ins even if a draft contains other edits", async () => {
  const builtin = { ...routine, builtinKind: "daily-review" as const };
  update.mockResolvedValue({ ...builtin, active: false });
  act(() => editor.editRoutine(builtin));
  act(() =>
    editor.editorProps!.onChange({
      ...editor.editorProps!.draft,
      name: "Changed",
      prompt: "Changed",
      active: false,
    }),
  );
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update).toHaveBeenCalledWith({ routineId: routine.id, active: false });
  act(() => editor.editorProps!.onDelete());
  expect(editor.deleteDialogProps).toBeNull();
});

it("updates only activation from the list without replacing other task settings", async () => {
  update.mockResolvedValue({ ...routine, active: false });
  await act(async () => {
    await editor.toggleRoutine(routine, false);
  });
  expect(update).toHaveBeenCalledWith({ routineId: routine.id, active: false });
  expect(editor.editingRoutine).toBeNull();
});

it("test runs a paused built-in once while the request is pending", async () => {
  let finish!: () => void;
  testRun.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
  act(() => editor.editRoutine({ ...routine, builtinKind: "daily-review", active: false }));
  let running!: Promise<void>;
  act(() => {
    running = editor.editorProps!.onTestRun() as unknown as Promise<void>;
    editor.editorProps!.onTestRun();
  });
  expect(testRun).toHaveBeenCalledExactlyOnceWith({ routineId: routine.id });
  expect(editor.editorProps!.running).toBe(true);
  await act(async () => {
    finish();
    await running;
  });
  expect(refreshThread).toHaveBeenCalledWith(routine.botId);
  expect(editor.editorProps!.running).toBe(false);
  expect(editor.editingRoutine?.active).toBe(false);
  expect(update).not.toHaveBeenCalled();
});

it("shows a system test run failure and enables retry", async () => {
  testRun.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({});
  act(() => editor.editRoutine({ ...routine, builtinKind: "memory-organization" }));
  await act(async () => {
    await editor.editorProps!.onTestRun();
  });
  expect(editor.editorProps!.error).toBe("offline");
  expect(editor.editorProps!.running).toBe(false);
  await act(async () => {
    await editor.editorProps!.onTestRun();
  });
  expect(editor.editorProps!.error).toBeNull();
  expect(testRun).toHaveBeenCalledTimes(2);
});
