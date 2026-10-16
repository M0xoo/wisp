// Minimal bridge for desktop-only niceties. Sandboxed preloads must be CommonJS.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wispDesktop', {
  pickFolder: () => ipcRenderer.invoke('wisp:pick-folder'),
});
