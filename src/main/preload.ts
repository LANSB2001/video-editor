import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopApi, ExportProgress } from '../shared/api';

const api: DesktopApi = {
  platform: process.platform,
  openMedia: () => ipcRenderer.invoke('media:open'),
  probeFiles: (files) => ipcRenderer.invoke('media:probe', files.map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  mediaUrl: (path) => `media://local/${encodeURIComponent(path)}`,
  openProject: () => ipcRenderer.invoke('project:open'),
  saveProject: (project, path) => ipcRenderer.invoke('project:save', project, path),
  autosave: (project) => ipcRenderer.invoke('project:autosave', project),
  recoverAutosave: () => ipcRenderer.invoke('project:recover'),
  startExport: (req) => ipcRenderer.invoke('export:start', req),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb) => {
    const h = (_: unknown, p: ExportProgress) => cb(p);
    ipcRenderer.on('export:progress', h);
    return () => ipcRenderer.off('export:progress', h);
  },
  revealFile: (path) => ipcRenderer.invoke('shell:reveal', path),
  runAi: (req) => ipcRenderer.invoke('ai:run', req),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setApiKey: (key) => ipcRenderer.invoke('settings:setApiKey', key),
  onMenu: (cb) => {
    const h = (_: unknown, action: string) => cb(action);
    ipcRenderer.on('menu', h);
    return () => ipcRenderer.off('menu', h);
  },
};

contextBridge.exposeInMainWorld('api', api);
