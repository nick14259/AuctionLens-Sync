// The only bridge between the window and the app: a handful of named calls, nothing else
// of Node or Electron reaches the page (contextIsolation + sandbox).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("alensBridge", {
    call: (method, args) => ipcRenderer.invoke("alens:call", method, Array.isArray(args) ? args : []),
    browse: (initial) => ipcRenderer.invoke("alens:browse", initial || ""),
    onSnapshot: (fn) => {
        ipcRenderer.on("alens:snapshot", (_e, snap) => fn(snap));
    },
    window: (action) => ipcRenderer.send("alens:window", action),
    copy: (text) => ipcRenderer.send("alens:copy", String(text)),
    ready: (info) => ipcRenderer.send("alens:ready", info),
});
