const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("voiceOverlay", {
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("desktop.voice.state", handler);
    return () => ipcRenderer.off("desktop.voice.state", handler);
  },
  control: (command) => {
    if (command === "exit" || command === "mute")
      return ipcRenderer.invoke("desktop.voice.control", command);
  },
});
