import { create } from 'zustand';
import {
  applyCommands,
  createProject,
  History,
  projectDuration,
  type EditCommand,
  type MediaAsset,
  type Project,
} from '../engine';

const history = new History();

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

interface EditorState {
  project: Project;
  filePath: string | null;
  dirty: boolean;
  selectedId: string | null;
  time: number;
  playing: boolean;
  zoom: number; // timeline pixels per second
  canUndo: boolean;
  canRedo: boolean;
  toasts: Toast[];

  /** Apply one or more edits as a single undo step. Returns false on error. */
  dispatch: (cmds: EditCommand | EditCommand[], opts?: { merge?: boolean }) => boolean;
  /** Start a gesture (drag/resize): later dispatches with merge:true fold into one undo step. */
  beginGesture: () => void;
  undo: () => void;
  redo: () => void;
  load: (project: Project, filePath?: string | null) => void;
  markSaved: (filePath: string) => void;
  select: (id: string | null) => void;
  setTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setZoom: (z: number) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  addMedia: (assets: MediaAsset[]) => void;
}

let toastId = 0;
let gestureOpen = false;

export const useEditor = create<EditorState>((set, get) => ({
  project: createProject(),
  filePath: null,
  dirty: false,
  selectedId: null,
  time: 0,
  playing: false,
  zoom: 80,
  canUndo: false,
  canRedo: false,
  toasts: [],

  dispatch: (cmds, opts) => {
    const list = Array.isArray(cmds) ? cmds : [cmds];
    if (!list.length) return true;
    const prev = get().project;
    try {
      const next = applyCommands(prev, list);
      // A merged dispatch only records history on the first step of a gesture.
      if (!opts?.merge || gestureOpen) history.push(prev);
      gestureOpen = false;
      const sel = get().selectedId;
      const stillThere = sel && next.tracks.some((t) => t.clips.some((c) => c.id === sel));
      set({
        project: next,
        dirty: true,
        canUndo: history.canUndo,
        canRedo: history.canRedo,
        selectedId: stillThere ? sel : null,
        time: Math.min(get().time, Math.max(projectDuration(next), 0)),
      });
      return true;
    } catch (e) {
      get().toast((e as Error).message, 'error');
      return false;
    }
  },

  beginGesture: () => {
    gestureOpen = true;
  },

  undo: () => {
    const prev = history.undo(get().project);
    if (prev) set({ project: prev, dirty: true, canUndo: history.canUndo, canRedo: history.canRedo });
  },

  redo: () => {
    const next = history.redo(get().project);
    if (next) set({ project: next, dirty: true, canUndo: history.canUndo, canRedo: history.canRedo });
  },

  load: (project, filePath = null) => {
    history.clear();
    set({ project, filePath, dirty: false, selectedId: null, time: 0, playing: false, canUndo: false, canRedo: false });
  },

  markSaved: (filePath) => set({ filePath, dirty: false }),
  select: (id) => set({ selectedId: id }),
  setTime: (t) => set({ time: Math.max(0, t) }),
  setPlaying: (playing) => set({ playing }),
  setZoom: (zoom) => set({ zoom: Math.min(400, Math.max(10, zoom)) }),

  toast: (text, kind = 'info') => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 6000 : 3000);
  },

  addMedia: (assets) => {
    if (!assets.length) return;
    get().dispatch(assets.map((asset) => ({ type: 'addMedia', asset }) as EditCommand));
  },
}));
