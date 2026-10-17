import {
  PROJECT_VERSION,
  type Animation,
  type Clip,
  type ClipType,
  type ColorAdjust,
  type MediaAsset,
  type Project,
  type ProjectSettings,
  type ShapeStyle,
  type TextStyle,
  type Track,
  type TrackKind,
  type Transform,
} from './types';

let counter = 0;
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const DEFAULT_COLOR: ColorAdjust = { brightness: 0, contrast: 1, saturation: 1 };
export const DEFAULT_ANIMATION: Animation = { in: 'none', out: 'none', duration: 0.5 };

export const ASPECT_PRESETS: Record<string, { label: string; width: number; height: number }> = {
  landscape: { label: 'Landscape 16:9 (YouTube)', width: 1920, height: 1080 },
  portrait: { label: 'Portrait 9:16 (Reels / Shorts)', width: 1080, height: 1920 },
  square: { label: 'Square 1:1 (Instagram)', width: 1080, height: 1080 },
  hd: { label: 'HD 720p', width: 1280, height: 720 },
};

export function createProject(name = 'Untitled project', settings: Partial<ProjectSettings> = {}): Project {
  return {
    version: PROJECT_VERSION,
    id: uid('proj'),
    name,
    settings: { width: 1920, height: 1080, fps: 30, background: '#000000', ...settings },
    media: [],
    tracks: [],
  };
}

export function createTrack(kind: TrackKind, name?: string): Track {
  return {
    id: uid('trk'),
    kind,
    name: name ?? (kind === 'visual' ? 'Layer' : 'Audio'),
    hidden: false,
    locked: false,
    muted: false,
    clips: [],
  };
}

export const DEFAULT_TEXT: TextStyle = {
  text: 'Your text here',
  fontFamily: 'Inter, Segoe UI, Arial, sans-serif',
  fontSize: 96,
  fontWeight: 'bold',
  italic: false,
  color: '#ffffff',
  align: 'center',
  background: '',
  lineHeight: 1.2,
};

export type ClipInit = Omit<Partial<Clip>, 'transform' | 'text' | 'shape'> & {
  transform?: Partial<Transform>;
  text?: Partial<TextStyle>;
  shape?: Partial<ShapeStyle>;
};

export function createClip(type: ClipType, init: ClipInit = {}): Clip {
  const { transform, text, shape, ...rest } = init;
  return {
    id: uid('clip'),
    type,
    name: init.name ?? type[0].toUpperCase() + type.slice(1),
    start: 0,
    duration: 5,
    inPoint: 0,
    transform: { x: 0, y: 0, width: 400, height: 200, rotation: 0, opacity: 1, ...transform },
    color: { ...DEFAULT_COLOR },
    animation: { ...DEFAULT_ANIMATION },
    volume: 1,
    ...rest,
    text: type === 'text' ? { ...DEFAULT_TEXT, ...text } : undefined,
    shape: type === 'shape' ? { kind: 'rect', fill: '#7c5cff', radius: 0, stroke: '', strokeWidth: 0, ...shape } : undefined,
  };
}

/** Fit media inside the canvas, centred, preserving aspect ratio. */
export function fitTransform(project: Project, mediaW: number, mediaH: number, scale = 1): Transform {
  const { width: W, height: H } = project.settings;
  if (!mediaW || !mediaH) return { x: 0, y: 0, width: W, height: H, rotation: 0, opacity: 1 };
  const k = Math.min(W / mediaW, H / mediaH) * scale;
  const w = Math.round(mediaW * k);
  const h = Math.round(mediaH * k);
  return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), width: w, height: h, rotation: 0, opacity: 1 };
}

export function clipFromMedia(project: Project, asset: MediaAsset, start = 0): Clip {
  const type: ClipType = asset.kind;
  // Footage fills the frame; images (logos, stickers) keep their natural size
  // unless they're bigger than the canvas.
  const { width: W, height: H } = project.settings;
  const imageScale = asset.kind === 'image' && asset.width && asset.height
    ? Math.min(1, Math.max(asset.width / W, asset.height / H))
    : 1;
  return createClip(type, {
    name: asset.name,
    mediaId: asset.id,
    start,
    duration: asset.kind === 'image' ? 5 : Math.max(0.1, asset.duration),
    transform: asset.kind === 'audio' ? undefined : fitTransform(project, asset.width, asset.height, imageScale),
  });
}

