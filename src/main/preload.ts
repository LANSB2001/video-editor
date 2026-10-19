import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopApi, ExportProgress, VisionProgress } from '../shared/api';

const api: DesktopApi = {
  platform: process.platform,
  openMedia: () => ipcRenderer.invoke('media:open'),
  probeFiles: (files) => ipcRenderer.invoke('media:probe', files.map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  mediaUrl: (path) => `media://local/${encodeURIComponent(path)}`,
  detectScenes: (path) => ipcRenderer.invoke('media:scenes', path),
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
  vision: {
    begin: (req) => ipcRenderer.invoke('vision:begin', req),
    select: (id, t, points) => ipcRenderer.invoke('vision:select', id, t, points),
    track: (id) => ipcRenderer.invoke('vision:track', id),
    maskAt: (id, t) => ipcRenderer.invoke('vision:maskAt', id, t),
    apply: (id, action) => ipcRenderer.invoke('vision:apply', id, action),
    cancel: (id) => ipcRenderer.invoke('vision:cancel', id),
    end: (id) => ipcRenderer.invoke('vision:end', id),
    onProgress: (cb) => {
      const h = (_: unknown, p: VisionProgress) => cb(p);
      ipcRenderer.on('vision:progress', h);
      return () => ipcRenderer.off('vision:progress', h);
    },
  },
};

contextBridge.exposeInMainWorld('api', api);
