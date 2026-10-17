import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeProject, type Project } from '../engine';
import type { AiRequest, ExportRequest } from '../shared/api';
import { runAi } from './ai';
import { ExportJob } from './exporter';
import { MEDIA_EXTENSIONS, probe, serveMedia } from './media';
import { getApiKey, getSettings, setApiKey } from './settings';

const PROJECT_EXT = 'oneproj';

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
]);

let win: BrowserWindow | null = null;
let job: ExportJob | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#14151a',
    title: 'One Platform Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('closed', () => (win = null));
}

function sendMenu(action: string) {
  win?.webContents.send('menu', action);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' as const }] : []),
      {
        label: 'File',
        submenu: [
          { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new') },
          { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
          { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
          { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenu('saveAs') },
          { type: 'separator' },
          { label: 'Import Media…', accelerator: 'CmdOrCtrl+I', click: () => sendMenu('import') },
          { label: 'Export Video…', accelerator: 'CmdOrCtrl+E', click: () => sendMenu('export') },
          { type: 'separator' },
          isMac ? { role: 'close' } : { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        // Undo/redo are handled by the editor (not the text-field roles) so they
        // work on the timeline and canvas.
        submenu: [
          { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendMenu('undo') },
          { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => sendMenu('redo') },
          { type: 'separator' },
          { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        ],
      },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    ]),
  );
}

const autosaveFile = () => path.join(app.getPath('userData'), 'autosave.oneproj');

function registerIpc() {
  ipcMain.handle('media:open', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Media', extensions: MEDIA_EXTENSIONS }],
    });
    if (r.canceled) return [];
    return probeAll(r.filePaths);
  });

  ipcMain.handle('media:probe', (_e, paths: string[]) => probeAll(paths));

  ipcMain.handle('project:open', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Open project',
      properties: ['openFile'],
      filters: [{ name: 'One Platform project', extensions: [PROJECT_EXT] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    const project = normalizeProject(JSON.parse(await fs.readFile(file, 'utf8')));
    return { project, path: file };
  });

  ipcMain.handle('project:save', async (_e, project: Project, file?: string) => {
    let target = file;
    if (!target) {
      const r = await dialog.showSaveDialog(win!, {
        title: 'Save project',
        defaultPath: `${project.name || 'Untitled'}.${PROJECT_EXT}`,
        filters: [{ name: 'One Platform project', extensions: [PROJECT_EXT] }],
      });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    // Write-then-rename so a crash mid-save never corrupts the project.
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(project, null, 2));
    await fs.rename(tmp, target);
    return target;
  });

  ipcMain.handle('project:autosave', async (_e, project: Project) => {
    await fs.writeFile(autosaveFile(), JSON.stringify(project));
  });

  ipcMain.handle('project:recover', async () => {
    try {
      return normalizeProject(JSON.parse(await fs.readFile(autosaveFile(), 'utf8')));
    } catch {
      return null;
    }
  });

  ipcMain.handle('export:start', async (_e, req: ExportRequest) => {
    if (job) throw new Error('An export is already running');
    const r = await dialog.showSaveDialog(win!, {
      title: 'Export video',
      defaultPath: `${req.project.name || 'video'}.mp4`,
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const output = r.filePath;
    job = new ExportJob((p) => win?.webContents.send('export:progress', p));
    job.run(req.project, req.rasters, output, req.quality).finally(() => (job = null));
    return output;
  });

  ipcMain.handle('export:cancel', () => job?.cancel());
  ipcMain.handle('shell:reveal', (_e, file: string) => shell.showItemInFolder(file));

  ipcMain.handle('ai:run', async (_e, req: AiRequest) => {
    const key = await getApiKey();
    if (!key) throw new Error('NO_API_KEY');
    const { model } = await getSettings();
    return runAi(key, model, req);
  });
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:setApiKey', (_e, key: string) => setApiKey(key));
}

async function probeAll(paths: string[]) {
  const results = await Promise.allSettled(paths.map(probe));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length && win) {
    dialog.showMessageBox(win, {
      type: 'warning',
      message: `${failed.length} file(s) could not be imported`,
      detail: failed.map((f) => (f as PromiseRejectedResult).reason?.message).join('\n').slice(0, 1000),
    });
  }
  return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

app.whenReady().then(() => {
  protocol.handle('media', serveMedia);
  registerIpc();
  buildMenu();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  job?.cancel();
  if (process.platform !== 'darwin') app.quit();
});
