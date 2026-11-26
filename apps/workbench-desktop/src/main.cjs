const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } = require("electron");
const { resultNotifications } = require("./notifications.cjs");
const { fork, spawn } = require("node:child_process");
const { createSystemSpeech } = require("./system-speech.cjs");
const { mkdirSync, openSync, closeSync, writeFileSync, appendFileSync, existsSync } = require("node:fs");
const { join, isAbsolute } = require("node:path");

app.setName("LivingBot 2");
const smokeIndex = process.argv.indexOf("--smoke-root");
const smokeRoot = smokeIndex >= 0 ? process.argv[smokeIndex + 1] : undefined;
if (smokeIndex >= 0 && (!smokeRoot || !isAbsolute(smokeRoot))) app.exit(1);
const dataRoot = smokeRoot || app.getPath("userData");
app.setPath("userData", dataRoot);
let child;
let window;
let connection;
// Where http(s) links handed to the shell end up; the page picks, the shell acts.
let linkOpenMode = "system";
let stopping = false;
let stopped = false;
let backendExited;
let exitCode = 0;
const desktopNotices = resultNotifications({
  Notification, getWindow: () => window,
  openResult: (id) => window.webContents.send("livingbot:open-result", id),
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { window?.show(); window?.focus(); });
  app.on("activate", () => { window?.show(); window?.focus(); });
  app.on("before-quit", (event) => {
    if (stopped || !child) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    desktopNotices.close();
    // Release renderer subscriptions before waiting for the HTTP service.
    // Otherwise its reconnect loop can keep shutdown connections alive.
    if (window && !window.isDestroyed()) window.destroy();
    if (child.connected) child.send({ type: "stop" });
    else child.kill("SIGTERM");
    // Leave the kernel time to persist its queue and final writes.
    void backendExited.then(() => { stopped = true; app.exit(exitCode); });
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  void app.whenReady().then(start).catch((error) => {
    console.error(error);
    try {
      mkdirSync(join(dataRoot, "logs"), { recursive: true, mode: 0o700 });
      appendFileSync(join(dataRoot, "logs", "desktop-main.log"),
        `${new Date().toISOString()}\n${error instanceof Error ? error.stack : String(error)}\n`, { mode: 0o600 });
    } catch { /* stderr remains available when the data directory is unwritable. */ }
    if (!smokeRoot) dialog.showErrorBox("LivingBot 2", "启动失败，请查看应用资料目录中的日志。");
    exitCode = 1;
    if (!child) { app.exit(1); return; }
    app.quit();
  });
}

/**
 * Reading a link without leaving the app. The window carries no preload and keeps a session of
 * its own, so a page opened here never touches the app's state.
 */
function openLinkWindow(url) {
  const target = URL.parse(url);
  if (target?.protocol !== "https:" && target?.protocol !== "http:") return;
  const reader = new BrowserWindow({
    width: 1080, height: 820, title: target.host,
    webPreferences: {
      preload: "", contextIsolation: true, nodeIntegration: false, sandbox: true,
      partition: "persist:weblinks",
    },
  });
  reader.webContents.setWindowOpenHandler(({ url: next }) => {
    const parsed = URL.parse(next);
    if (parsed?.protocol === "https:" || parsed?.protocol === "http:") void shell.openExternal(next);
    return { action: "deny" };
  });
  void reader.loadURL(url);
}

function followLink(url) {
  if (linkOpenMode === "in-app") openLinkWindow(url);
  else void shell.openExternal(url);
}

async function start() {
  const resources = process.resourcesPath;
  const runtime = join(resources, "runtime");
  // A checked-out UI in the data directory wins over the bundled copy: editing the bundle
  // invalidates its signature, and re-signing resets the microphone and speech permissions
  // macOS granted to this app.
  const overrideWeb = join(dataRoot, "web");
  const web = existsSync(join(overrideWeb, "index.html")) ? overrideWeb : join(resources, "web");
  mkdirSync(join(dataRoot, "logs"), { recursive: true, mode: 0o700 });
  const output = openSync(join(dataRoot, "logs", "desktop-backend.log"), "a", 0o600);
  child = fork(join(runtime, "apps/workbench-desktop/src/backend.mjs"), [
    join(dataRoot, "data"), join(runtime, "node_modules/openclaw/openclaw.mjs"), web,
  ], {
    execPath: join(resources, "bin/node"),
    execArgv: [],
    stdio: ["ignore", output, output, "ipc"],
    env: { PATH: process.env.PATH, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR },
  });
  closeSync(output);
  backendExited = new Promise((resolve) => {
    child.once("exit", (code) => {
      resolve(code);
      if (!stopping) {
        connection = undefined;
        if (!smokeRoot) dialog.showErrorBox("LivingBot 2", "本机内核已退出，请重新打开应用。");
        exitCode = 1;
        stopped = true;
        app.exit(1);
      }
    });
  });
  const ready = await new Promise((resolve, reject) => {
    child.on("message", (message) => {
      if (message?.type === "result-notification" && !smokeRoot && !stopping) desktopNotices.receive(message);
      if (message?.type === "failed") reject(new Error("Backend startup failed"));
      if (message?.type !== "ready") return;
      try {
        const origin = new URL(message.origin);
        if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" ||
            typeof message.token !== "string" || message.token.length < 32) throw new Error("Invalid local service");
        resolve({ origin: origin.origin, token: message.token });
      } catch (error) { reject(error); }
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Backend exited")));
  });
  connection = ready;
  let smokeReceipt;
  let smokeNotification;
  if (smokeRoot) {
    const headers = { authorization: `Bearer ${ready.token}` };
    const snapshot = await fetch(`${ready.origin}/api/snapshot`, { headers }).then((result) => {
      if (!result.ok) throw new Error("Snapshot unavailable");
      return result.json();
    });
    const web = await fetch(ready.origin);
    const settings = await fetch(`${ready.origin}/api/model-settings`, { headers });
    if (!web.ok || !settings.ok || snapshot.kernel.phase !== "ready") throw new Error("Smoke acceptance failed");
    smokeReceipt = {
      kernel: snapshot.kernel.phase, bots: snapshot.bots.length, web: web.status,
      modelSettings: settings.status, electron: process.versions.electron,
      modelConfigured: (await settings.json()).configured,
    };
    smokeNotification = snapshot.notifications.find((notice) => notice.outcome === "completed");
  }
  function requireOwnedFrame(event) {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        new URL(event.senderFrame.url).origin !== ready.origin || !connection) throw new Error("Connection unavailable");
  }
  ipcMain.handle("livingbot:connect", (event) => {
    requireOwnedFrame(event);
    return connection;
  });
  // Window controls act only on this window and only for the frame that owns it.
  ipcMain.handle("desktop.window.close", (event) => { requireOwnedFrame(event); window?.close(); });
  ipcMain.handle("desktop.window.minimize", (event) => { requireOwnedFrame(event); window?.minimize(); });
  ipcMain.handle("desktop.window.toggleMaximize", (event) => {
    requireOwnedFrame(event);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize(); else window.maximize();
  });
  ipcMain.handle("desktop.window.state", (event) => {
    requireOwnedFrame(event);
    return {
      maximized: window?.isMaximized() ?? false,
      fullScreen: window?.isFullScreen() ?? false,
      minimized: window?.isMinimized() ?? false,
    };
  });
  // Links and startup are shell decisions, so the page can only ask for them here.
  ipcMain.handle("desktop.links.setMode", (event, mode) => {
    requireOwnedFrame(event);
    if (mode === "system" || mode === "in-app") linkOpenMode = mode;
  });
  ipcMain.handle("desktop.system.loginItem", (event) => {
    requireOwnedFrame(event);
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle("desktop.system.setLoginItem", (event, enabled) => {
    requireOwnedFrame(event);
    app.setLoginItemSettings({ openAtLogin: enabled === true });
    // The system reports what it actually registered, which is what the switch should show.
    return app.getLoginItemSettings().openAtLogin;
  });
  if (process.platform === "darwin") {
    const speech = createSystemSpeech(
      () => window && !window.isDestroyed() ? { webContents: window.webContents, url: ready.origin } : null,
      (language) => spawn(join(resources, "speech", "rakazo-speech"), [language], { stdio: "pipe" }),
    );
    ipcMain.handle("desktop.speech.start", (event, language, session) => speech.start(event, language, session));
    ipcMain.handle("desktop.speech.stop", (event, session) => speech.stop(event, session));
    ipcMain.handle("desktop.speech.abort", (event, session) => speech.abort(event, session));
  }
  ipcMain.handle("livingbot:choose-migration-bundle", async (event) => {
    requireOwnedFrame(event);
    const result = await dialog.showOpenDialog(window, {
      title: "选择伙伴迁移清单", properties: ["openFile"],
      filters: [{ name: "LivingBot 迁移清单", extensions: ["json"] }],
    });
    requireOwnedFrame(event);
    return result.canceled ? undefined : result.filePaths[0];
  });
  const mac = process.platform === "darwin";
  // The operating system owns Cmd+, and Cmd+W/Cmd+M, so the menu is what tells the
  // page to open Settings; the renderer never sees those keystrokes.
  const sendCommand = (command) => {
    if (window && !window.isDestroyed()) window.webContents.send(`livingbot:menu-${command}`);
  };
  const template = [
    ...(mac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" }, { type: "separator" },
            { label: "设置…", accelerator: "CmdOrCtrl+,", click: () => sendCommand("settings") },
            { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
            { type: "separator" }, { role: "quit" },
          ],
        }]
      : []),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    // A non-macOS window has no application menu of its own; keep the item reachable.
    ...(mac ? [] : [{
      label: "窗口",
      submenu: [
        { label: "设置…", accelerator: "CmdOrCtrl+,", click: () => sendCommand("settings") },
        { type: "separator" }, { role: "minimize" }, { role: "close" },
      ],
    }]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  window = new BrowserWindow({
    width: 1280, height: 860, minWidth: 700, minHeight: 500, show: false, title: "LivingBot 2",
    // The frontend draws its own title row, so the traffic lights sit inside it.
    ...(mac ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"), contextIsolation: true,
      sandbox: true, nodeIntegration: false,
    },
  });
  // Reuse the 1.0 macOS close-to-hide behavior: routines and the kernel keep
  // running; Dock activation restores the existing frontend. Explicit Quit
  // still follows the normal durable backend shutdown above.
  window.on("close", (event) => {
    if (process.platform === "darwin" && !stopping && !smokeRoot) {
      event.preventDefault();
      window.hide();
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const target = URL.parse(url);
    if (target?.protocol === "https:" || target?.protocol === "http:") followLink(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== ready.origin) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === window.webContents && permission === "media" &&
      details.mediaTypes?.every((type) => type === "audio") === true &&
      new URL(contents.getURL()).origin === ready.origin);
  });
  if (!smokeRoot) window.once("ready-to-show", () => window.show());
  await window.loadURL(ready.origin);
  if (smokeRoot) {
    const renderer = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error("Renderer connection deadline exceeded")); }, 30000);
      function check() {
        if (!document.querySelector('[data-testid="shell-root"][data-ready="true"]')) return;
        observer.disconnect(); clearTimeout(timer);
        resolve({ connected: true, selectedFrontend: true,
          preload: typeof window.livingbotDesktop?.connect === "function",
          legacyBridge: typeof window.rakazoDesktop?.window?.minimize === "function",
          nativeSpeech: typeof window.rakazoDesktop?.speech?.start === "function" &&
            typeof window.rakazoDesktop?.speech?.onEvent === "function",
          nativeWindowFrame: window.rakazoDesktop?.nativeWindowFrame,
          migrationPicker: typeof window.livingbotDesktop?.chooseMigrationBundle === "function",
          resultNotifications: typeof window.livingbotDesktop?.onOpenResult === "function" });
      }
      observer.observe(document.documentElement, { childList: true, subtree: true }); check();
    })`);
    if (!renderer.preload || !renderer.legacyBridge || !renderer.nativeSpeech ||
        !renderer.migrationPicker || !renderer.resultNotifications || window.isVisible()) {
      throw new Error("Hidden renderer acceptance failed");
    }
    if (smokeNotification) {
      // Exercise the real main/preload/renderer route against a retained result.
      // Smoke mode never displays an operating-system alert.
      window.webContents.send("livingbot:open-result", smokeNotification.id);
      renderer.resultTarget = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const messageId = ${JSON.stringify(smokeNotification.messageId)};
        const observer = new MutationObserver(check);
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Result navigation deadline exceeded"));
        }, 10000);
        function cleanup() { observer.disconnect(); clearTimeout(timer); }
        function check() {
          const target = [...document.querySelectorAll("[data-message-id]")]
            .find(node => node.dataset.messageId === messageId);
          if (!target) return;
          cleanup(); resolve(true);
        }
        observer.observe(document.documentElement, { childList: true, subtree: true });
        check();
      })`);
    }
    writeFileSync(join(dataRoot, "desktop-smoke.json"), JSON.stringify({
      ...smokeReceipt, renderer, windowVisible: window.isVisible(),
    }, null, 2), { mode: 0o600 });
    app.quit();
  }
}
