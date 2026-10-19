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

export type ObjectAction = 'remove' | 'cutout' | 'blur' | 'pixelate';

export interface VisionBegin {
  path: string;
  name: string;
  /** Source dimensions and frame rate. */
  width: number;
  height: number;
  fps: number;
  /** Source seconds. */
  srcStart: number;
  srcEnd: number;
}

export interface VisionInfo {
  sessionId: string;
  /** Size of masks returned by select / maskAt. */
  width: number;
  height: number;
  frameCount: number;
  fps: number;
}

export interface VisionSelection {
  mask: Uint8Array;
  width: number;
  height: number;
  area: number;
  score: number;
}

export interface VisionProgress {
  stage: 'prepare' | 'track' | 'fill' | 'render';
  done: number;
  total: number;
}

export interface DesktopApi {
  platform: string;
  openMedia(): Promise<MediaAsset[]>;
  probeFiles(files: File[]): Promise<MediaAsset[]>;
  mediaUrl(path: string): string;
  /** Source times where the video cuts to a new screen (desktop only). */
  detectScenes?(path: string): Promise<number[]>;
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
  vision?: {
    begin(req: VisionBegin): Promise<VisionInfo>;
    /** points are in mask pixels; label 1 = object, 0 = not the object. */
    select(sessionId: string, sourceTime: number, points: { x: number; y: number; label: 0 | 1 }[]): Promise<VisionSelection>;
    track(sessionId: string): Promise<{ first: number; last: number; frameCount: number }>;
    maskAt(sessionId: string, sourceTime: number): Promise<Uint8Array | null>;
    apply(sessionId: string, action: ObjectAction): Promise<MediaAsset>;
    cancel(sessionId: string): Promise<void>;
    end(sessionId: string): Promise<void>;
    onProgress(cb: (p: VisionProgress) => void): () => void;
  };
}