export function clipEnd(c: Clip): number {
  return c.start + c.duration;
}

export function projectDuration(p: Project): number {
  let d = 0;
  for (const t of p.tracks) for (const c of t.clips) d = Math.max(d, clipEnd(c));
  return d;
}

export function findClip(p: Project, clipId: string): { track: Track; clip: Clip; trackIndex: number } | undefined {
  for (let i = 0; i < p.tracks.length; i++) {
    const clip = p.tracks[i].clips.find((c) => c.id === clipId);
    if (clip) return { track: p.tracks[i], clip, trackIndex: i };
  }
  return undefined;
}

export function getMedia(p: Project, id?: string): MediaAsset | undefined {
  return id ? p.media.find((m) => m.id === id) : undefined;
}

export function isActive(c: Clip, t: number): boolean {
  return t >= c.start && t < clipEnd(c);
}

/** Visual clips visible at time t, bottom-most first. */
export function visibleClipsAt(p: Project, t: number): { clip: Clip; track: Track }[] {
  const out: { clip: Clip; track: Track }[] = [];
  for (const track of p.tracks) {
    if (track.kind !== 'visual' || track.hidden) continue;
    for (const clip of track.clips) if (isActive(clip, t)) out.push({ clip, track });
  }
  return out;
}

/**
 * Direction of travel for a slide, in project pixels. An in-animation starts at
 * minus this offset and travels into place; an out-animation travels by it.
 */
export function slideDistance(p: Project, kind: Animation['in']): { dx: number; dy: number } {
  const { width: W, height: H } = p.settings;
  switch (kind) {
    case 'slide-left': return { dx: -W * 0.25, dy: 0 };
    case 'slide-right': return { dx: W * 0.25, dy: 0 };
    case 'slide-up': return { dx: 0, dy: -H * 0.25 };
    case 'slide-down': return { dx: 0, dy: H * 0.25 };
    default: return { dx: 0, dy: 0 };
  }
}

/**
 * Animation state of a clip at timeline time t: an offset and an opacity
 * multiplier. The exporter generates FFmpeg expressions with the same math.
 * Slides also fade, matching how most template motion looks.
 */
export function animationAt(p: Project, c: Clip, t: number): { dx: number; dy: number; alpha: number } {
  const d = Math.min(c.animation.duration, c.duration / 2);
  let dx = 0, dy = 0, alpha = 1;
  const local = t - c.start;
  if (c.animation.in !== 'none' && d > 0 && local < d) {
    const k = 1 - Math.max(0, local) / d; // 1 → 0
    const s = slideDistance(p, c.animation.in);
    dx -= s.dx * k; dy -= s.dy * k; alpha *= 1 - k;
  }
  const remain = clipEnd(c) - t;
  if (c.animation.out !== 'none' && d > 0 && remain < d) {
    const k = 1 - Math.max(0, remain) / d; // 0 → 1
    const s = slideDistance(p, c.animation.out);
    dx += s.dx * k; dy += s.dy * k; alpha *= 1 - k;
  }
  return { dx, dy, alpha };
}

/** Throws if the value isn't a usable project; fills defaults for older files. */
export function normalizeProject(raw: unknown): Project {
  const p = raw as Project;
  if (!p || typeof p !== 'object' || !Array.isArray(p.tracks) || !p.settings) {
    throw new Error('Not a One Platform project file');
  }
  if (p.version > PROJECT_VERSION) throw new Error(`Project was saved by a newer version (v${p.version})`);
  return {
    ...p,
    version: PROJECT_VERSION,
    media: p.media ?? [],
    tracks: p.tracks.map((t) => ({
      ...createTrack(t.kind, t.name),
      ...t,
      clips: t.clips.map((c) => ({
        ...c,
        color: { ...DEFAULT_COLOR, ...c.color },
        animation: { ...DEFAULT_ANIMATION, ...c.animation },
        volume: c.volume ?? 1,
        inPoint: c.inPoint ?? 0,
      })),
    })),
  };
}
