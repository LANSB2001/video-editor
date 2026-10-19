// AI object tools, main-process side. One session per "select an object"
// workflow on a clip: decode the clip section once, let the user click to
// select, track through the section, then render a new video file with the
// object removed / cut out / blurred / pixelated.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uid } from '../../engine';
import type { ObjectAction, VisionBegin, VisionInfo, VisionProgress, VisionSelection } from '../../shared/api';
import { fillFrames } from './fill';
import { analysisSize, readFrames } from './frames';
import { area, dilate, interpolateMasks, keepComponents, union } from './masks';
import { Sam, type Embedding, type Frame, type Point } from './sam';
import { trackObject, TrackingCancelled, type TrackResult } from './track';

export const MAX_SECONDS = 30;

interface Session {
  id: string;
  req: VisionBegin;
  frames: Frame[];
  fps: number;
  /** Source seconds of each analysed frame. */
  times: number[];
  embeddings: Map<number, Embedding>;
  selection?: { frame: number; mask: Uint8Array; points: Point[] };
  track?: TrackResult;
  cancelled: boolean;
}

export class VisionService {
  private sam?: Promise<Sam>;
  private sessions = new Map<string, Session>();

  constructor(
    private modelDir: string,
    private ffmpeg: string,
    private outDir: string,
    private progress: (p: VisionProgress) => void,
  ) {}

  private model() {
    this.sam ??= Sam.load(this.modelDir).catch((e) => {
      this.sam = undefined;
      throw new Error(`Could not load the AI model from ${this.modelDir}: ${(e as Error).message}`);
    });
    return this.sam;
  }

  private get(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('This selection has expired — start again');
    return s;
  }

  async begin(req: VisionBegin): Promise<VisionInfo> {
    const duration = req.srcEnd - req.srcStart;
    if (duration <= 0) throw new Error('The clip is empty');
    if (duration > MAX_SECONDS) {
      throw new Error(`AI object tools work on up to ${MAX_SECONDS} seconds at a time. Split the clip (S) and select the part you need.`);
    }
    // Fewer analysed frames for longer sections keeps laptops responsive.
    const fps = Math.min(req.fps, duration <= 10 ? 15 : 10);
    const size = analysisSize(req.width, req.height);
    this.progress({ stage: 'prepare', done: 0, total: 1 });
    const [frames] = await Promise.all([
      readFrames(this.ffmpeg, req.path, { start: req.srcStart, duration, fps, ...size }),
      this.model(),
    ]);
    this.progress({ stage: 'prepare', done: 1, total: 1 });
    const id = uid('vis');
    this.sessions.set(id, {
      id, req, frames, fps, times: frames.map((_, i) => req.srcStart + i / fps), embeddings: new Map(), cancelled: false,
    });
    return { sessionId: id, width: size.width, height: size.height, frameCount: frames.length, fps };
  }

  private frameAt(s: Session, sourceTime: number) {
    return Math.max(0, Math.min(s.frames.length - 1, Math.round((sourceTime - s.req.srcStart) * s.fps)));
  }

  async select(id: string, sourceTime: number, points: Point[]): Promise<VisionSelection> {
    const s = this.get(id);
    if (!points.some((p) => p.label === 1)) throw new Error('Click on the object you want to select');
    const sam = await this.model();
    const i = this.frameAt(s, sourceTime);
    let emb = s.embeddings.get(i);
    if (!emb) {
      emb = await sam.encode(s.frames[i]);
      s.embeddings.clear(); // keep memory flat: only the frame being clicked on
      s.embeddings.set(i, emb);
    }
    const r = await sam.decode(emb, points);
    r.mask = keepComponents(r.mask, r.width, r.height, points.filter((p) => p.label === 1));
    r.area = area(r.mask);
    s.selection = { frame: i, mask: r.mask, points };
    s.track = undefined;
    return { mask: r.mask, width: r.width, height: r.height, area: r.area, score: r.score };
  }

  async track(id: string): Promise<{ first: number; last: number; frameCount: number }> {
    const s = this.get(id);
    if (!s.selection) throw new Error('Select an object first');
    s.cancelled = false;
    const sam = await this.model();
    try {
      s.track = await trackObject(sam, s.frames, s.selection.frame, s.selection.mask, {
        onProgress: (done, total) => this.progress({ stage: 'track', done, total }),
        isCancelled: () => s.cancelled,
      });
    } catch (e) {
      if (e instanceof TrackingCancelled) throw new Error('Tracking cancelled');
      throw e;
    }
    return { first: s.track.first, last: s.track.last, frameCount: s.frames.length };
  }

  /** Object mask at a source time (interpolated between analysed frames). */
  maskAt(id: string, sourceTime: number): Uint8Array | null {
    const s = this.get(id);
    if (!s.track) return s.selection && this.frameAt(s, sourceTime) === s.selection.frame ? s.selection.mask : null;
    const { width: w, height: h } = s.frames[0];
    return interpolateMasks(s.track.masks, s.times, [sourceTime], w, h)[0];
  }

  cancel(id: string) {
    const s = this.sessions.get(id);
    if (s) s.cancelled = true;
  }

  end(id: string) {
    this.sessions.delete(id);
  }

