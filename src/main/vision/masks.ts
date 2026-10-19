// Small, dependency-free helpers for 8-bit masks (0 / 255), one byte per pixel.

export interface Bounds { x0: number; y0: number; x1: number; y1: number }

export function bounds(m: Uint8Array, w: number, h: number): Bounds | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (m[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

export function area(m: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < m.length; i++) if (m[i]) n++;
  return n;
}

/** A pixel inside the mask near its centre of mass (the centroid itself may fall outside). */
export function interiorPoint(m: Uint8Array, w: number, h: number): { x: number; y: number } | null {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { sx += x; sy += y; n++; }
  if (!n) return null;
  const cx = sx / n, cy = sy / n;
  if (m[Math.round(cy) * w + Math.round(cx)]) return { x: cx, y: cy };
  let best = Infinity, bx = 0, by = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m[y * w + x]) continue;
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < best) { best = d; bx = x; by = y; }
  }
  return { x: bx, y: by };
}

export function centroid(m: Uint8Array, w: number, h: number): { x: number; y: number } | null {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { sx += x; sy += y; n++; }
  return n ? { x: sx / n, y: sy / n } : null;
}

/** Square dilation by r pixels (separable max filter). */
export function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return m.slice();
  const tmp = new Uint8Array(m.length);
  const out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let last = -Infinity;
    // distance to the most recent set pixel on the left, then a right-to-left pass
    for (let x = 0; x < w; x++) { if (m[row + x]) last = x; if (x - last <= r) tmp[row + x] = 255; }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) { if (m[row + x]) last = x; if (last - x <= r) tmp[row + x] = 255; }
  }
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= r) out[y * w + x] = 255; }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= r) out[y * w + x] = 255; }
  }
  return out;
}

/** Mask shifted by (dx, dy) pixels (rounded), outside filled with 0. */
export function shift(m: Uint8Array, w: number, h: number, dx: number, dy: number): Uint8Array {
  const ix = Math.round(dx), iy = Math.round(dy);
  const out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) {
    const sy = y - iy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - ix;
      if (sx >= 0 && sx < w) out[y * w + x] = m[sy * w + sx];
    }
  }
  return out;
}

export function union(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] | b[i];
  return out;
}

/** Intersection-over-union of two masks. */
export function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) inter++;
    if (a[i] || b[i]) uni++;
  }
  return uni ? inter / uni : 1;
}

/**
 * Masks for every output time, from masks known at key times. Between two
 * keys, each key mask is slid along the object's motion and the two are
 * united, so a moving object stays covered between analysed frames.
 */
export function interpolateMasks(
  keys: (Uint8Array | null)[], keyTimes: number[], outTimes: number[], w: number, h: number,
): (Uint8Array | null)[] {
  const cents = keys.map((m) => (m ? centroid(m, w, h) : null));
  return outTimes.map((t) => {
    let i = keyTimes.findIndex((kt) => kt > t) - 1;
    if (i < -1) i = keyTimes.length - 1; // past the last key
    if (i === -1) return keys[0];
    const a = keys[i], b = keys[i + 1];
    if (!b || i + 1 >= keys.length) return a;
    if (!a) return null;
    const ca = cents[i]!, cb = cents[i + 1]!;
    const f = (t - keyTimes[i]) / (keyTimes[i + 1] - keyTimes[i]);
    if (f <= 0) return a;
    const dx = cb.x - ca.x, dy = cb.y - ca.y;
    return union(shift(a, w, h, dx * f, dy * f), shift(b, w, h, -dx * (1 - f), -dy * (1 - f)));
  });
}

/**
 * Keeps only the connected parts of the mask that contain one of `seeds`
 * (or, if none hit the mask, the largest part). Removes stray specks.
 */
export function keepComponents(m: Uint8Array, w: number, h: number, seeds: { x: number; y: number }[] = []): Uint8Array {
  const label = new Int32Array(m.length);
  const sizes: number[] = [0];
  const stack: number[] = [];
  for (let start = 0; start < m.length; start++) {
    if (!m[start] || label[start]) continue;
    const id = sizes.length;
    let size = 0;
    stack.push(start);
    label[start] = id;
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && m[p - 1] && !label[p - 1]) { label[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && m[p + 1] && !label[p + 1]) { label[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && m[p - w] && !label[p - w]) { label[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && m[p + w] && !label[p + w]) { label[p + w] = id; stack.push(p + w); }
    }
    sizes.push(size);
  }
  if (sizes.length <= 2) return m;
  const keep = new Set<number>();
  for (const s of seeds) {
    const id = label[Math.round(s.y) * w + Math.round(s.x)];
    if (id) keep.add(id);
  }
  if (!keep.size) keep.add(sizes.indexOf(Math.max(...sizes.slice(1))));
  const out = new Uint8Array(m.length);
  for (let p = 0; p < m.length; p++) if (keep.has(label[p])) out[p] = 255;
  return out;
}
