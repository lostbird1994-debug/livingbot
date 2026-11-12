// @vitest-environment jsdom
import type { Bot } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeBotVoicePreferences } from "../../lib/voice-assistant-pref";
import { VoiceAssistant } from "./VoiceAssistant";

const fake = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  setTargets: vi.fn(),
  setPaused: vi.fn(),
  startCall: vi.fn(),
  endCall: vi.fn(),
  toggleMute: vi.fn(),
  call: null as any,
  options: null as any,
  intercept: null as any,
  announce: vi.fn(() => true),
  get: vi.fn(),
  prepare: vi.fn(),
  bridge: undefined as any,
}));
vi.mock("../../lib/call-session", () => ({
  startCall: fake.startCall,
  endCall: fake.endCall,
  toggleMute: fake.toggleMute,
  useCallSession: () => fake.call,
  getSnapshot: () => fake.call,
  interceptCallWake: (handler: unknown) => {
    fake.intercept = handler;
    return () => {
      fake.intercept = null;
    };
  },
}));
vi.mock("../../lib/wake-listener", () => ({
  WakeListener: class {
    start = fake.start;
    stop = fake.stop;
    setTargets = fake.setTargets;
    setPaused = fake.setPaused;
  },
}));
vi.mock("../../lib/space-rpc", () => ({ useSpaceRpc: () => client }));
vi.mock("../../lib/desktop", () => ({ desktopBridge: () => fake.bridge }));
vi.mock("../../lib/tts", () => ({
  speaker: { subscribe: () => () => undefined, isSpeaking: () => false },
}));
vi.mock("../../lib/dictation", () => ({ dictation: { subscribe: () => () => undefined } }));
vi.mock("../../lib/announcer", async (original) => ({
  ...(await original<typeof import("../../lib/announcer")>()),
  announcer: { announce: fake.announce, clear: vi.fn(), setBlockedCheck: vi.fn() },
}));
const client = { threads: { get: fake.get }, voice: { prepare: fake.prepare } };
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const bot = (id = "a", patch: Partial<Bot> = {}) =>
  ({
    id,
    name: id === "a" ? "阿蓝 | 财务助手" : "小雨",
    spaceId: "space",
    archivedAt: null,
    color: "",
    status: "idle",
    preview: "",
    updatedAt: "1",
    ...patch,
  }) as Bot;
const wake = () =>
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", altKey: true }));
const prefs = (id: string, wakeEnabled = true, notifyEnabled = false) =>
  writeBotVoicePreferences(id, { wakeEnabled, notifyEnabled, aliases: [] });
