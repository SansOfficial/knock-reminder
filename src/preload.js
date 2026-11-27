const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  test: (reminder) => ipcRenderer.invoke('reminder:test', reminder),
  pickCharacter: () => ipcRenderer.invoke('character:pick'),
  removeCharacter: (id) => ipcRenderer.invoke('character:remove', id),
  onConfigChanged: (cb) => ipcRenderer.on('config:changed', (_e, cfg) => cb(cfg)),

  overlayData: () => ipcRenderer.invoke('overlay:data'),
  overlayReady: () => ipcRenderer.send('overlay:ready'),
  done: () => ipcRenderer.send('overlay:done'),
  snooze: () => ipcRenderer.send('overlay:snooze'),
});
