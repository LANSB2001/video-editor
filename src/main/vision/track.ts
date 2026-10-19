// Follows a selected object through a clip: the user's clicks select it on one
// frame, then each neighbouring frame is prompted with the previous frame's
// box and an interior point. Tracking stops in a direction when the object is
// lost (disappears, or the mask jumps to something else).

import { area, bounds, dilate, interiorPoint, keepComponents, shift, type Bounds } from './masks';
import type { Frame, Point, Sam } from './sam';

export interface TrackResult {
  /** One per frame; null where the object isn't (or is no longer) found. */
  masks: (Uint8Array | null)[];
  /** First/last frame index where the object was found. */
  first: number;
  last: number;
}

export interface TrackOptions {
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
  /** How much the previous box is grown to search the next frame (fraction of size). */
  boxGrow?: number;
  /** Add "not the object" clicks just outside the search box (default true). */
  negatives?: boolean;
}

export class TrackingCancelled extends Error {
  constructor() { super('cancelled'); }
}

/** Frames bridged with an estimated outline before the object counts as lost. */
const MAX_COAST = 6;

function median(v: number[]) {
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
}

export async function trackObject(sam: Sam, frames: Frame[], seed: number, seedMask: Uint8Array, opts: TrackOptions = {}): Promise<TrackResult> {
  const n = frames.length;
  const { width: w, height: h } = frames[0];
  const masks: (Uint8Array | null)[] = new Array(n).fill(null);
  masks[seed] = seedMask;
  let done = 1;
  opts.onProgress?.(done, n);
  let first = seed, last = seed;

  for (const dir of [1, -1]) {
    let prev = seedMask;
    let prevArea = area(seedMask);
    const seedArea = prevArea;
    // Recent boxes: used to predict where the object goes next and to keep the
    // search box at the object's usual size (stops a slightly-too-big mask
    // from growing the search area frame after frame).
    const history: Bounds[] = [bounds(seedMask, w, h)!];
    // Slow-moving reference size: rejects gradual leaks a frame-to-frame check misses.
    let refArea = seedArea, refW = history[0].x1 - history[0].x0, refH = history[0].y1 - history[0].y0;
    let coasting = 0;
    for (let i = seed + dir; i >= 0 && i < n; i += dir) {
      if (opts.isCancelled?.()) throw new TrackingCancelled();
      const b = history.at(-1)!;
      const pt = interiorPoint(prev, w, h);
      if (!pt) break;
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      const before = history.at(-2);
      const vx = before ? cx - (before.x0 + before.x1) / 2 : 0;
      const vy = before ? cy - (before.y0 + before.y1) / 2 : 0;
      const recent = history.slice(-3);
      const bw = median(recent.map((r) => r.x1 - r.x0)), bh = median(recent.map((r) => r.y1 - r.y0));
      const g = opts.boxGrow ?? 0.15;
      const hw = (bw * (1 + g)) / 2 + 4 + Math.abs(vx) / 2, hh = (bh * (1 + g)) / 2 + 4 + Math.abs(vy) / 2;
      const px = cx + vx, py = cy + vy;
      const box = { x0: Math.max(0, px - hw), y0: Math.max(0, py - hh), x1: Math.min(w - 1, px + hw), y1: Math.min(h - 1, py + hh) };

      const emb = await sam.encode(frames[i]);
      const shifted = { x: Math.min(w - 1, Math.max(0, pt.x + vx)), y: Math.min(h - 1, Math.max(0, pt.y + vy)) };
      const points: Point[] = [{ ...shifted, label: 1 }];
      if (opts.negatives ?? true) {
        // Corners just outside the search box: stops the mask leaking into the background.
        const m = 6;
        for (const [x, y] of [[box.x0 - m, box.y0 - m], [box.x1 + m, box.y0 - m], [box.x0 - m, box.y1 + m], [box.x1 + m, box.y1 + m]]) {
          if (x >= 0 && y >= 0 && x < w && y < h) points.push({ x, y, label: 0 });
        }
      }
      const r = await sam.decode(emb, points, box);
      // Keep only what's plausibly the same object: the previous outline moved
      // along the motion, plus a margin. Cuts off leaks into similar-looking
      // background while still allowing normal movement and shape change.
      const reach = Math.max(4, Math.round(Math.max(bw, bh) * 0.15));
      const allowed = dilate(shift(prev, w, h, vx, vy), w, h, reach);
      for (let p = 0; p < r.mask.length; p++) if (r.mask[p] && !allowed[p]) r.mask[p] = 0;
      r.mask = keepComponents(r.mask, w, h);
      r.area = area(r.mask);
      // Check against the reference size; a bad frame is bridged by carrying
      // the last good outline along the motion ("coasting") for a few frames.
      const nb = bounds(r.mask, w, h);
      const ok = !!nb && r.area > 0
        && r.area / refArea > 0.6 && r.area / refArea < 1.35
        && (nb.x1 - nb.x0) / refW > 0.7 && (nb.x1 - nb.x0) / refW < 1.3
        && (nb.y1 - nb.y0) / refH > 0.7 && (nb.y1 - nb.y0) / refH < 1.3
        && r.area / seedArea > 0.25 && r.area / seedArea < 4;
      let mask: Uint8Array;
      if (ok) {
        mask = r.mask;
        coasting = 0;
        refArea = refArea * 0.85 + r.area * 0.15;
        refW = refW * 0.85 + (nb!.x1 - nb!.x0) * 0.15;
        refH = refH * 0.85 + (nb!.y1 - nb!.y0) * 0.15;
      } else {
        if (process.env.ONE_DEBUG_TRACK) console.log('coast at', i, { area: r.area, refArea, nb, refW, refH });
        if (++coasting > MAX_COAST) break;
        mask = shift(prev, w, h, vx, vy);
        if (!bounds(mask, w, h)) break; // moved out of frame
      }
      masks[i] = mask;
      prev = mask;
      prevArea = ok ? r.area : prevArea;
      history.push(bounds(mask, w, h)!);
      if (dir > 0) last = i; else first = i;
      opts.onProgress?.(++done, n);
    }
    // Frames after a long coast are guesses; drop them.
    if (coasting) {
      for (let k = 0; k < coasting; k++) {
        const idx = (dir > 0 ? last : first) - k * dir;
        masks[idx] = null;
      }
      if (dir > 0) last -= coasting; else first += coasting;
    }
    // Count frames skipped after losing the object so progress reaches 100%.
    done = dir > 0 ? n - seed : n;
    opts.onProgress?.(done, n);
  }
  return { masks, first, last };
}
