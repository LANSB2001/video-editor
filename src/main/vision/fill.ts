// Fills the area behind a removed object.
//
// 1. Temporal fill: when the object moves (and the camera is mostly still), the
//    background it covers is visible in other frames. Each hidden pixel takes
//    its value from the nearest frame in time where it is not covered.
// 2. Spatial fill for pixels never uncovered: a push-pull pyramid that
//    smoothly interpolates from the surrounding pixels.

import type { Frame } from './sam';

/**
 * Returns new frames with masked pixels filled. `masks[i]` may be null (no
 * object in that frame). Masks should already be dilated a little to cover
 * edges and motion blur.
 */
export function fillFrames(frames: Frame[], masks: (Uint8Array | null)[]): Frame[] {
  const n = frames.length;
  const { width: w, height: h } = frames[0];
  const px = w * h;
  const out = frames.map((f) => ({ ...f, data: f.data.slice() }));

  // For each frame, the list of covered pixels and the best candidate so far.
  const holes = masks.map((m) => {
    if (!m) return null;
    let count = 0;
    for (let i = 0; i < px; i++) if (m[i]) count++;
    const idx = new Int32Array(count);
    let k = 0;
    for (let i = 0; i < px; i++) if (m[i]) idx[k++] = i;
    return { idx, dist: new Int32Array(count).fill(1 << 30), rgb: new Uint8Array(count * 3) };
  });

  // Forward then backward sweep, tracking the last frame each pixel was visible.
  const lastSeen = new Int32Array(px);
  const lastRgb = new Uint8Array(px * 3);
  for (const dir of [1, -1]) {
    lastSeen.fill(-1);
    for (let t = dir > 0 ? 0 : n - 1; t >= 0 && t < n; t += dir) {
      const m = masks[t];
      const hole = holes[t];
      if (hole) {
        for (let k = 0; k < hole.idx.length; k++) {
          const p = hole.idx[k];
          if (lastSeen[p] < 0) continue;
          const d = Math.abs(t - lastSeen[p]);
          if (d < hole.dist[k]) {
            hole.dist[k] = d;
            hole.rgb[k * 3] = lastRgb[p * 3];
            hole.rgb[k * 3 + 1] = lastRgb[p * 3 + 1];
            hole.rgb[k * 3 + 2] = lastRgb[p * 3 + 2];
          }
        }
      }
      const data = frames[t].data;
      for (let p = 0; p < px; p++) {
        if (m && m[p]) continue;
        lastSeen[p] = t;
        lastRgb[p * 3] = data[p * 3];
        lastRgb[p * 3 + 1] = data[p * 3 + 1];
        lastRgb[p * 3 + 2] = data[p * 3 + 2];
      }
    }
  }

  for (let t = 0; t < n; t++) {
    const hole = holes[t];
    if (!hole) continue;
    const data = out[t].data;
    const unknown = new Uint8Array(px);
    let anyUnknown = false;
    for (let k = 0; k < hole.idx.length; k++) {
      const p = hole.idx[k];
      if (hole.dist[k] === 1 << 30) { unknown[p] = 1; anyUnknown = true; continue; }
      data[p * 3] = hole.rgb[k * 3];
      data[p * 3 + 1] = hole.rgb[k * 3 + 1];
      data[p * 3 + 2] = hole.rgb[k * 3 + 2];
    }
    if (anyUnknown) pushPull(data, unknown, w, h);
  }
  return out;
}

/**
 * Fills pixels flagged in `unknown` from known neighbours using a weighted
 * image pyramid (downsample known pixels, then upsample into the gaps).
 */
export function pushPull(data: Uint8Array, unknown: Uint8Array, w: number, h: number) {
  type Level = { w: number; h: number; c: Float32Array; wt: Float32Array };
  const base: Level = { w, h, c: new Float32Array(w * h * 3), wt: new Float32Array(w * h) };
  for (let p = 0; p < w * h; p++) {
    if (unknown[p]) continue;
    base.wt[p] = 1;
    base.c[p * 3] = data[p * 3]; base.c[p * 3 + 1] = data[p * 3 + 1]; base.c[p * 3 + 2] = data[p * 3 + 2];
  }
  const levels: Level[] = [base];
  // Push: average known pixels into coarser levels.
  while (levels.at(-1)!.w > 1 || levels.at(-1)!.h > 1) {
    const f = levels.at(-1)!;
    const nw = Math.max(1, Math.ceil(f.w / 2)), nh = Math.max(1, Math.ceil(f.h / 2));
    const c = new Float32Array(nw * nh * 3), wt = new Float32Array(nw * nh);
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const s = y * f.w + x, d = (y >> 1) * nw + (x >> 1), q = f.wt[s];
      if (!q) continue;
      wt[d] += q;
      c[d * 3] += f.c[s * 3] * q; c[d * 3 + 1] += f.c[s * 3 + 1] * q; c[d * 3 + 2] += f.c[s * 3 + 2] * q;
    }
    for (let d = 0; d < nw * nh; d++) if (wt[d]) { c[d * 3] /= wt[d]; c[d * 3 + 1] /= wt[d]; c[d * 3 + 2] /= wt[d]; wt[d] = Math.min(1, wt[d]); }
    levels.push({ w: nw, h: nh, c, wt });
  }
  // Pull: fill gaps at each finer level from the (bilinear) coarser one.
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], g = levels[l + 1];
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const s = y * f.w + x;
      const a = f.wt[s];
      if (a >= 1) continue;
      const gx = Math.min(g.w - 1, Math.max(0, (x - 0.5) / 2)), gy = Math.min(g.h - 1, Math.max(0, (y - 0.5) / 2));
      const x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(g.w - 1, x0 + 1), y1 = Math.min(g.h - 1, y0 + 1);
      const fx = gx - x0, fy = gy - y0;
      for (let ch = 0; ch < 3; ch++) {
        const v = (g.c[(y0 * g.w + x0) * 3 + ch] * (1 - fx) + g.c[(y0 * g.w + x1) * 3 + ch] * fx) * (1 - fy)
          + (g.c[(y1 * g.w + x0) * 3 + ch] * (1 - fx) + g.c[(y1 * g.w + x1) * 3 + ch] * fx) * fy;
        f.c[s * 3 + ch] = f.c[s * 3 + ch] * a + v * (1 - a);
      }
      f.wt[s] = 1;
    }
  }
  for (let p = 0; p < w * h; p++) {
    if (!unknown[p]) continue;
    data[p * 3] = Math.round(base.c[p * 3]); data[p * 3 + 1] = Math.round(base.c[p * 3 + 1]); data[p * 3 + 2] = Math.round(base.c[p * 3 + 2]);
  }
}
