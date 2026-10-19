// Turns a Project into an FFmpeg command line. Pure: no filesystem or process
// access, so it is unit-testable and shared by the desktop app and tests.
//
// Text and shape layers are rasterised to PNG by the renderer (the same canvas
// code that draws the preview) and passed in via `rasters`, so exported text
// looks exactly like what the user saw.

import { getMedia, projectDuration, slideDistance } from './project';
import type { Clip, Project } from './types';

export interface ExportOptions {
  output: string;
  /** clipId → PNG path for text/shape clips. */
  rasters: Record<string, string>;
  /** libx264 CRF, lower = better. */
  crf?: number;
  preset?: string;
}

export interface ExportPlan {
  args: string[];
  /** filter_complex graph, also included in args. */
  filter: string;
  duration: number;
}

const r = (n: number) => Number(n.toFixed(4)).toString();

function hasColorAdjust(c: Clip) {
  return c.color.brightness !== 0 || c.color.contrast !== 1 || c.color.saturation !== 1;
}

/** Escape a path for use inside an FFmpeg filtergraph option. */
export function escapeFilterValue(v: string) {
  return v.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:');
}

export function needsRaster(c: Clip) {
  return c.type === 'text' || c.type === 'shape';
}

/**
 * Appends filters applying a clip's area fixes to the scaled frame labelled
 * `input` (clip-local time, w×h). Returns the label of the result.
 */
function regionFilters(clip: Clip, w: number, h: number, input: string, prefix: string, filters: string[]): string {
  const regions = clip.regions ?? [];
  if (!regions.length) return input;
  // Source time = clip-local time + offset.
  const offset = clip.type === 'video' ? clip.inPoint : 0;
  let cur = input;
  filters.push(`[${cur}]format=yuva444p[${prefix}f]`);
  cur = `${prefix}f`;
  regions.forEach((rg, i) => {
    const from = Math.max(0, (rg.from ?? 0) - offset);
    const to = rg.to === undefined ? clip.duration + 1 : rg.to - offset;
    if (to <= 0 || from >= clip.duration) return;
    const enable = `enable='between(t,${r(from)},${r(to)})'`;
    const out = `${prefix}_${i}`;
    let x = Math.round(rg.x * w), y = Math.round(rg.y * h);
    let rw = Math.max(2, Math.round(rg.width * w)), rh = Math.max(2, Math.round(rg.height * h));
    if (rg.kind === 'remove') {
      // delogo needs a 1px border of real pixels to interpolate from.
      x = Math.max(1, x); y = Math.max(1, y);
      rw = Math.min(rw, w - 1 - x); rh = Math.min(rh, h - 1 - y);
      if (rw < 2 || rh < 2) return;
      filters.push(`[${cur}]delogo=x=${x}:y=${y}:w=${rw}:h=${rh}:${enable}[${out}]`);
    } else {
      rw = Math.min(rw, w - x); rh = Math.min(rh, h - y);
      const fx = rg.kind === 'blur'
        ? `gblur=sigma=${r(blurSigma(rg.strength, w, h))}`
        : (() => {
          const b = pixelBlock(rg.strength, w, h);
          return `scale=${Math.max(1, Math.round(rw / b))}:${Math.max(1, Math.round(rh / b))}:flags=area,scale=${rw}:${rh}:flags=neighbor`;
        })();
      filters.push(`[${cur}]split[${out}a][${out}b]`);
      filters.push(`[${out}b]crop=${rw}:${rh}:${x}:${y},${fx}[${out}c]`);
      filters.push(`[${out}a][${out}c]overlay=x=${x}:y=${y}:${enable}[${out}]`);
    }
    cur = out;
  });
  return cur;
}

/** Blur sigma in clip pixels for strength 1..10, scaled to the clip size. */
export function blurSigma(strength: number, w: number, h: number) {
  return (strength * Math.min(w, h)) / 200;
}

/** Pixelate block size in clip pixels for strength 1..10. */
export function pixelBlock(strength: number, w: number, h: number) {
  return Math.max(2, (strength * Math.min(w, h)) / 100);
}

