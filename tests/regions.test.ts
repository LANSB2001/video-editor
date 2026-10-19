// Area fixes (remove / blur / pixelate) rendered through FFmpeg, pixel-checked.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyCommands, buildExportPlan, createProject, findClip, regionActiveAt, type EditCommand, type MediaAsset } from '../src/engine';

const ffmpeg: string = process.env.ONE_FFMPEG ?? require('ffmpeg-static');
let dir: string;
const f = (n: string) => path.join(dir, n);
const ff = (args: string[]) => execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args]);

/** RGB pixels of a w×h block of the output at time t. */
function block(file: string, t: number, x: number, y: number, w = 1, h = 1): number[][] {
  const buf = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', `format=rgb24,crop=${w}:${h}:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const out: number[][] = [];
  for (let i = 0; i < buf.length; i += 3) out.push([buf[i], buf[i + 1], buf[i + 2]]);
  return out;
}
const luma = (p: number[]) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
function stddev(px: number[][]) {
  const l = px.map(luma);
  const m = l.reduce((a, b) => a + b, 0) / l.length;
  return Math.sqrt(l.reduce((a, b) => a + (b - m) ** 2, 0) / l.length);
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'one-rgn-'));
  // Blue frame with a red "logo" at (300,160) 40×40, 4 seconds.
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=30:d=4,drawbox=x=300:y=160:w=40:h=40:color=red:t=fill',
    '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-crf', '10', f('logo.mp4')]);
  // Black/white checkerboard, 20px squares.
  ff(['-f', 'lavfi', '-i', "color=c=black:s=640x360:r=30:d=2,format=gray,geq=lum='if(mod(floor(X/20)+floor(Y/20)\\,2)\\,255\\,0)',format=yuv444p",
    '-c:v', 'libx264', '-crf', '10', f('checker.mp4')]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const asset = (id: string, file: string, duration: number): MediaAsset =>
  ({ id, kind: 'video', name: id, path: f(file), duration, width: 640, height: 360, hasAudio: false });

function render(name: string, mediaId: string, file: string, duration: number, extra: EditCommand[]) {
  const p = applyCommands(createProject('rgn', { width: 640, height: 360 }), [
    { type: 'addMedia', asset: asset(mediaId, file, duration) },
    { type: 'addClipFromMedia', mediaId, clipId: 'v' },
    ...extra,
  ]);
  const out = f(name);
  execFileSync(ffmpeg, buildExportPlan(p, { output: out, rasters: {}, preset: 'ultrafast', crf: 12 }).args, { stdio: 'pipe' });
  return out;
}

// Region covering the red box with a margin.
const overLogo = { x: 290 / 640, y: 150 / 360, width: 60 / 640, height: 60 / 360 };

describe('area fixes', () => {
  it('remove: fills the logo from surrounding pixels', () => {
    const before = render('none.mp4', 'logo', 'logo.mp4', 4, []);
    expect(block(before, 1, 320, 180)[0][0]).toBeGreaterThan(200); // red
    const out = render('remove.mp4', 'logo', 'logo.mp4', 4, [{ type: 'addRegion', clipId: 'v', region: { kind: 'remove', ...overLogo } }]);
    const [r, , b] = block(out, 1, 320, 180)[0];
    expect(r).toBeLessThan(60);
    expect(b).toBeGreaterThan(180);
  });

  it('remove: only within its time range, measured in source time after a trim', () => {
    const out = render('timed.mp4', 'logo', 'logo.mp4', 4, [
      { type: 'trimClip', clipId: 'v', start: 0, duration: 3, inPoint: 1 }, // timeline 0 = source 1
      { type: 'addRegion', clipId: 'v', region: { kind: 'remove', ...overLogo, from: 2, to: 3 } }, // timeline 1..2
    ]);
    expect(block(out, 0.5, 320, 180)[0][0]).toBeGreaterThan(200); // still red
    expect(block(out, 1.5, 320, 180)[0][0]).toBeLessThan(60); // removed
    expect(block(out, 2.5, 320, 180)[0][0]).toBeGreaterThan(200); // red again
  });

  it('blur: smooths detail inside the area only', () => {
    const out = render('blur.mp4', 'chk', 'checker.mp4', 2, [{ type: 'addRegion', clipId: 'v', region: { kind: 'blur', x: 0.25, y: 0.25, width: 0.25, height: 0.25, strength: 8 } }]);
    expect(stddev(block(out, 1, 180, 110, 40, 40))).toBeLessThan(40); // inside
    expect(stddev(block(out, 1, 480, 250, 40, 40))).toBeGreaterThan(100); // outside untouched
  });

  it('pixelate: turns the area into large flat blocks', () => {
    const out = render('pix.mp4', 'chk', 'checker.mp4', 2, [{ type: 'addRegion', clipId: 'v', region: { kind: 'pixelate', x: 0, y: 0, width: 0.5, height: 0.5, strength: 10 } }]);
    // Block size at strength 10 is 36px: a 12×12 patch inside one block is flat.
    expect(stddev(block(out, 1, 2, 2, 12, 12))).toBeLessThan(6);
    expect(stddev(block(out, 1, 400, 250, 40, 40))).toBeGreaterThan(100);
  });

  it('regions follow the clip when it moves and use source time', () => {
    const p = applyCommands(createProject('t'), [
      { type: 'addMedia', asset: asset('logo', 'logo.mp4', 4) },
      { type: 'addClipFromMedia', mediaId: 'logo', clipId: 'v' },
      { type: 'addRegion', clipId: 'v', region: { kind: 'blur', from: 1, to: 2, x: 2, y: -1, width: 0.5, height: 0.5 } },
      { type: 'moveClip', clipId: 'v', start: 10 },
    ]);
    const c = findClip(p, 'v')!.clip;
    expect(c.regions![0]).toMatchObject({ x: 0.5, y: 0 }); // clamped inside the frame
    expect(regionActiveAt(c.regions![0], c, 11.5)).toBe(true);
    expect(regionActiveAt(c.regions![0], c, 10.5)).toBe(false);
  });

  it('rejects area fixes on text layers', () => {
    const p = applyCommands(createProject('t'), [{ type: 'addText', clipId: 't' }]);
    expect(() => applyCommands(p, [{ type: 'addRegion', clipId: 't', region: { kind: 'blur' } }])).toThrow();
  });
});
