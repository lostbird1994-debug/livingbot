import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  register: vi.fn((_shortcut: string, _handler: () => void) => true),
  unregister: vi.fn(),
  contents: { send: vi.fn(), setBackgroundThrottling: vi.fn() },
  show: vi.fn(),
  focus: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: class {},
  globalShortcut: { register: fake.register, unregister: fake.unregister },
  ipcMain: {
    handle: (key: string, handler: (...args: any[]) => any) => fake.handlers.set(key, handler),
    removeHandler: (key: string) => fake.handlers.delete(key),
  },
  screen: {},
}));
import { installVoiceMode, voiceOverlayState } from "./voice-mode.js";

beforeEach(() => {
  vi.clearAllMocks();
  fake.handlers.clear();
});

it("registers once, sends a global command without focusing, and releases the shortcut", () => {
  const controller = installVoiceMode({
    window: () =>
      ({
        isDestroyed: () => false,
        webContents: fake.contents,
        isMinimized: () => false,
        show: fake.show,
        focus: fake.focus,
      }) as never,
    authorize: (event) => Boolean((event as unknown as { allowed: boolean }).allowed),
  });
  const connect = fake.handlers.get("desktop.voice.connect")!;
  expect(connect({ allowed: false }).registered).toBe(false);
  expect(fake.register).not.toHaveBeenCalled();
  expect(connect({ allowed: true }).registered).toBe(true);
  connect({ allowed: true });
  expect(fake.register).toHaveBeenCalledOnce();
  const toggle = fake.register.mock.calls[0]?.[1] as unknown as () => void;
  toggle();
  expect(fake.contents.send).toHaveBeenCalledWith("desktop.voice.command", "toggle");
  expect(fake.focus).not.toHaveBeenCalled();
  fake.handlers.get("desktop.voice.reveal")!({ allowed: true });
  expect(fake.focus).toHaveBeenCalledOnce();
  controller.dispose();
  expect(fake.unregister).toHaveBeenCalledWith("Alt+Space");
});

it("bounds untrusted overlay text and rejects invalid states", () => {
  expect(
    voiceOverlayState({
      active: true,
      muted: false,
      label: "字".repeat(300),
      detail: "a".repeat(500),
    }),
  ).toMatchObject({ label: "字".repeat(100), detail: "a".repeat(200) });
  expect(voiceOverlayState({ active: "yes" })).toBeNull();
});
