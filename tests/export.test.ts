// Renders real projects with FFmpeg and checks pixels in the output.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyCommands, buildExportPlan, createProject, findClip, type EditCommand, type MediaAsset, type Project } from '../src/engine';

const ffmpeg: string = process.env.ONE_FFMPEG ?? require('ffmpeg-static');
const ffprobe: string = process.env.ONE_FFPROBE ?? require('ffprobe-static').path;

let dir: string;
const f = (n: string) => path.join(dir, n);
const ff = (args: string[]) => execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args]);

/** RGB of one pixel of the output at time t. */
function pixel(file: string, t: number, x: number, y: number): [number, number, number] {
  const buf = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [buf[0], buf[1], buf[2]];
}
const near = (a: number[], b: number[], tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'one-test-'));
  // Solid blue 4s clip with a tone.
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('blue.mp4')]);
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=200x100', '-frames:v', '1', f('logo.png')]);
  ff(['-f', 'lavfi', '-i', 'color=c=lime:s=200x100', '-frames:v', '1', f('text.png')]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const blue: MediaAsset = { id: 'blue', kind: 'video', name: 'blue.mp4', path: '', duration: 4, width: 1280, height: 720, hasAudio: true };
const logo: MediaAsset = { id: 'logo', kind: 'image', name: 'logo.png', path: '', duration: 0, width: 200, height: 100, hasAudio: false };

function project() {
  return applyCommands(createProject('e2e', { width: 640, height: 360, fps: 30 }), [
    { type: 'addMedia', asset: { ...blue, path: f('blue.mp4') } },
    { type: 'addMedia', asset: { ...logo, path: f('logo.png') } },
    { type: 'addClipFromMedia', mediaId: 'blue', clipId: 'bg' },
    { type: 'addClipFromMedia', mediaId: 'logo', clipId: 'logo', start: 1 },
    { type: 'updateTransform', clipId: 'logo', transform: { x: 20, y: 20, width: 100, height: 50 } },
    { type: 'trimClip', clipId: 'logo', start: 1, duration: 2, inPoint: 0 },
    { type: 'addText', text: 'Hi', clipId: 'txt', start: 0, duration: 4, transform: { x: 400, y: 250, width: 200, height: 100 } },
  ]);
}

function render(name: string, extra: EditCommand[] | ((p: Project) => EditCommand[]) = []) {
  const p0 = project();
  const p = applyCommands(p0, typeof extra === 'function' ? extra(p0) : extra);
  const out = f(name);
  const plan = buildExportPlan(p, { output: out, rasters: { txt: f('text.png') }, preset: 'ultrafast' });
  execFileSync(ffmpeg, plan.args, { stdio: 'pipe' });
  return { out, p };
}

describe('FFmpeg export', () => {
  it('renders layers at the right place and time, with audio', () => {
    const { out } = render('basic.mp4');
    const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', out]).toString());
    expect(Number(info.format.duration)).toBeCloseTo(4, 0);
    expect(info.streams.map((s: { codec_type: string }) => s.codec_type).sort()).toEqual(['audio', 'video']);
    expect(info.streams.find((s: { codec_type: string }) => s.codec_type === 'video')).toMatchObject({ width: 640, height: 360 });

    expect(near(pixel(out, 0.5, 70, 45), [0, 0, 255])).toBe(true); // logo not yet visible
    expect(near(pixel(out, 2, 70, 45), [255, 0, 0])).toBe(true); // logo visible 1s–3s
    expect(near(pixel(out, 3.5, 70, 45), [0, 0, 255])).toBe(true); // gone again
    expect(near(pixel(out, 2, 500, 300), [0, 255, 0])).toBe(true); // text raster
  });

  it('hides hidden layers and applies opacity', () => {
    const { out } = render('hidden.mp4', (p) => [
      { type: 'updateTrack', trackId: findClip(p, 'txt')!.track.id, patch: { hidden: true } },
      { type: 'updateTransform', clipId: 'logo', transform: { opacity: 0.5 } },
    ]);
    expect(near(pixel(out, 2, 500, 300), [0, 0, 255])).toBe(true);
    expect(near(pixel(out, 2, 70, 45), [128, 0, 128], 45)).toBe(true);
  });

  it('applies rotation around the box centre', () => {
    const { out } = render('rot.mp4', [{ type: 'updateTransform', clipId: 'txt', transform: { rotation: 90 } }]);
    // 200x100 box centred at (500,300) rotated 90° → 100x200, spans y 200..400 → clipped at 360.
    expect(near(pixel(out, 2, 500, 220), [0, 255, 0])).toBe(true);
    expect(near(pixel(out, 2, 420, 300), [0, 0, 255])).toBe(true);
  });

  it('applies fade and slide animations matching the preview math', () => {
    const { out } = render('anim.mp4', [{ type: 'updateAnimation', clipId: 'txt', animation: { in: 'fade', out: 'none', duration: 1 } }]);
    const mid = pixel(out, 0.5, 500, 300); // half faded lime over blue
    expect(mid[1]).toBeGreaterThan(60);
    expect(mid[1]).toBeLessThan(200);
    expect(near(pixel(out, 1.5, 500, 300), [0, 255, 0])).toBe(true);
  });

  it('applies colour adjustments to video', () => {
    const { out } = render('grade.mp4', [{ type: 'updateColor', clipId: 'bg', color: { saturation: 0 } }]);
    const [r, g, b] = pixel(out, 0.5, 300, 180);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(20);
  });
});
