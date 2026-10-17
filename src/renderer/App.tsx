import { useEffect, useState } from 'react';
import { ASPECT_PRESETS, createProject, findClip, needsRaster, type Project } from '../engine';
import type { ExportProgress } from '../shared/api';
import { Inspector } from './components/Inspector';
import { Preview } from './components/Preview';
import { importMedia, Sidebar } from './components/Sidebar';
import { Timeline } from './components/Timeline';
import { api, isDesktop } from './platform';
import { rasterizeClip } from './render';
import { useEditor } from './store';

async function save(as = false) {
  const s = useEditor.getState();
  try {
    const path = await api.saveProject(s.project, as ? undefined : s.filePath ?? undefined);
    if (path) {
      s.markSaved(path);
      s.toast('Project saved');
    }
  } catch (e) {
    s.toast(`Save failed: ${(e as Error).message}`, 'error');
  }
}

async function open() {
  const s = useEditor.getState();
  if (s.dirty && !confirm('Discard unsaved changes?')) return;
  try {
    const r = await api.openProject();
    if (r) s.load(r.project, r.path);
  } catch (e) {
    s.toast(`Could not open: ${(e as Error).message}`, 'error');
  }
}

function newProject(preset = 'landscape') {
  const s = useEditor.getState();
  if (s.dirty && !confirm('Discard unsaved changes?')) return;
  const p = ASPECT_PRESETS[preset];
  s.load(createProject('Untitled project', { width: p.width, height: p.height }));
}