  /** Renders a new video file for the action and returns its path. */
  async apply(id: string, action: ObjectAction): Promise<string> {
    const s = this.get(id);
    if (!s.track) throw new Error('Track the object through the clip first');
    const { width: w, height: h } = s.frames[0];
    const { req } = s;
    const duration = req.srcEnd - req.srcStart;
    const outFps = req.fps;
    const outCount = Math.max(1, Math.round(duration * outFps));
    const outTimes = Array.from({ length: outCount }, (_, k) => req.srcStart + k / outFps);
    const full = interpolateMasks(s.track.masks, s.times, outTimes, w, h);
    const grow = Math.max(2, Math.round(w * 0.012)); // cover soft edges and motion blur

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'one-vision-'));
    try {
      const maskFile = path.join(tmp, 'mask.gray');
      const empty = new Uint8Array(w * h);
      const handle = await fs.open(maskFile, 'w');
      for (const m of full) {
        const mm = m ? (action === 'cutout' ? m : dilate(m, w, h, grow)) : empty;
        await handle.write(mm);
      }
      await handle.close();

      let fillFile: string | undefined;
      if (action === 'remove') {
        this.progress({ stage: 'fill', done: 0, total: 1 });
        // Each analysed frame stands in for the output frames until the next
        // one, so its hole must cover the object across that whole interval.
        const keyMasks = s.track.masks.map((_, i) => {
          let m: Uint8Array | null = null;
          outTimes.forEach((t, k) => {
            if (Math.floor((t - req.srcStart) * s.fps + 1e-6) === i && full[k]) m = m ? union(m, full[k]!) : full[k]!;
          });
          return m ? dilate(m, w, h, grow + 2) : null;
        });
        const filled = fillFrames(s.frames, keyMasks);
        fillFile = path.join(tmp, 'fill.rgb');
        const fh = await fs.open(fillFile, 'w');
        for (const f of filled) await fh.write(f.data);
        await fh.close();
        this.progress({ stage: 'fill', done: 1, total: 1 });
      }

      await fs.mkdir(this.outDir, { recursive: true });
      const base = path.parse(req.name).name.replace(/[^\w\- ]+/g, '').slice(0, 40) || 'clip';
      const out = path.join(this.outDir, `${base} (${ACTION_LABEL[action]}) ${uid('').slice(1, 7)}.${action === 'cutout' ? 'webm' : 'mp4'}`);
      await this.render(req, action, maskFile, fillFile, { w, h, fps: s.fps, outFps, duration }, out);
      return out;
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  private render(
    req: VisionBegin, action: ObjectAction, maskFile: string, fillFile: string | undefined,
    g: { w: number; h: number; fps: number; outFps: number; duration: number }, out: string,
  ): Promise<void> {
    const W = req.width % 2 ? req.width - 1 : req.width;
    const H = req.height % 2 ? req.height - 1 : req.height;
    const feather = Math.max(1, (W / g.w) * 1.2);
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
      '-ss', String(req.srcStart), '-t', String(g.duration), '-i', req.path,
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${g.w}x${g.h}`, '-r', String(g.outFps), '-i', maskFile];
    if (fillFile) args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${g.w}x${g.h}`, '-r', String(g.fps), '-i', fillFile);
    const src = `[0:v]fps=${g.outFps},scale=${W}:${H},setpts=PTS-STARTPTS,format=yuva444p[src]`;
    const mask = `[1:v]scale=${W}:${H}:flags=bilinear,gblur=sigma=${feather.toFixed(2)},format=gray[m]`;
    let graph: string;
    if (action === 'remove') {
      graph = `${src};${mask};[2:v]fps=${g.outFps},scale=${W}:${H}:flags=bicubic,format=yuva444p[fill];[fill][m]alphamerge[patch];[src][patch]overlay=shortest=1,format=yuv420p[out]`;
    } else if (action === 'blur' || action === 'pixelate') {
      const fx = action === 'blur'
        ? `gblur=sigma=${Math.max(6, W / 60).toFixed(1)}`
        : `scale=${Math.max(2, Math.round(W / 40))}:-2:flags=area,scale=${W}:${H}:flags=neighbor`;
      graph = `${src};${mask};[src]split[a][b];[b]${fx},format=yuva444p[fx];[fx][m]alphamerge[patch];[a][patch]overlay=shortest=1,format=yuv420p[out]`;
    } else {
      graph = `${src};${mask};[src][m]alphamerge,format=yuva420p[out]`;
    }
    args.push('-filter_complex', graph, '-map', '[out]');
    if (action === 'cutout') {
      args.push('-an', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '24', '-row-mt', '1', '-deadline', 'realtime', '-cpu-used', '6');
    } else {
      args.push('-map', '0:a?', '-c:a', 'aac', '-b:a', '192k', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
    }
    args.push('-t', String(g.duration), out);

    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpeg, args, { windowsHide: true });
      let err = '';
      child.stdout.on('data', (d: Buffer) => {
        const m = [...d.toString().matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop();
        if (m) this.progress({ stage: 'render', done: Math.min(g.duration, Number(m[1]) / 1e6), total: g.duration });
      });
      child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `FFmpeg exited with code ${code}`))));
    });
  }
}

const ACTION_LABEL: Record<ObjectAction, string> = { remove: 'object removed', cutout: 'cut-out', blur: 'blurred', pixelate: 'pixelated' };
