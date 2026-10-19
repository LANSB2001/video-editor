// Every edit — from the mouse, the keyboard, a template or the AI assistant —
// is an EditCommand applied by applyCommand(). Commands are pure: they return
// a new Project and never mutate the input, which makes undo/redo trivial.

import {
  clipEnd,
  clipFromMedia,
  createClip,
  createTrack,
  findClip,
  getMedia,
  uid,
} from './project';
import type {
  Animation,
  Clip,
  ColorAdjust,
  MediaAsset,
  Project,
  ProjectSettings,
  Region,
  RegionKind,
  ShapeStyle,
  TextStyle,
  Track,
  Transform,
} from './types';

export type EditCommand =
  | { type: 'addMedia'; asset: MediaAsset }
  | { type: 'removeMedia'; mediaId: string }
  | { type: 'addClipFromMedia'; mediaId: string; start?: number; trackId?: string; clipId?: string }
  | { type: 'addText'; text?: string; start?: number; duration?: number; clipId?: string; style?: Partial<TextStyle>; transform?: Partial<Transform> }
  | { type: 'addShape'; start?: number; duration?: number; clipId?: string; style?: Partial<ShapeStyle>; transform?: Partial<Transform> }
  | { type: 'updateTransform'; clipId: string; transform: Partial<Transform> }
  | { type: 'updateText'; clipId: string; style: Partial<TextStyle> }
  | { type: 'updateShape'; clipId: string; style: Partial<ShapeStyle> }
  | { type: 'updateColor'; clipId: string; color: Partial<ColorAdjust> }
  | { type: 'updateAnimation'; clipId: string; animation: Partial<Animation> }
  | { type: 'updateClip'; clipId: string; patch: Partial<Pick<Clip, 'name' | 'volume'>> }
  | { type: 'moveClip'; clipId: string; start: number; trackId?: string }
  | { type: 'trimClip'; clipId: string; start: number; duration: number; inPoint: number }
  | { type: 'splitClip'; clipId: string; at: number }
  | { type: 'deleteClip'; clipId: string }
  | { type: 'duplicateClip'; clipId: string }
  | { type: 'replaceMedia'; clipId: string; mediaId: string }
  | { type: 'addRegion'; clipId: string; region: Partial<Region> & { kind: RegionKind } }
  | { type: 'updateRegion'; clipId: string; regionId: string; patch: Partial<Omit<Region, 'id'>> }
  | { type: 'deleteRegion'; clipId: string; regionId: string }
  | { type: 'addTrack'; kind: Track['kind']; name?: string; index?: number }
  | { type: 'updateTrack'; trackId: string; patch: Partial<Pick<Track, 'name' | 'hidden' | 'locked' | 'muted'>> }
  | { type: 'deleteTrack'; trackId: string }
  | { type: 'reorderTrack'; trackId: string; index: number }
  | { type: 'updateSettings'; settings: Partial<ProjectSettings> }
  | { type: 'rename'; name: string };

export class CommandError extends Error {}

const MIN_CLIP = 0.1;

function mapClip(p: Project, clipId: string, fn: (c: Clip, t: Track) => Clip): Project {
  if (!findClip(p, clipId)) throw new CommandError(`Clip ${clipId} not found`);
  return {
    ...p,
    tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? fn(c, t) : c)) })),
  };
}

function mapTrack(p: Project, trackId: string, fn: (t: Track) => Track): Project {
  if (!p.tracks.some((t) => t.id === trackId)) throw new CommandError(`Track ${trackId} not found`);
  return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? fn(t) : t)) };
}

function assertUnlocked(p: Project, clipId: string) {
  const f = findClip(p, clipId);
  if (!f) throw new CommandError(`Clip ${clipId} not found`);
  if (f.track.locked) throw new CommandError(`Layer "${f.track.name}" is locked`);
  return f;
}

