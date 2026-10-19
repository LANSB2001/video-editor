import { spawn } from 'node:child_process';
import type { Frame } from './sam';

export interface ReadOptions {
  /** Source seconds. */
  start: number;
  duration: number;
  fps: number;
  width: number;
  height: number;
}

/** Decodes a section of a video into RGB frames at the given size and rate. */
export function readFrames(ffmpeg: string, file: string, o: ReadOptions): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(o.start), '-t', String(o.duration), '-i', file,
      '-vf', `fps=${o.fps},scale=${o.width}:${o.height}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'];
    const child = spawn(ffmpeg, args, { windowsHide: true });
    const size = o.width * o.height * 3;
    const frames: Frame[] = [];
    let buf: Buffer = Buffer.alloc(0);
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= size) {
        frames.push({ data: new Uint8Array(buf.subarray(0, size)), width: o.width, height: o.height });
        buf = buf.subarray(size);
      }
    });
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 && frames.length ? resolve(frames) : reject(new Error(err.trim() || 'Could not read video frames'))));
  });
}

/** Even dimensions with the long side at most `max`, keeping the aspect ratio. */
export function analysisSize(w: number, h: number, max = 640): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(2, Math.round((w * k) / 2) * 2), height: Math.max(2, Math.round((h * k) / 2) * 2) };
}
