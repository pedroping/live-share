const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liveShare', {
  listSources: () => ipcRenderer.invoke('sources:list'),
  selectSource: (id) => ipcRenderer.invoke('sources:select', id),
  listApps: () => ipcRenderer.invoke('apps:list'),
  isDiscordRunning: () => ipcRenderer.invoke('discord:status'),
  setAudioMode: (mode) => ipcRenderer.invoke('audio:set-mode', mode),
  onAudioData: (cb) => ipcRenderer.on('audio:data', (_e, data) => cb(data)),
  onAudioStatus: (cb) => ipcRenderer.on('audio:status', (_e, status) => cb(status)),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
});
