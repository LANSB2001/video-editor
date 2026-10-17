// Access to desktop features. In Electron this is window.api (see preload.ts).
// In a plain browser (npm run dev:web) a limited fallback is used so the editor
// can still be tried: import, edit, preview and save work; export needs the app.

import { normalizeProject, uid, type MediaAsset, type Project } from '../engine';
import type { DesktopApi } from '../shared/api';

declare global {
  interface Window {
    api?: DesktopApi;
  }
}

export const isDesktop = !!window.api;

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.click();
  });
}

function probeInBrowser(file: File): Promise<MediaAsset> {
  const url = URL.createObjectURL(file);
  const base = { id: uid('media'), name: file.name, path: url, hasAudio: false, duration: 0, width: 0, height: 0 };
  if (file.type.startsWith('image/')) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ ...base, kind: 'image', width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error(`Cannot read ${file.name}`));
      img.src = url;
    });
  }
  const isAudio = file.type.startsWith('audio/');
  return new Promise((resolve, reject) => {
    const el = document.createElement(isAudio ? 'audio' : 'video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      const v = el as HTMLVideoElement;
      resolve({ ...base, kind: isAudio ? 'audio' : 'video', duration: el.duration, width: v.videoWidth ?? 0, height: v.videoHeight ?? 0, hasAudio: true });
    };
    el.onerror = () => reject(new Error(`Cannot read ${file.name}`));
    el.src = url;
  });
}

const browserApi: DesktopApi = {
  platform: 'web',
  async openMedia() {
    const files = await pickFiles('video/*,image/*,audio/*', true);
    return this.probeFiles(files);
  },
  async probeFiles(files) {
    const r = await Promise.allSettled(files.map(probeInBrowser));
    return r.flatMap((x) => (x.status === 'fulfilled' ? [x.value] : []));
  },
  mediaUrl: (path) => path,
  async openProject() {
    const [file] = await pickFiles('.oneproj,application/json', false);
    if (!file) return null;
    return { project: normalizeProject(JSON.parse(await file.text())), path: file.name };
  },
  async saveProject(project: Project) {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${project.name || 'project'}.oneproj`;
    a.click();
    return a.download;
  },
  async autosave(project) {
    try { localStorage.setItem('one.autosave', JSON.stringify(project)); } catch { /* storage unavailable */ }
  },
  async recoverAutosave() {
    try {
      const raw = localStorage.getItem('one.autosave');
      // Blob URLs from a previous browser session are dead; only text/shape layers survive.
      return raw ? normalizeProject(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  },
  async startExport() {
    throw new Error('Video export needs the desktop app (npm start).');
  },
  async cancelExport() {},
  onExportProgress: () => () => {},
  async revealFile() {},
  async runAi() {
    throw new Error('NO_API_KEY');
  },
  async getSettings() {
    return { hasApiKey: false, model: '' };
  },
  async setApiKey() {
    throw new Error('Claude needs the desktop app.');
  },
  onMenu: () => () => {},
};

export const api: DesktopApi = window.api ?? browserApi;