async function render(bots: Bot[], activeBotId?: string) {
  await act(async () => root.render(<VoiceAssistant bots={bots} activeBotId={activeBotId} />));
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.call = null;
  fake.bridge = undefined;
  localStorage.clear();
  fake.start.mockImplementation(async (options) => {
    fake.options = options;
    options.onReady?.();
    return true;
  });
  fake.announce.mockReturnValue(true);
  fake.get.mockResolvedValue({ run: null, messages: [] });
  fake.prepare.mockResolvedValue({ ready: true, utterances: ["检查完成，请查看结果"] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("keeps the mic closed until explicitly entered and only targets enabled bots", async () => {
  prefs("a");
  await render([bot(), bot("b")]);
  expect(fake.start).not.toHaveBeenCalled();
  await act(async () => wake());
  expect(fake.start.mock.calls[0]?.[1]).toEqual([
    { id: "a", name: "阿蓝 | 财务助手", aliases: [] },
  ]);
  expect(host.textContent).toContain("等待呼唤");
  await act(async () => wake());
  expect(host.querySelector("[aria-label='语音模式']")).toBeNull();
  expect(fake.stop).toHaveBeenCalled();
});

it("stays in voice mode after the old six-second expiry and allows name switching in a call", async () => {
  vi.useFakeTimers();
  prefs("a");
  prefs("b");
  await render([bot(), bot("b")]);
  await act(async () => wake());
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(host.textContent).toContain("等待呼唤");
  await act(async () => fake.options.onWake({ bot: { id: "a" }, rest: "核对账目" }));
  expect(fake.startCall).toHaveBeenLastCalledWith(
    expect.objectContaining({ botId: "a", firstUtterance: "核对账目" }),
  );
  await act(async () => {
    expect(fake.intercept("小雨，帮我查邮件", "a")).toBeNull();
  });
  expect(fake.startCall).toHaveBeenLastCalledWith(
    expect.objectContaining({ botId: "b", firstUtterance: "帮我查邮件" }),
  );
  expect(fake.intercept("请把结果发给小雨", "a")).toBe("请把结果发给小雨");
});

it("does not double toggle a registered desktop shortcut", async () => {
  prefs("a");
  let onCommand: (action: string) => void = () => undefined;
  fake.bridge = {
    voice: {
      connect: async () => ({ registered: true }),
      onCommand: (handler: typeof onCommand) => {
        onCommand = handler;
        return () => undefined;
      },
      update: vi.fn(async () => undefined),
      reveal: vi.fn(async () => undefined),
    },
  };
  await render([bot()]);
  await act(async () => {
    onCommand("toggle");
    wake();
  });
  expect(host.textContent).toContain("等待呼唤");
  await act(async () => onCommand("toggle"));
  expect(host.textContent).toBe("");
});

it("shows a microphone/recognition error and supports retry without changing bot preferences", async () => {
  prefs("a");
  await render([bot()]);
  await act(async () => wake());
  await act(async () => fake.options.onError("识别服务不可用"));
  expect(host.textContent).toContain("识别服务不可用");
  const retry = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "重试",
  );
  await act(async () => retry!.click());
  expect(fake.start).toHaveBeenCalledTimes(2);
});

it("notifies a completed reply once using the AI summary instead of the original text", async () => {
  prefs("a", false, true);
  const initial = bot();
  await render([initial]);
  fake.get.mockResolvedValue({
    run: null,
    messages: [
      {
        id: "reply",
        role: "bot",
        blocks: [{ kind: "text", text: "检查完成。无需修改。\n\n详细内容不播报。" }],
      },
    ],
  });
  const final = bot("a", { preview: "错误的预览", updatedAt: "2" });
  await render([final]);
  expect(fake.announce).toHaveBeenCalledWith(
    "收到阿蓝 | 财务助手发来的消息：检查完成，请查看结果",
    "a",
    expect.any(Function),
  );
  expect(fake.prepare).toHaveBeenCalledWith({
    botId: "a",
    text: "检查完成。无需修改。\n\n详细内容不播报。",
    purpose: "notification",
  });
  await render([bot("a", { ...final, updatedAt: "3" })]);
  expect(fake.announce).toHaveBeenCalledOnce();
});

it("suppresses notifications for the visible conversation and for bots that did not opt in", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  prefs("a", false, true);
  await render([bot(), bot("b")], "a");
  await render(
    [bot("a", { updatedAt: "2", preview: "完成" }), bot("b", { updatedAt: "2", preview: "完成" })],
    "a",
  );
  expect(fake.announce).not.toHaveBeenCalled();
});

it("drops notifications throughout voice mode, including while waiting for a wake name", async () => {
  prefs("a", true, true);
  await render([bot()]);
  await act(async () => wake());
  fake.get.mockResolvedValue({
    run: null,
    messages: [{ id: "new-reply", role: "bot", blocks: [{ kind: "text", text: "任务完成。" }] }],
  });
  await render([bot("a", { updatedAt: "2", preview: "完成" })]);
  expect(fake.prepare).not.toHaveBeenCalled();
  expect(fake.announce).not.toHaveBeenCalled();
});

it("establishes a baseline when notifications are enabled during a running task", async () => {
  prefs("a", false, true);
  fake.get.mockResolvedValue({
    run: { status: "running" },
    messages: [{ id: "old", role: "bot", blocks: [{ kind: "text", text: "旧回复。" }] }],
  });
  await render([bot("a", { status: "running" })]);
  expect(fake.announce).not.toHaveBeenCalled();
  fake.get.mockResolvedValue({
    run: null,
    messages: [{ id: "new", role: "bot", blocks: [{ kind: "text", text: "新任务已完成。" }] }],
  });
  fake.prepare.mockResolvedValue({ ready: true, utterances: ["新任务已完成"] });
  await render([bot("a", { updatedAt: "2" })]);
  expect(fake.announce).toHaveBeenCalledWith(
    expect.stringContaining("新任务已完成"),
    "a",
    expect.any(Function),
  );
});