export function App() {
  const project = useEditor((s) => s.project);
  const dirty = useEditor((s) => s.dirty);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const toasts = useEditor((s) => s.toasts);
  const { dispatch, undo, redo, beginGesture } = useEditor.getState();
  const [exporting, setExporting] = useState(false);
  const [recovery, setRecovery] = useState<Project | null>(null);

  // Offer to restore the last autosave.
  useEffect(() => {
    api.recoverAutosave().then((p) => p && p.tracks.length > 0 && setRecovery(p));
  }, []);

  // Autosave every 30 s while there are unsaved changes.
  useEffect(() => {
    const id = setInterval(() => {
      const s = useEditor.getState();
      if (s.dirty) api.autosave(s.project).catch(() => {});
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  // Window title.
  useEffect(() => {
    document.title = `${dirty ? '● ' : ''}${project.name} — One Platform Studio`;
  }, [project.name, dirty]);

  // Menu (desktop) + keyboard shortcuts.
  useEffect(() => {
    const run = (action: string) => {
      const s = useEditor.getState();
      switch (action) {
        case 'new': return newProject();
        case 'open': return open();
        case 'save': return save();
        case 'saveAs': return save(true);
        case 'import': return importMedia();
        case 'export': return setExporting(true);
        case 'undo': return s.undo();
        case 'redo': return s.redo();
      }
    };
    const off = api.onMenu(run);
    const onKey = (e: KeyboardEvent) => {
      const s = useEditor.getState();
      const typing = (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]');
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !isDesktop) {
        // In the desktop app these come from the menu accelerators.
        const k = e.key.toLowerCase();
        if (k === 's') { e.preventDefault(); return run(e.shiftKey ? 'saveAs' : 'save'); }
        if (k === 'o') { e.preventDefault(); return run('open'); }
        if (k === 'e') { e.preventDefault(); return run('export'); }
        if (k === 'z' && !typing) { e.preventDefault(); return run(e.shiftKey ? 'redo' : 'undo'); }
      }
      if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); return s.redo(); }
      if (typing) return;
      const sel = s.selectedId ? findClip(s.project, s.selectedId) : undefined;
      if (e.key === ' ') { e.preventDefault(); s.setPlaying(!s.playing); }
      else if (e.key === 'Home') s.setTime(0);
      else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) s.dispatch({ type: 'deleteClip', clipId: sel.clip.id });
      else if (e.key.toLowerCase() === 's' && !mod && sel) s.dispatch({ type: 'splitClip', clipId: sel.clip.id, at: s.time });
      else if (mod && e.key.toLowerCase() === 'd' && sel) { e.preventDefault(); s.dispatch({ type: 'duplicateClip', clipId: sel.clip.id }); }
      else if (e.key === 'Escape') s.select(null);
      else if (e.key.startsWith('Arrow') && sel && sel.clip.type !== 'audio') {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const t = sel.clip.transform;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        s.dispatch({ type: 'updateTransform', clipId: sel.clip.id, transform: { x: t.x + dx, y: t.y + dy } });
      } else if (e.key === ',' || e.key === '.') {
        s.setTime(s.time + (e.key === '.' ? 1 : -1) / s.project.settings.fps);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { off(); window.removeEventListener('keydown', onKey); };
  }, []);

  // Drop files from Explorer anywhere on the window.
  useEffect(() => {
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    const drop = async (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      const assets = await api.probeFiles([...e.dataTransfer.files]);
      useEditor.getState().addMedia(assets);
      if (assets.length) useEditor.getState().toast(`Imported ${assets.length} file(s)`);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }, []);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand"><span className="logo">◆</span> One Platform <em>Studio</em></div>
        <div className="menu-buttons">
          <button onClick={() => newProject()}>New</button>
          <button onClick={open}>Open</button>
          <button onClick={() => save()}>Save</button>
          <button onClick={importMedia}>Import</button>
        </div>
        <span className="sep" />
        <button className="icon" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">↶</button>
        <button className="icon" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">↷</button>
        <input
          className="project-name"
          value={project.name}
          onFocus={beginGesture}
          onChange={(e) => dispatch({ type: 'rename', name: e.target.value }, { merge: true })}
        />
        <span className="grow" />
        {!isDesktop && <span className="badge-web" title="Run the desktop app to export videos">Browser preview</span>}
        <button className="primary" onClick={() => setExporting(true)}>⬇ Export video</button>
      </header>

      <main className="workspace">
        <Sidebar />
        <Preview />
        <Inspector />
      </main>
      <Timeline />

      {exporting && <ExportDialog onClose={() => setExporting(false)} />}

      {recovery && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>Restore unsaved work?</h2>
            <p>One Platform found an autosaved project “{recovery.name}”.</p>
            <div className="modal-actions">
              <button onClick={() => setRecovery(null)}>Discard</button>
              <button className="primary" onClick={() => { useEditor.getState().load(recovery); setRecovery(null); }}>Restore</button>
            </div>
          </div>
        </div>
      )}

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </div>
  );
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const [quality, setQuality] = useState<'draft' | 'standard' | 'high'>('standard');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const placeholders = project.tracks.flatMap((t) => t.clips).filter((c) => c.placeholder).length;

  useEffect(() => api.onExportProgress(setProgress), []);

  async function start() {
    try {
      // Rasterise text and shape layers with the same code that draws the preview.
      const rasters: Record<string, string> = {};
      for (const t of project.tracks) {
        if (t.hidden) continue;
        for (const c of t.clips) if (needsRaster(c)) rasters[c.id] = rasterizeClip(c);
      }
      const out = await api.startExport({ project, rasters, quality });
      if (out) setProgress({ state: 'running', progress: 0, output: out });
    } catch (e) {
      setProgress({ state: 'error', progress: 0, message: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
    }
  }

  const running = progress?.state === 'running';
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Export video</h2>
        <p className="muted">MP4 (H.264 + AAC) · {project.settings.width}×{project.settings.height} · {project.settings.fps} fps</p>
        {placeholders > 0 && <p className="warn">{placeholders} template slot(s) are still empty and will export as plain boxes.</p>}
        <label className="field">
          <span>Quality</span>
          <select value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)} disabled={running}>
            <option value="draft">Draft — fast, smaller file</option>
            <option value="standard">Standard</option>
            <option value="high">High — slower, best quality</option>
          </select>
        </label>
        {progress && (
          <div className="export-status">
            {running && <div className="progress"><div style={{ width: `${Math.round(progress.progress * 100)}%` }} /></div>}
            {running && <p>{Math.round(progress.progress * 100)}% rendered…</p>}
            {progress.state === 'done' && <p className="ok">✓ Exported to {progress.output}</p>}
            {progress.state === 'cancelled' && <p>Export cancelled.</p>}
            {progress.state === 'error' && <pre className="error">{progress.message}</pre>}
          </div>
        )}
        <div className="modal-actions">
          {running ? (
            <button className="danger" onClick={() => api.cancelExport()}>Cancel export</button>
          ) : (
            <>
              <button onClick={onClose}>Close</button>
              {progress?.state === 'done' && progress.output && isDesktop && (
                <button onClick={() => api.revealFile(progress.output!)}>Show in folder</button>
              )}
              <button className="primary" onClick={start}>{progress?.state === 'done' ? 'Export again' : 'Export'}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
