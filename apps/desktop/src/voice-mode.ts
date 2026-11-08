import path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { BrowserWindow, globalShortcut, ipcMain, screen } from "electron";

export const VOICE_SHORTCUT = "Alt+Space";
export type VoiceOverlayState = { active: boolean; label: string; detail: string; muted: boolean };

export function voiceOverlayState(value: unknown): VoiceOverlayState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<VoiceOverlayState>;
  if (
    typeof state.active !== "boolean" ||
    typeof state.muted !== "boolean" ||
    typeof state.label !== "string" ||
    typeof state.detail !== "string"
  )
    return null;
  return {
    active: state.active,
    muted: state.muted,
    label: state.label.slice(0, 100),
    detail: state.detail.slice(0, 200),
  };
}

/** One shortcut and a small, non-activating local window. Remote frames cannot control it. */
export function installVoiceMode(options: {
  window: () => BrowserWindow | null;
  authorize: (event: IpcMainInvokeEvent) => boolean;
}) {
  let overlay: BrowserWindow | null = null;
  let registered = false;
  let state: VoiceOverlayState = { active: false, label: "", detail: "", muted: false };
  const send = (command: "toggle" | "exit" | "mute") => {
    const win = options.window();
    if (win && !win.isDestroyed()) win.webContents.send("desktop.voice.command", command);
  };
  const hide = () => {
    overlay?.hide();
  };
  const publish = () => {
    if (!state.active) {
      hide();
      return;
    }
    if (!overlay) {
      const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const panel = new BrowserWindow({
        width: 360,
        height: 112,
        x: workArea.x + workArea.width - 380,
        y: workArea.y + 20,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        show: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        webPreferences: {
          preload: path.join(import.meta.dirname, "voice-preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      overlay = panel;
      panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      panel.webContents.on("will-navigate", (event) => event.preventDefault());
      panel.webContents.on("did-finish-load", () => {
        if (!panel.isDestroyed() && state.active) {
          panel.webContents.send("desktop.voice.state", state);
          panel.showInactive();
        }
      });
      panel.on("closed", () => {
        overlay = null;
      });
      void panel.loadFile(path.join(import.meta.dirname, "voice.html")).catch(() => send("exit"));
    } else {
      overlay.webContents.send("desktop.voice.state", state);
      overlay.showInactive();
    }
  };
  ipcMain.handle("desktop.voice.connect", (event) => {
    if (!options.authorize(event)) return { registered: false, shortcut: VOICE_SHORTCUT };
    if (!registered) {
      try {
        registered = globalShortcut.register(VOICE_SHORTCUT, () => {
          options.window()?.webContents.setBackgroundThrottling(false);
          send("toggle");
        });
      } catch {
        registered = false;
      }
    }
    return { registered, shortcut: VOICE_SHORTCUT };
  });
  ipcMain.handle("desktop.voice.update", (event, value: unknown) => {
    if (!options.authorize(event)) return;
    const next = voiceOverlayState(value);
    if (!next) return;
    state = next;
    options.window()?.webContents.setBackgroundThrottling(!state.active);
    publish();
  });
  ipcMain.handle("desktop.voice.reveal", (event) => {
    if (!options.authorize(event)) return;
    const win = options.window();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  ipcMain.handle("desktop.voice.control", (event, command: unknown) => {
    if (
      !overlay ||
      event.sender !== overlay.webContents ||
      event.senderFrame !== overlay.webContents.mainFrame
    )
      return;
    if (command === "exit" || command === "mute") send(command);
  });
  return {
    reset() {
      state = { active: false, label: "", detail: "", muted: false };
      hide();
    },
    dispose() {
      if (registered) globalShortcut.unregister(VOICE_SHORTCUT);
      overlay?.close();
      for (const channel of ["connect", "update", "reveal", "control"])
        ipcMain.removeHandler(`desktop.voice.${channel}`);
    },
  };
}
