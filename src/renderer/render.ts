// Canvas drawing shared by the live preview, template thumbnails and export
// rasterisation, so what the user sees is what gets rendered.

import { animationAt, blurSigma, pixelBlock, regionActiveAt, visibleClipsAt, type Clip, type Project, type Region } from '../engine';

export type SourceLookup = (clip: Clip) => CanvasImageSource | null;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, rr);
}

export function fontString(c: Clip) {
  const t = c.text!;
  return `${t.italic ? 'italic ' : ''}${t.fontWeight === 'bold' ? 700 : 400} ${t.fontSize}px ${t.fontFamily}`;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (line && ctx.measureText(test).width > maxWidth && w.trim()) {
        lines.push(line.trimEnd());
        line = w.trimStart();
      } else {
        line = test;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Draws a text clip into a box of w×h at the origin. */
export function drawText(ctx: CanvasRenderingContext2D, c: Clip, w: number, h: number) {
  const t = c.text!;
  ctx.font = fontString(c);
  ctx.textBaseline = 'middle';
  const lines = wrap(ctx, t.text, w);
  const lh = t.fontSize * t.lineHeight;
  const total = lh * lines.length;
  let y = (h - total) / 2 + lh / 2;
  const xFor = (lw: number) => (t.align === 'left' ? 0 : t.align === 'right' ? w - lw : (w - lw) / 2);
  for (const line of lines) {
    const lw = ctx.measureText(line).width;
    if (t.background) {
      const pad = t.fontSize * 0.25;
      ctx.fillStyle = t.background;
      roundRect(ctx, xFor(lw) - pad, y - lh / 2, lw + pad * 2, lh, t.fontSize * 0.15);
      ctx.fill();
    }
    ctx.fillStyle = t.color;
    ctx.fillText(line, xFor(lw), y);
    y += lh;
  }
}

export function drawShape(ctx: CanvasRenderingContext2D, c: Clip, w: number, h: number) {
  const s = c.shape!;
  const inset = s.stroke && s.strokeWidth ? s.strokeWidth / 2 : 0;
  if (s.kind === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, Math.max(0, w / 2 - inset), Math.max(0, h / 2 - inset), 0, 0, Math.PI * 2);
  } else {
    roundRect(ctx, inset, inset, w - inset * 2, h - inset * 2, s.radius);
  }
  ctx.fillStyle = s.fill;
  ctx.fill();
  if (inset) {
    ctx.lineWidth = s.strokeWidth;
    ctx.strokeStyle = s.stroke;
    ctx.stroke();
  }
}

function drawPlaceholderLabel(ctx: CanvasRenderingContext2D, c: Clip, w: number, h: number) {
  const size = Math.max(14, Math.min(w, h) * 0.07);
  ctx.fillStyle = '#ffffffaa';
  ctx.font = `600 ${size}px Segoe UI, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('＋ ' + (c.placeholder ?? ''), w / 2, h / 2, w * 0.9);
  ctx.textAlign = 'start';
}

/** CSS filter approximating the exporter's eq= colour adjustment. */
export function colorFilter(c: Clip) {
  const { brightness, contrast, saturation } = c.color;
  if (!brightness && contrast === 1 && saturation === 1) return 'none';
  return `brightness(${1 + brightness}) contrast(${contrast}) saturate(${saturation})`;
}

export interface DrawOptions {
  /** Draw template placeholder labels (preview only, never exported). */
  placeholders?: boolean;
}

/** Draws the whole frame at time t. ctx should already be scaled to project pixels. */
export function drawFrame(ctx: CanvasRenderingContext2D, p: Project, t: number, source: SourceLookup, opts: DrawOptions = {}) {
  const { width: W, height: H } = p.settings;
  ctx.save();
  ctx.fillStyle = p.settings.background;
  ctx.fillRect(0, 0, W, H);
  for (const { clip } of visibleClipsAt(p, t)) {
    const tr = clip.transform;
    const anim = animationAt(p, clip, t);
    const alpha = tr.opacity * anim.alpha;
    if (alpha <= 0) continue;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(tr.x + tr.width / 2 + anim.dx, tr.y + tr.height / 2 + anim.dy);
    if (tr.rotation) ctx.rotate((tr.rotation * Math.PI) / 180);
    ctx.translate(-tr.width / 2, -tr.height / 2);
    ctx.filter = colorFilter(clip);
    if (clip.type === 'text') drawText(ctx, clip, tr.width, tr.height);
    else if (clip.type === 'shape') {
      drawShape(ctx, clip, tr.width, tr.height);
      if (opts.placeholders && clip.placeholder) {
        ctx.filter = 'none';
        drawPlaceholderLabel(ctx, clip, tr.width, tr.height);
      }
    } else {
      const src = source(clip);
      if (src) {
        ctx.drawImage(src, 0, 0, tr.width, tr.height);
        for (const rg of clip.regions ?? []) {
          if (regionActiveAt(rg, clip, t)) drawRegion(ctx, rg, src, tr.width, tr.height);
        }
      }
    }
    ctx.restore();
  }
  ctx.restore();
}

function sourceSize(src: CanvasImageSource): [number, number] {
  if (src instanceof HTMLVideoElement) return [src.videoWidth, src.videoHeight];
  if (src instanceof HTMLImageElement) return [src.naturalWidth, src.naturalHeight];
  const c = src as HTMLCanvasElement;
  return [c.width, c.height];
}

let scratch: HTMLCanvasElement | null = null;
function scratchCanvas(w: number, h: number) {
  scratch ??= document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  return scratch;
}

/**
 * Preview of an area fix, drawn over a clip already painted into a w×h box.
 * Mirrors the exporter: remove ≈ FFmpeg delogo (interpolate from the border),
 * blur ≈ gblur, pixelate = downscale + nearest-neighbour upscale.
 */
function drawRegion(ctx: CanvasRenderingContext2D, rg: Region, src: CanvasImageSource, w: number, h: number) {
  const [sw, sh] = sourceSize(src);
  if (!sw || !sh) return;
  const rx = rg.x * w, ry = rg.y * h, rw = rg.width * w, rh = rg.height * h;
  const sx = rg.x * sw, sy = rg.y * sh, srw = rg.width * sw, srh = rg.height * sh;
  const m = ctx.getTransform();
  const k = Math.hypot(m.a, m.b) || 1; // project px → device px
  // The clip's colour adjustment (ctx.filter) must also apply inside the area,
  // as in the export where eq= runs after the fixes.
  const base = ctx.filter === 'none' ? '' : ctx.filter;
  ctx.save();
  if (rg.kind === 'blur') {
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();
    ctx.filter = `${base} blur(${blurSigma(rg.strength, w, h) * k}px)`.trim();
    ctx.drawImage(src, 0, 0, w, h);
  } else if (rg.kind === 'pixelate') {
    const b = pixelBlock(rg.strength, w, h);
    const c = scratchCanvas(Math.max(1, Math.round(rw / b)), Math.max(1, Math.round(rh / b)));
    c.getContext('2d')!.drawImage(src, sx, sy, srw, srh, 0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(c, rx, ry, rw, rh);
  } else {
    removeArea(ctx, src, sw, sh, sx, sy, srw, srh, rx, ry, rw, rh, k);
  }
  ctx.restore();
}

/** Fills the area by blending its four border lines, weighted by distance. */
function removeArea(
  ctx: CanvasRenderingContext2D, src: CanvasImageSource, sw: number, sh: number,
  sx: number, sy: number, srw: number, srh: number, rx: number, ry: number, rw: number, rh: number, k: number,
) {
  // Work at preview resolution (capped) with a 1px ring of real pixels.
  const scale = Math.min(1, 320 / Math.max(rw * k, rh * k));
  const iw = Math.max(2, Math.round(rw * k * scale)), ih = Math.max(2, Math.round(rh * k * scale));
  const px = srw / iw, py = srh / ih; // source px per work px
  const c = scratchCanvas(iw + 2, ih + 2);
  const cx = c.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(src, Math.max(0, sx - px), Math.max(0, sy - py), Math.min(sw, srw + 2 * px), Math.min(sh, srh + 2 * py), 0, 0, iw + 2, ih + 2);
  let img: ImageData;
  try {
    img = cx.getImageData(0, 0, iw + 2, ih + 2);
  } catch {
    return; // canvas tainted (media served without CORS) — skip the preview
  }
  const d = img.data, W = iw + 2;
  const at = (x: number, y: number) => (y * W + x) * 4;
  for (let y = 1; y <= ih; y++) {
    const L = at(0, y), R = at(iw + 1, y);
    for (let x = 1; x <= iw; x++) {
      const T = at(x, 0), B = at(x, ih + 1);
      const wl = 1 / x, wr = 1 / (iw + 1 - x), wt = 1 / y, wb = 1 / (ih + 1 - y);
      const sum = wl + wr + wt + wb;
      const o = at(x, y);
      for (let ch = 0; ch < 4; ch++) d[o + ch] = (d[L + ch] * wl + d[R + ch] * wr + d[T + ch] * wt + d[B + ch] * wb) / sum;
    }
  }
  cx.putImageData(img, 0, 0);
  ctx.drawImage(c, 1, 1, iw, ih, rx, ry, rw, rh);
}

/** Renders a text/shape clip to PNG (base64, no prefix) at its box size. */
export function rasterizeClip(c: Clip): string {
  const w = Math.max(2, Math.round(c.transform.width));
  const h = Math.max(2, Math.round(c.transform.height));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  if (c.type === 'text') drawText(ctx, c, w, h);
  else drawShape(ctx, c, w, h);
  return canvas.toDataURL('image/png').split(',')[1];
}

/** Is project point (px,py) inside the clip's rotated box? */
export function hitTest(c: Clip, px: number, py: number) {
  const t = c.transform;
  const cx = t.x + t.width / 2, cy = t.y + t.height / 2;
  const a = (-t.rotation * Math.PI) / 180;
  const dx = px - cx, dy = py - cy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= t.width / 2 && Math.abs(ly) <= t.height / 2;
}
