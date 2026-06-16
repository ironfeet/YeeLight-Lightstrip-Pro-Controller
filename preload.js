/**
 * preload.js — contextBridge
 * Exposes a minimal, safe API surface to the renderer process.
 * No raw Node.js APIs are exposed.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Config
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // Mode 1: Screen capture
  captureScreen: () => ipcRenderer.invoke('capture-screen'),

  // Mode 2: Antigravity AI agent status
  getAgentStatus: () => ipcRenderer.invoke('get-agent-status'),

  // Mode 3: Antigravity IDE status
  getIDEStatus: () => ipcRenderer.invoke('get-ide-status'),

  // Window & Tray controls
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),
  updateTray: (dataURL) => ipcRenderer.send('update-tray', dataURL),
  updateModeState: (mode) => ipcRenderer.send('update-mode-state', mode),
  onSetMode: (callback) => {
    // Purge stale listeners before registering to prevent duplicates on page reload.
    ipcRenderer.removeAllListeners('set-mode');
    ipcRenderer.on('set-mode', callback);
  },
  offSetMode: () => ipcRenderer.removeAllListeners('set-mode'),
});
