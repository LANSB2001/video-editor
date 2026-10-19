// Core project model. Everything the editor shows and everything the exporter
// renders is derived from a Project, so preview and export stay in sync.

export const PROJECT_VERSION = 1;

export type MediaKind = 'video' | 'image' | 'audio';

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  name: string;
  /** Absolute file path (desktop) or blob: URL (browser preview mode). */
  path: string;
  /** Seconds. 0 for still images. */
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Video frame rate (0 for images/audio). */
  fps?: number;
  /** Video has an alpha channel (VP9 WebM cut-outs). */
  hasAlpha?: boolean;
}

export type ClipType = 'video' | 'image' | 'text' | 'shape' | 'audio';

export interface Transform {
  /** Top-left corner in project pixels (before rotation). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise, around the box centre. */
  rotation: number;
  /** 0..1 */
  opacity: number;
}

export interface TextStyle {
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: 'normal' | 'bold';
  italic: boolean;
  color: string;
  align: 'left' | 'center' | 'right';
  /** Optional highlight box behind the text. Empty string = none. */
  background: string;
  lineHeight: number;
}

export interface ShapeStyle {
  kind: 'rect' | 'ellipse';
  fill: string;
  radius: number;
  stroke: string;
  strokeWidth: number;
}

export interface ColorAdjust {
  /** -1..1, 0 = unchanged */
  brightness: number;
  /** 0..2, 1 = unchanged */
  contrast: number;
  /** 0..3, 1 = unchanged */
  saturation: number;
}

export type AnimationKind = 'none' | 'fade' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down';

export interface Animation {
  in: AnimationKind;
  out: AnimationKind;
  /** Seconds for each of the in / out phases. */
  duration: number;
}

export type RegionKind = 'remove' | 'blur' | 'pixelate';

/**
 * A rectangular fix applied to a video/image clip's pixels: remove an object
 * (fill from the surrounding pixels), blur it, or pixelate it.
 * The box is in normalised clip coordinates (0..1 of the clip's frame), so it
 * stays on the object when the clip is moved or resized.
 */
export interface Region {
  id: string;
  kind: RegionKind;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Source-media seconds, so trimming/splitting the clip doesn't shift it. Undefined = whole clip. */
  from?: number;
  to?: number;
  /** 1..10 — blur radius / pixel block size. Ignored for 'remove'. */
  strength: number;
}

export interface Clip {
  id: string;
  type: ClipType;
  name: string;
  /** Timeline position, seconds. */
  start: number;
  /** Seconds on the timeline. */
  duration: number;
  /** Offset into the source media, seconds (video/audio). */
  inPoint: number;
  mediaId?: string;
  transform: Transform;
  text?: TextStyle;
  shape?: ShapeStyle;
  color: ColorAdjust;
  animation: Animation;
  /** 0..2 */
  volume: number;
  /** Area fixes (video and image clips). */
  regions?: Region[];
  /** Template placeholder hint, e.g. "Drop your product video here". */
  placeholder?: string;
}

export type TrackKind = 'visual' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  hidden: boolean;
  locked: boolean;
  muted: boolean;
  clips: Clip[];
}

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  background: string;
}

export interface Project {
  version: number;
  id: string;
  name: string;
  settings: ProjectSettings;
  media: MediaAsset[];
  /** Visual tracks: index 0 is the bottom-most layer. */
  tracks: Track[];
}
