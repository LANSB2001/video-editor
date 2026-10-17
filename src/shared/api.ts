// Contract between the Electron main process and the renderer (window.api).
import type { AiAction, MediaAsset, Project } from '../engine';

export interface ExportRequest {
  project: Project;
  /** clipId → PNG as base64 (no data: prefix). */
  rasters: Record<string, string>;
  quality: 'draft' | 'standard' | 'high';
}

export interface ExportProgress {
  state: 'running' | 'done' | 'error' | 'cancelled';
  /** 0..1 */
  progress: number;
  output?: string;
  message?: string;
}

export interface AiRequest {
  instruction: string;
  context: unknown;
}

export interface AiResponse {
  actions: AiAction[];
  reply: string;
}

export interface Settings {
  hasApiKey: boolean;
  model: string;
}

export interface DesktopApi {
  platform: string;
  openMedia(): Promise<MediaAsset[]>;
  probeFiles(files: File[]): Promise<MediaAsset[]>;
  mediaUrl(path: string): string;
  openProject(): Promise<{ project: Project; path: string } | null>;
  saveProject(project: Project, path?: string): Promise<string | null>;
  autosave(project: Project): Promise<void>;
  recoverAutosave(): Promise<Project | null>;
  startExport(req: ExportRequest): Promise<string | null>;
  cancelExport(): Promise<void>;
  onExportProgress(cb: (p: ExportProgress) => void): () => void;
  revealFile(path: string): Promise<void>;
  runAi(req: AiRequest): Promise<AiResponse>;
  getSettings(): Promise<Settings>;
  setApiKey(key: string): Promise<Settings>;
  onMenu(cb: (action: string) => void): () => void;
}