/** Puts a clip on a new layer above all others (visual) or a new audio track. */
function addOnNewTrack(p: Project, clip: Clip, name: string): Project {
  const kind = clip.type === 'audio' ? 'audio' : 'visual';
  const track = { ...createTrack(kind, name), clips: [clip] };
  return { ...p, tracks: [...p.tracks, track] };
}

function sortClips(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.start - b.start);
}

export function applyCommand(p: Project, cmd: EditCommand): Project {
  switch (cmd.type) {
    case 'addMedia':
      if (p.media.some((m) => m.id === cmd.asset.id)) return p;
      return { ...p, media: [...p.media, cmd.asset] };

    case 'removeMedia': {
      const used = p.tracks.some((t) => t.clips.some((c) => c.mediaId === cmd.mediaId));
      if (used) throw new CommandError('Media is used on the timeline');
      return { ...p, media: p.media.filter((m) => m.id !== cmd.mediaId) };
    }

    case 'addClipFromMedia': {
      const asset = getMedia(p, cmd.mediaId);
      if (!asset) throw new CommandError(`Media ${cmd.mediaId} not found`);
      const clip = { ...clipFromMedia(p, asset, cmd.start ?? 0), ...(cmd.clipId ? { id: cmd.clipId } : {}) };
      if (cmd.trackId) {
        return mapTrack(p, cmd.trackId, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) }));
      }
      return addOnNewTrack(p, clip, asset.name);
    }

    case 'addText': {
      const { width: W, height: H } = p.settings;
      const clip = createClip('text', {
        ...(cmd.clipId ? { id: cmd.clipId } : {}),
        name: cmd.text?.slice(0, 24) || 'Text',
        start: cmd.start ?? 0,
        duration: cmd.duration ?? 5,
        text: { text: cmd.text ?? 'Your text here', ...cmd.style },
        transform: { x: W * 0.1, y: H * 0.4, width: W * 0.8, height: H * 0.2, ...cmd.transform },
      });
      return addOnNewTrack(p, clip, 'Text');
    }

    case 'addShape': {
      const { width: W, height: H } = p.settings;
      const clip = createClip('shape', {
        ...(cmd.clipId ? { id: cmd.clipId } : {}),
        start: cmd.start ?? 0,
        duration: cmd.duration ?? 5,
        shape: cmd.style,
        transform: { x: W * 0.35, y: H * 0.35, width: W * 0.3, height: H * 0.3, ...cmd.transform },
      });
      return addOnNewTrack(p, clip, 'Shape');
    }

    case 'updateTransform':
      assertUnlocked(p, cmd.clipId);
      return mapClip(p, cmd.clipId, (c) => {
        const t = { ...c.transform, ...cmd.transform };
        t.width = Math.max(1, t.width);
        t.height = Math.max(1, t.height);
        t.opacity = Math.min(1, Math.max(0, t.opacity));
        t.rotation = ((t.rotation % 360) + 360) % 360;
        return { ...c, transform: t };
      });

    case 'updateText':
      assertUnlocked(p, cmd.clipId);
      return mapClip(p, cmd.clipId, (c) => {
        if (c.type !== 'text' || !c.text) throw new CommandError('Not a text layer');
        const text = { ...c.text, ...cmd.style };
        return { ...c, text, name: cmd.style.text !== undefined ? text.text.slice(0, 24) || 'Text' : c.name };
      });

    case 'updateShape':
      assertUnlocked(p, cmd.clipId);
      return mapClip(p, cmd.clipId, (c) => {
        if (c.type !== 'shape' || !c.shape) throw new CommandError('Not a shape layer');
        return { ...c, shape: { ...c.shape, ...cmd.style } };
      });

    case 'updateColor':
      assertUnlocked(p, cmd.clipId);
      return mapClip(p, cmd.clipId, (c) => ({ ...c, color: { ...c.color, ...cmd.color } }));

    case 'updateAnimation':
      assertUnlocked(p, cmd.clipId);
      return mapClip(p, cmd.clipId, (c) => ({ ...c, animation: { ...c.animation, ...cmd.animation } }));

    case 'updateClip':
      assertUnlocked(p, cmd.clipId);
      return mapClip(p, cmd.clipId, (c) => ({ ...c, ...cmd.patch }));

    case 'moveClip': {
      const { clip, track } = assertUnlocked(p, cmd.clipId);
      const start = Math.max(0, cmd.start);
      const target = cmd.trackId ?? track.id;
      const dest = p.tracks.find((t) => t.id === target);
      if (!dest) throw new CommandError(`Track ${target} not found`);
      if (dest.locked) throw new CommandError(`Layer "${dest.name}" is locked`);
      if ((clip.type === 'audio') !== (dest.kind === 'audio')) {
        throw new CommandError(clip.type === 'audio' ? 'Audio clips go on audio tracks' : 'Visual clips go on visual layers');
      }
      const moved = { ...clip, start };
      return {
        ...p,
        tracks: p.tracks.map((t) => {
          let clips = t.clips.filter((c) => c.id !== clip.id);
          if (t.id === target) clips = sortClips([...clips, moved]);
          return clips === t.clips ? t : { ...t, clips };
        }),
      };
    }

    case 'trimClip': {
      const { clip } = assertUnlocked(p, cmd.clipId);
      const asset = getMedia(p, clip.mediaId);
      let { start, duration, inPoint } = cmd;
      inPoint = Math.max(0, inPoint);
      start = Math.max(0, start);
      duration = Math.max(MIN_CLIP, duration);
      if (asset && asset.kind !== 'image' && asset.duration > 0) {
        inPoint = Math.min(inPoint, asset.duration - MIN_CLIP);
        duration = Math.min(duration, asset.duration - inPoint);
      }
      return mapClip(p, cmd.clipId, (c) => ({ ...c, start, duration, inPoint }));
    }

    case 'splitClip': {
      const { clip, track } = assertUnlocked(p, cmd.clipId);
      const offset = cmd.at - clip.start;
      if (offset < MIN_CLIP || clipEnd(clip) - cmd.at < MIN_CLIP) {
        throw new CommandError('Move the playhead inside the clip to split it');
      }
      const left: Clip = { ...clip, duration: offset, animation: { ...clip.animation, out: 'none' } };
      const right: Clip = {
        ...structuredClone(clip),
        id: uid('clip'),
        start: cmd.at,
        duration: clip.duration - offset,
        inPoint: clip.inPoint + (clip.type === 'video' || clip.type === 'audio' ? offset : 0),
        animation: { ...clip.animation, in: 'none' },
      };
      return mapTrack(p, track.id, (t) => ({
        ...t,
        clips: sortClips(t.clips.flatMap((c) => (c.id === clip.id ? [left, right] : [c]))),
      }));
    }

    case 'deleteClip': {
      const { track } = assertUnlocked(p, cmd.clipId);
      return mapTrack(p, track.id, (t) => ({ ...t, clips: t.clips.filter((c) => c.id !== cmd.clipId) }));
    }

    case 'duplicateClip': {
      const { clip, track } = assertUnlocked(p, cmd.clipId);
      const copy: Clip = { ...structuredClone(clip), id: uid('clip'), start: clipEnd(clip) };
      return mapTrack(p, track.id, (t) => ({ ...t, clips: sortClips([...t.clips, copy]) }));
    }

    case 'replaceMedia': {
      const { clip } = assertUnlocked(p, cmd.clipId);
      const asset = getMedia(p, cmd.mediaId);
      if (!asset) throw new CommandError(`Media ${cmd.mediaId} not found`);
      if (clip.type === 'text' || (clip.type === 'shape' && !clip.placeholder)) {
        throw new CommandError('Only media layers and template slots can be replaced');
      }
      if ((asset.kind === 'audio') !== (clip.type === 'audio')) throw new CommandError('Media type does not fit this layer');
      return mapClip(p, cmd.clipId, (c) => {
        // Keep the slot's box but fit the new media's aspect ratio inside it.
        const box = c.transform;
        let transform = box;
        if (asset.width && asset.height) {
          const k = Math.min(box.width / asset.width, box.height / asset.height);
          const w = asset.width * k, h = asset.height * k;
          transform = { ...box, x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, width: w, height: h };
        }
        return {
          ...c,
          type: asset.kind,
          mediaId: asset.id,
          name: asset.name,
          inPoint: 0,
          duration: asset.kind === 'image' ? c.duration : Math.min(c.duration, asset.duration) || c.duration,
          transform,
          shape: undefined,
          regions: undefined,
          placeholder: undefined,
        };
      });
    }

    case 'addRegion': {
      const { clip } = assertUnlocked(p, cmd.clipId);
      if (clip.type !== 'video' && clip.type !== 'image') throw new CommandError('Area fixes work on video and image layers');
      const region = clampRegion({ x: 0.4, y: 0.4, width: 0.2, height: 0.2, strength: 5, ...cmd.region, id: cmd.region.id ?? uid('rgn') });
      return mapClip(p, cmd.clipId, (c) => ({ ...c, regions: [...(c.regions ?? []), region] }));
    }

    case 'updateRegion':
      assertUnlocked(p, cmd.clipId);
      return mapClip(p, cmd.clipId, (c) => {
        if (!c.regions?.some((r) => r.id === cmd.regionId)) throw new CommandError('Area not found');
        return { ...c, regions: c.regions.map((r) => (r.id === cmd.regionId ? clampRegion({ ...r, ...cmd.patch }) : r)) };
      });

    case 'deleteRegion':
      assertUnlocked(p, cmd.clipId);
      return mapClip(p, cmd.clipId, (c) => ({ ...c, regions: (c.regions ?? []).filter((r) => r.id !== cmd.regionId) }));

    case 'addTrack': {
      const track = createTrack(cmd.kind, cmd.name);
      const tracks = [...p.tracks];
      tracks.splice(cmd.index ?? tracks.length, 0, track);
      return { ...p, tracks };
    }

    case 'updateTrack':
      return mapTrack(p, cmd.trackId, (t) => ({ ...t, ...cmd.patch }));

    case 'deleteTrack':
      if (!p.tracks.some((t) => t.id === cmd.trackId)) throw new CommandError(`Track ${cmd.trackId} not found`);
      return { ...p, tracks: p.tracks.filter((t) => t.id !== cmd.trackId) };

    case 'reorderTrack': {
      const from = p.tracks.findIndex((t) => t.id === cmd.trackId);
      if (from < 0) throw new CommandError(`Track ${cmd.trackId} not found`);
      const tracks = [...p.tracks];
      const [t] = tracks.splice(from, 1);
      tracks.splice(Math.max(0, Math.min(tracks.length, cmd.index)), 0, t);
      return { ...p, tracks };
    }

    case 'updateSettings':
      return { ...p, settings: { ...p.settings, ...cmd.settings } };

    case 'rename':
      return { ...p, name: cmd.name };
  }
}

const MIN_REGION = 0.01;

/** Keeps a region inside the clip frame with a sane size and time range. */
export function clampRegion(r: Region): Region {
  const width = Math.min(1, Math.max(MIN_REGION, r.width));
  const height = Math.min(1, Math.max(MIN_REGION, r.height));
  const out: Region = {
    ...r,
    width,
    height,
    x: Math.min(1 - width, Math.max(0, r.x)),
    y: Math.min(1 - height, Math.max(0, r.y)),
    strength: Math.min(10, Math.max(1, r.strength)),
  };
  if (out.from !== undefined && out.to !== undefined && out.to < out.from) [out.from, out.to] = [out.to, out.from];
  return out;
}

export function applyCommands(p: Project, cmds: EditCommand[]): Project {
  return cmds.reduce(applyCommand, p);
}
