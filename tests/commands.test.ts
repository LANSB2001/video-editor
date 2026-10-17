import { describe, expect, it } from 'vitest';
import {
  actionsToCommands, animationAt, applyCommand, applyCommands, createProject, findClip, History,
  normalizeProject, parseOffline, projectDuration, TEMPLATES, type MediaAsset, type Project,
} from '../src/engine';

const video: MediaAsset = { id: 'm1', kind: 'video', name: 'clip.mp4', path: '/x/clip.mp4', duration: 10, width: 1280, height: 720, hasAudio: true };
const logo: MediaAsset = { id: 'm2', kind: 'image', name: 'logo.png', path: '/x/logo.png', duration: 0, width: 200, height: 100, hasAudio: false };

function base(): Project {
  return applyCommands(createProject('t'), [
    { type: 'addMedia', asset: video },
    { type: 'addMedia', asset: logo },
    { type: 'addClipFromMedia', mediaId: 'm1', clipId: 'v' },
    { type: 'addClipFromMedia', mediaId: 'm2', clipId: 'l', start: 1 },
    { type: 'addText', text: 'Hello', clipId: 't' },
  ]);
}

describe('commands', () => {
  it('adds each element on its own layer, fitted to the canvas', () => {
    const p = base();
    expect(p.tracks).toHaveLength(3);
    expect(findClip(p, 'v')!.clip.transform).toMatchObject({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(projectDuration(p)).toBe(10);
  });

  it('keeps small images at their natural size, centred', () => {
    expect(findClip(base(), 'l')!.clip.transform).toMatchObject({ width: 200, height: 100, x: 860, y: 490 });
  });

  it('does not mutate the previous project (undo safety)', () => {
    const p = base();
    const before = JSON.stringify(p);
    applyCommand(p, { type: 'updateTransform', clipId: 'l', transform: { x: 500 } });
    expect(JSON.stringify(p)).toBe(before);
  });

  it('splits a video clip and keeps source continuity', () => {
    const p = applyCommand(base(), { type: 'splitClip', clipId: 'v', at: 4 });
    const clips = p.tracks[0].clips;
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({ start: 0, duration: 4, inPoint: 0 });
    expect(clips[1]).toMatchObject({ start: 4, duration: 6, inPoint: 4 });
  });

  it('clamps trims to the source length', () => {
    const p = applyCommand(base(), { type: 'trimClip', clipId: 'v', start: 0, duration: 50, inPoint: 2 });
    expect(findClip(p, 'v')!.clip).toMatchObject({ inPoint: 2, duration: 8 });
  });

  it('refuses edits on locked layers', () => {
    let p = base();
    p = applyCommand(p, { type: 'updateTrack', trackId: findClip(p, 't')!.track.id, patch: { locked: true } });
    expect(() => applyCommand(p, { type: 'deleteClip', clipId: 't' })).toThrow(/locked/);
  });

  it('keeps visual and audio clips on matching tracks', () => {
    let p = applyCommand(base(), { type: 'addTrack', kind: 'audio' });
    const audioTrack = p.tracks.at(-1)!.id;
    expect(() => applyCommand(p, { type: 'moveClip', clipId: 'l', start: 0, trackId: audioTrack })).toThrow();
    p = applyCommand(p, { type: 'moveClip', clipId: 'l', start: 3, trackId: p.tracks[0].id });
    expect(findClip(p, 'l')!.trackIndex).toBe(0);
  });

  it('replaces a template slot with media, fitting its aspect ratio', () => {
    let p = TEMPLATES.find((t) => t.id === 'product-launch')!.build();
    const slot = p.tracks.flatMap((t) => t.clips).find((c) => c.placeholder)!;
    p = applyCommands(p, [{ type: 'addMedia', asset: video }, { type: 'replaceMedia', clipId: slot.id, mediaId: 'm1' }]);
    const c = findClip(p, slot.id)!.clip;
    expect(c.type).toBe('video');
    expect(c.placeholder).toBeUndefined();
    expect(c.transform.width / c.transform.height).toBeCloseTo(16 / 9, 2);
  });

  it('undo/redo round-trips', () => {
    const h = new History();
    const a = base();
    const b = applyCommand(a, { type: 'deleteClip', clipId: 't' });
    h.push(a);
    expect(h.undo(b)).toBe(a);
    expect(h.redo(a)).toBe(b);
  });

  it('round-trips through JSON (save / open)', () => {
    const p = base();
    expect(normalizeProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(() => normalizeProject({ foo: 1 })).toThrow();
  });
});

describe('animation', () => {
  it('slides in from below for slide-up and ends in place', () => {
    let p = base();
    p = applyCommand(p, { type: 'updateAnimation', clipId: 't', animation: { in: 'slide-up', duration: 1 } });
    const c = findClip(p, 't')!.clip;
    expect(animationAt(p, c, 0).dy).toBeGreaterThan(0);
    expect(animationAt(p, c, 0).alpha).toBe(0);
    expect(animationAt(p, c, 2)).toEqual({ dx: 0, dy: 0, alpha: 1 });
  });
});

describe('templates', () => {
  it('all build into valid projects with content', () => {
    for (const t of TEMPLATES) {
      const p = t.build();
      expect(projectDuration(p), t.id).toBeGreaterThan(0);
      expect(p.settings.width % 2).toBe(0);
    }
  });
});

describe('AI', () => {
  it('offline parser moves the logo right', () => {
    const p = base();
    const r = parseOffline(p, 'move the logo to the right')!;
    const after = applyCommands(p, r.commands);
    const t = findClip(after, 'l')!.clip.transform;
    expect(t.x + t.width).toBeCloseTo(1920 - 96, 0);
  });

  it('offline parser recolours the heading', () => {
    const p = base();
    const after = applyCommands(p, parseOffline(p, 'change the heading color to blue')!.commands);
    expect(findClip(after, 't')!.clip.text!.color).toBe('#2f7bff');
  });

  it('offline parser removes the selected layer', () => {
    const p = base();
    const after = applyCommands(p, parseOffline(p, 'remove this', 'l')!.commands);
    expect(findClip(after, 'l')).toBeUndefined();
  });

  it('offline parser grades the video black and white (not "colour to white")', () => {
    const p = base();
    const r = parseOffline(p, 'make the video black and white')!;
    expect(r.reply).toMatch(/black and white/);
    expect(findClip(applyCommands(p, r.commands), 'v')!.clip.color.saturation).toBe(0);
  });

  it('does not claim a colour change on layers that have no colour', () => {
    expect(parseOffline(base(), 'make the video blue')).toBeNull();
  });

  it('returns null when unsure', () => {
    expect(parseOffline(base(), 'make it feel more cinematic and moody')).toBeNull();
  });

  it('rejects model actions that target unknown layers', () => {
    expect(() => actionsToCommands(base(), [{ action: 'delete', clipId: 'nope' }])).toThrow(/Unknown layer/);
  });
});
