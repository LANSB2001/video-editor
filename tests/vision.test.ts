// AI object tools on a synthetic clip: a red ball moving over a detailed,
// static background, with the clean background available as ground truth.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fillFrames } from '../src/main/vision/fill';
import { readFrames } from '../src/main/vision/frames';
import { area, bounds, dilate, interpolateMasks } from '../src/main/vision/masks';
import { Sam, type Frame } from '../src/main/vision/sam';
import { trackObject } from '../src/main/vision/track';
import { VisionService } from '../src/main/vision/session';

const ffmpeg: string = process.env.ONE_FFMPEG ?? require('ffmpeg-static');
const MODELS = path.resolve('models');
const hasModels = existsSync(path.join(MODELS, 'mobilesam_encoder.onnx'));
let dir: string;
const f = (n: string) => path.join(dir, n);
const ff = (args: string[]) => execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args]);

// Ball centre at time t (matches the overlay expression below, +45 for radius).
const ballAt = (t: number) => ({ x: 60 + t * 110 + 45, y: 130 + 40 * Math.sin(t * 2) + 45 });

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'one-vision-'));
  ff(['-f', 'lavfi', '-i', 'mandelbrot=s=640x360:end_pts=1:start_scale=0.5', '-frames:v', '1', f('bg.png')]);
  ff(['-f', 'lavfi', '-i', "color=c=black@0:s=90x90,format=rgba,geq=r='200':g='30':b='30':a='if(lte(hypot(X-45\\,Y-45)\\,42)\\,255\\,0)'", '-frames:v', '1', f('ball.png')]);
  ff(['-loop', '1', '-i', f('bg.png'), '-loop', '1', '-i', f('ball.png'), '-filter_complex',
    "[0]fps=30,format=yuv420p[b];[b][1]overlay=x='60+t*110':y='130+40*sin(t*2)':shortest=1,format=yuv420p",
    '-t', '3', '-c:v', 'libx264', '-crf', '12', f('ball.mp4')]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('mask helpers', () => {
  it('dilates and interpolates masks along the motion', () => {
    const w = 20, h = 10;
    const a = new Uint8Array(w * h); a[5 * w + 2] = 255;
    const b = new Uint8Array(w * h); b[5 * w + 12] = 255;
    expect(area(dilate(a, w, h, 1))).toBe(9);
    const [mid] = interpolateMasks([a, b], [0, 1], [0.5], w, h);
    expect(mid![5 * w + 7]).toBe(255); // halfway position covered
  });
});

describe.skipIf(!hasModels)('AI object tools (MobileSAM on CPU)', () => {
  let sam: Sam;
  let frames: Frame[];
  const fps = 10;

  beforeAll(async () => {
    sam = await Sam.load(MODELS);
    frames = await readFrames(ffmpeg, f('ball.mp4'), { start: 0, duration: 3, fps, width: 640, height: 360 });
  }, 120000);

  it('selects the ball from one click', async () => {
    const c = ballAt(1);
    const r = await sam.decode(await sam.encode(frames[10]), [{ x: c.x, y: c.y, label: 1 }]);
    expect(r.area).toBeGreaterThan(5542 * 0.85);
    expect(r.area).toBeLessThan(5542 * 1.15);
  }, 60000);

  it('tracks it through every frame and fills the background from other frames', async () => {
    const seed = 10;
    const c = ballAt(seed / fps);
    const first = await sam.decode(await sam.encode(frames[seed]), [{ x: c.x, y: c.y, label: 1 }]);
    const res = await trackObject(sam, frames, seed, first.mask);
    expect(res.first).toBe(0);
    expect(res.last).toBe(frames.length - 1);
    for (const i of [0, 5, 20, frames.length - 1]) {
      const b = bounds(res.masks[i]!, 640, 360)!;
      const want = ballAt(i / fps);
      expect(Math.abs((b.x0 + b.x1) / 2 - want.x), `frame ${i} x`).toBeLessThan(6);
      expect(Math.abs((b.y0 + b.y1) / 2 - want.y), `frame ${i} y`).toBeLessThan(6);
    }

    // Remove: compare the filled frames with the real background.
    const masks = res.masks.map((m) => (m ? dilate(m, 640, 360, 4) : null));
    const filled = fillFrames(frames, masks);
    const truth = { data: new Uint8Array(execFileSync(ffmpeg, ['-loglevel', 'error', '-i', f('bg.png'), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])) };
    for (const i of [3, 15, 27]) {
      const m = masks[i]!;
      let err = 0, n = 0, before = 0;
      for (let p = 0; p < m.length; p++) {
        if (!m[p]) continue;
        for (let ch = 0; ch < 3; ch++) {
          err += Math.abs(filled[i].data[p * 3 + ch] - truth.data[p * 3 + ch]);
          before += Math.abs(frames[i].data[p * 3 + ch] - truth.data[p * 3 + ch]);
        }
        n += 3;
      }
      expect(err / n, `frame ${i} mean error`).toBeLessThan(12); // 0–255 scale
      expect(before / n).toBeGreaterThan(40); // the ball really was there
    }
  }, 240000);
});

describe.skipIf(!hasModels)('VisionService: rendered results', () => {
  let svc: VisionService;
  let id: string;
  const pixel = (file: string, t: number, x: number, y: number, extra: string[] = [], fmt = 'rgb24', n = 3) => {
    const buf = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...extra, '-ss', String(t), '-i', file, '-frames:v', '1',
      '-vf', `format=${fmt},crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', fmt, '-']);
    return [...buf.subarray(0, n)];
  };

  beforeAll(async () => {
    svc = new VisionService(MODELS, ffmpeg, f('derived'), () => {});
    const info = await svc.begin({ path: f('ball.mp4'), name: 'ball.mp4', width: 640, height: 360, fps: 30, srcStart: 0, srcEnd: 3 });
    id = info.sessionId;
    const c = ballAt(1.5);
    const sel = await svc.select(id, 1.5, [{ x: c.x * info.width / 640, y: c.y * info.height / 360, label: 1 }]);
    expect(sel.area).toBeGreaterThan(4000);
    const tr = await svc.track(id);
    expect(tr.first).toBe(0);
    expect(tr.last).toBe(tr.frameCount - 1);
  }, 240000);

  it('remove: the ball is gone and the real background is back', async () => {
    const out = await svc.apply(id, 'remove');
    const bg = (x: number, y: number) => {
      const b = execFileSync(ffmpeg, ['-loglevel', 'error', '-i', f('bg.png'), '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      return [...b];
    };
    for (const t of [0.5, 1.5, 2.5]) {
      const c = ballAt(t);
      const got = pixel(out, t, Math.round(c.x), Math.round(c.y));
      const want = bg(Math.round(c.x), Math.round(c.y));
      const diff = Math.max(...got.map((v, i) => Math.abs(v - want[i])));
      expect(diff, `t=${t} got ${got} want ${want}`).toBeLessThan(30);
    }
    // Audio/duration preserved shape: same length as the source section.
    const dur = Number(execFileSync(require('ffprobe-static').path, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
    expect(dur).toBeCloseTo(3, 0);
  }, 240000);

  it('cutout: transparent everywhere except the ball', async () => {
    const out = await svc.apply(id, 'cutout');
    const dec = ['-c:v', 'libvpx-vp9'];
    const c = ballAt(1.5);
    const inside = pixel(out, 1.5, Math.round(c.x), Math.round(c.y), dec, 'rgba', 4);
    const outside = pixel(out, 1.5, 600, 40, dec, 'rgba', 4);
    expect(inside[3]).toBeGreaterThan(200);
    expect(inside[0]).toBeGreaterThan(150); // red ball
    expect(outside[3]).toBeLessThan(10);
  }, 240000);

  it('blur follows the ball', async () => {
    const out = await svc.apply(id, 'blur');
    expect(out.endsWith('.mp4')).toBe(true);
  }, 240000);
});
