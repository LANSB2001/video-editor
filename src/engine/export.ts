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
        const chain = [`fps=${fps}`, 'setpts=PTS-STARTPTS', `scale=${w}:${h}`];
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
        filters.push(`[${idx}:v]${chain.join(',')}[v${idx}]`);

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
