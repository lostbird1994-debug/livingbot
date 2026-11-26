const { contextBridge, ipcRenderer } = require("electron");

/**
 * One bridge object shared by both world names. The selected frontend reads
 * `rakazoDesktop`; the connection helpers use `livingbotDesktop`. Duplicating the
 * object would let the two drift, so both names expose this same frozen value.
 */
const bridge = Object.freeze({
  platform: process.platform,
  /** Windows draws its own frame, so the frontend leaves room instead of adding buttons. */
  nativeWindowFrame: process.platform === "win32",
  connect: () => ipcRenderer.invoke("livingbot:connect"),
  chooseMigrationBundle: () => ipcRenderer.invoke("livingbot:choose-migration-bundle"),
  onOpenResult: (open) => {
    const listener = (_event, id) => open(id);
    ipcRenderer.on("livingbot:open-result", listener);
    return () => ipcRenderer.removeListener("livingbot:open-result", listener);
  },
  window: {
    close: () => ipcRenderer.invoke("desktop.window.close"),
    minimize: () => ipcRenderer.invoke("desktop.window.minimize"),
    toggleMaximize: () => ipcRenderer.invoke("desktop.window.toggleMaximize"),
    state: () => ipcRenderer.invoke("desktop.window.state"),
  },
  speech: {
    start: (language, session) => ipcRenderer.invoke("desktop.speech.start", language, session),
    stop: (session) => ipcRenderer.invoke("desktop.speech.stop", session),
    abort: (session) => ipcRenderer.invoke("desktop.speech.abort", session),
    onEvent: (listener) => {
      const handler = (_event, value) => listener(value);
      ipcRenderer.on("desktop.speech.event", handler);
      return () => ipcRenderer.removeListener("desktop.speech.event", handler);
    },
  },
  /** The app menu's Settings… item; Cmd+, is claimed by the OS, not the page. */
  settings: {
    onOpen: (open) => {
      const listener = () => open();
      ipcRenderer.on("livingbot:menu-settings", listener);
      return () => ipcRenderer.removeListener("livingbot:menu-settings", listener);
    },
  },
  /** Where a link the page hands over goes, and whether the app starts with the computer. */
  links: {
    setMode: (mode) => ipcRenderer.invoke("desktop.links.setMode", mode),
  },
  system: {
    loginItem: () => ipcRenderer.invoke("desktop.system.loginItem"),
    setLoginItem: (enabled) => ipcRenderer.invoke("desktop.system.setLoginItem", enabled),
  },
});

contextBridge.exposeInMainWorld("livingbotDesktop", bridge);
contextBridge.exposeInMainWorld("rakazoDesktop", bridge);