export function buildExportPlan(p: Project, opts: ExportOptions): ExportPlan {
  const duration = projectDuration(p);
  if (duration <= 0) throw new Error('The timeline is empty — add a clip before exporting');

  const { width: W, height: H, fps } = p.settings;
  if (W % 2 || H % 2) throw new Error('Project width and height must be even numbers');

  const inputs: string[] = [];
  const filters: string[] = [];
  const audioLabels: string[] = [];
  let n = 0;

  filters.push(`color=c=${p.settings.background}:s=${W}x${H}:r=${fps}:d=${r(duration)},format=rgba[base]`);
  let last = 'base';

  for (const track of p.tracks) {
    for (const clip of track.clips) {
      const end = clip.start + clip.duration;
      const media = getMedia(p, clip.mediaId);
      const isVisual = clip.type !== 'audio';
      const drawVideo = isVisual && !track.hidden;
      const playAudio = !track.muted && clip.volume > 0 &&
        ((clip.type === 'video' && media?.hasAudio) || clip.type === 'audio');
      if (!drawVideo && !playAudio) continue;

      // ---- input
      const idx = n++;
      if (clip.type === 'video' || clip.type === 'audio') {
        if (!media) throw new Error(`Missing media for "${clip.name}"`);
        // FFmpeg's native VP9 decoder drops alpha; libvpx keeps it.
        if (media.hasAlpha) inputs.push('-c:v', 'libvpx-vp9');
        inputs.push('-ss', r(clip.inPoint), '-t', r(clip.duration), '-i', media.path);
      } else {
        const src = needsRaster(clip) ? opts.rasters[clip.id] : media?.path;
        if (!src) throw new Error(`Missing image for "${clip.name}"`);
        inputs.push('-loop', '1', '-framerate', String(fps), '-t', r(clip.duration), '-i', src);
      }

      // ---- video chain
      if (drawVideo) {
        const t = clip.transform;
        const w = Math.max(2, Math.round(t.width));
        const h = Math.max(2, Math.round(t.height));
        filters.push(`[${idx}:v]fps=${fps},setpts=PTS-STARTPTS,scale=${w}:${h}[s${idx}]`);
        const fixed = regionFilters(clip, w, h, `s${idx}`, `r${idx}`, filters);
        const chain: string[] = [];
        if (hasColorAdjust(clip)) {
          chain.push(`eq=brightness=${r(clip.color.brightness)}:contrast=${r(clip.color.contrast)}:saturation=${r(clip.color.saturation)}`);
        }
        chain.push('format=rgba');
        if (t.opacity < 1) chain.push(`colorchannelmixer=aa=${r(t.opacity)}`);
        const d = Math.min(clip.animation.duration, clip.duration / 2);
        if (clip.animation.in !== 'none' && d > 0) chain.push(`fade=t=in:st=0:d=${r(d)}:alpha=1`);
        if (clip.animation.out !== 'none' && d > 0) chain.push(`fade=t=out:st=${r(clip.duration - d)}:d=${r(d)}:alpha=1`);
        if (t.rotation) {
          const a = `${r(t.rotation)}*PI/180`;
          chain.push(`rotate=${a}:ow=rotw(${a}):oh=roth(${a}):c=none`);
        }
        chain.push(`setpts=PTS+${r(clip.start)}/TB`);
        filters.push(`[${fixed}]${chain.join(',')}[v${idx}]`);

        // Position: keep the box centre fixed (rotation grows the frame), plus
        // slide offsets that match animationAt() in the preview.
        const cx = t.x + t.width / 2;
        const cy = t.y + t.height / 2;
        let xe = `${r(cx)}-overlay_w/2`;
        let ye = `${r(cy)}-overlay_h/2`;
        if (d > 0) {
          const si = slideDistance(p, clip.animation.in);
          const so = slideDistance(p, clip.animation.out);
          const kin = `max(0,1-(t-${r(clip.start)})/${r(d)})`;
          const kout = `max(0,1-(${r(end)}-t)/${r(d)})`;
          if (si.dx) xe += `+(${r(-si.dx)})*${kin}`;
          if (si.dy) ye += `+(${r(-si.dy)})*${kin}`;
          if (so.dx) xe += `+(${r(so.dx)})*${kout}`;
          if (so.dy) ye += `+(${r(so.dy)})*${kout}`;
        }
        const out = `o${idx}`;
        filters.push(
          `[${last}][v${idx}]overlay=x='${xe}':y='${ye}':enable='between(t,${r(clip.start)},${r(end)})':eof_action=pass:format=auto[${out}]`,
        );
        last = out;
      }

      // ---- audio chain
      if (playAudio) {
        const ms = Math.round(clip.start * 1000);
        filters.push(
          `[${idx}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${r(clip.volume)},adelay=${ms}:all=1[a${idx}]`,
        );
        audioLabels.push(`[a${idx}]`);
      }
    }
  }

  filters.push(`[${last}]format=yuv420p[vout]`);
  if (audioLabels.length) {
    filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,apad[aout]`);
  } else {
    filters.push(`anullsrc=r=48000:cl=stereo[aout]`);
  }

  const filter = filters.join(';\n');
  const args = [
    '-y', '-hide_banner', '-nostats', '-progress', 'pipe:1',
    ...inputs,
    '-filter_complex', filter,
    '-map', '[vout]', '-map', '[aout]',
    '-t', r(duration),
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', opts.preset ?? 'medium', '-crf', String(opts.crf ?? 20), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    opts.output,
  ];
  return { args, filter, duration };
}

/** Parses `-progress pipe:1` output; returns seconds rendered, if present. */
export function parseProgress(chunk: string): number | undefined {
  const m = [...chunk.matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop();
  return m ? Number(m[1]) / 1e6 : undefined;
}
