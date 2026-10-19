import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { findClip, projectDuration, regionActiveAt, visibleClipsAt, type Clip, type Region, type Transform } from '../../engine';
import { mediaPool } from '../mediaPool';
import { drawFrame, hitTest } from '../render';
import { useEditor } from '../store';
import { formatTime } from '../util';

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w' | 'rotate';

type RegionHandle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

interface RegionDrag {
  clipId: string;
  regionId: string;
  handle: RegionHandle;
  startX: number;
  startY: number;
  orig: Region;
  box: Transform;
}

interface Drag {
  handle: Handle;
  clipId: string;
  startX: number; // project px
  startY: number;
  orig: Transform;
  keepAspect: boolean;
}

const SNAP = 8; // screen px

export const REGION_LABEL: Record<Region['kind'], string> = { remove: 'Remove', blur: 'Blur', pixelate: 'Pixelate' };

export function Preview() {
  const project = useEditor((s) => s.project);
  const time = useEditor((s) => s.time);
  const playing = useEditor((s) => s.playing);
  const selectedId = useEditor((s) => s.selectedId);
  const { select, dispatch, beginGesture, setTime, setPlaying } = useEditor.getState();

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(0.4);
  const [guides, setGuides] = useState<{ v?: number; h?: number }>({});
  const drag = useRef<Drag | null>(null);
  const regionDrag = useRef<RegionDrag | null>(null);
  const selectedRegionId = useEditor((s) => s.selectedRegionId);
  const overlay = useEditor((s) => s.objectOverlay);
  const pickMode = useEditor((s) => s.pickMode);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const { width: W, height: H } = project.settings;

  // Fit the canvas into the available area.
  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const fit = () => {
      const r = el.getBoundingClientRect();
      setScale(Math.max(0.05, Math.min((r.width - 32) / W, (r.height - 32) / H)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  // Render loop + playback clock.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let needsDraw = true;
    mediaPool.onFrame = () => (needsDraw = true);
    const tick = (now: number) => {
      const s = useEditor.getState();
      const dt = (now - last) / 1000;
      last = now;
      if (s.playing) {
        const end = projectDuration(s.project);
        const t = s.time + dt;
        if (t >= end) {
          s.setPlaying(false);
          s.setTime(end);
        } else {
          s.setTime(t);
        }
        needsDraw = true;
      }
      mediaPool.sync(s.project, useEditor.getState().time, useEditor.getState().playing);
      const canvas = canvasRef.current;
      if (canvas && (needsDraw || s.playing)) {
        needsDraw = false;
        const ctx = canvas.getContext('2d')!;
        const k = canvas.width / s.project.settings.width;
        ctx.setTransform(k, 0, 0, k, 0, 0);
        drawFrame(ctx, s.project, useEditor.getState().time, (clip) =>
          clip.type === 'image' ? mediaPool.image(s.project, clip) : mediaPool.video(clip.id), { placeholders: true });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const unsub = useEditor.subscribe(() => (needsDraw = true));
    return () => {
      cancelAnimationFrame(raf);
      unsub();
      mediaPool.pauseAll();
    };
  }, []);

  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.round(W * scale);
  const cssH = Math.round(H * scale);

  const toProject = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  const selected = selectedId ? findClip(project, selectedId) : undefined;
  const selClip = selected && selected.clip.type !== 'audio' ? selected.clip : undefined;
  const selVisible = selClip && time >= selClip.start && time < selClip.start + selClip.duration && !selected!.track.hidden;

  // Draw the AI selection as a tinted overlay with the clip's own resolution.
  useEffect(() => {
    const c = overlayRef.current;
    if (!c || !overlay) return;
    c.width = overlay.width;
    c.height = overlay.height;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(overlay.width, overlay.height);
    const m = overlay.mask, w = overlay.width;
    for (let p = 0; p < m.length; p++) {
      if (!m[p]) continue;
      // Brighter outline where a neighbour is outside the mask.
      const edge = !m[p - 1] || !m[p + 1] || !m[p - w] || !m[p + w];
      img.data[p * 4] = edge ? 255 : 157;
      img.data[p * 4 + 1] = edge ? 255 : 120;
      img.data[p * 4 + 2] = 255;
      img.data[p * 4 + 3] = edge ? 255 : 120;
    }
    ctx.putImageData(img, 0, 0);
  }, [overlay]);

  function onPointerDown(e: React.PointerEvent) {
    const pt = toProject(e);
    if (pickMode && selClip?.id === pickMode.clipId) {
      // Point picking for AI selection: left click = object, Alt/right click = not the object.
      const t = selClip.transform;
      const a = (-t.rotation * Math.PI) / 180;
      const dx = pt.x - (t.x + t.width / 2), dy = pt.y - (t.y + t.height / 2);
      const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
      const nx = lx / t.width + 0.5, ny = ly / t.height + 0.5;
      if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
        e.preventDefault();
        pickMode.onPick(nx, ny, e.button === 2 || e.altKey ? 0 : 1);
      }
      return;
    }
    if (e.button !== 0) return;
    const regionEl = (e.target as HTMLElement).closest<HTMLElement>('[data-region]');
    if (regionEl && selClip && !selected!.track.locked) {
      const region = selClip.regions?.find((r) => r.id === regionEl.dataset.region);
      if (!region) return;
      useEditor.getState().selectRegion(region.id);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      beginGesture();
      regionDrag.current = {
        clipId: selClip.id,
        regionId: region.id,
        handle: ((e.target as HTMLElement).dataset.rhandle as RegionHandle) ?? 'move',
        startX: pt.x,
        startY: pt.y,
        orig: { ...region },
        box: { ...selClip.transform },
      };
      return;
    }
    const handle = (e.target as HTMLElement).dataset.handle as Handle | undefined;
    let clip: Clip | undefined;
    if (handle && selClip) {
      clip = selClip;
    } else {
      const stack = visibleClipsAt(project, time).reverse();
      clip = stack.find(({ clip, track }) => !track.locked && hitTest(clip, pt.x, pt.y))?.clip;
      select(clip?.id ?? null);
    }
    if (!clip) return;
    const f = findClip(project, clip.id)!;
    if (f.track.locked) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    beginGesture();
    drag.current = {
      handle: handle ?? 'move',
      clipId: clip.id,
      startX: pt.x,
      startY: pt.y,
      orig: { ...clip.transform },
      keepAspect: (clip.type === 'video' || clip.type === 'image') !== e.shiftKey,
    };
  }

  function onPointerMove(e: React.PointerEvent) {
    const rd = regionDrag.current;
    if (rd) {
      // Pointer delta in the clip's own (unrotated) frame, as a fraction of its size.
      const pt = toProject(e);
      const a = (rd.box.rotation * Math.PI) / 180;
      const dx = pt.x - rd.startX, dy = pt.y - rd.startY;
      const nx = (dx * Math.cos(a) + dy * Math.sin(a)) / rd.box.width;
      const ny = (-dx * Math.sin(a) + dy * Math.cos(a)) / rd.box.height;
      const o = rd.orig;
      let patch: Partial<Region>;
      if (rd.handle === 'move') patch = { x: o.x + nx, y: o.y + ny };
      else {
        const west = rd.handle.includes('w'), north = rd.handle.includes('n');
        patch = {
          x: west ? Math.min(o.x + nx, o.x + o.width - 0.01) : o.x,
          width: west ? o.width - nx : o.width + nx,
          y: north ? Math.min(o.y + ny, o.y + o.height - 0.01) : o.y,
          height: north ? o.height - ny : o.height + ny,
        };
      }
      dispatch({ type: 'updateRegion', clipId: rd.clipId, regionId: rd.regionId, patch }, { merge: true });
      return;
    }
    const d = drag.current;
    if (!d) return;
    const pt = toProject(e);
    const dx = pt.x - d.startX;
    const dy = pt.y - d.startY;
    const o = d.orig;
    let next: Partial<Transform> = {};
    const snapDist = SNAP / scale;

    if (d.handle === 'move') {
      let x = o.x + dx, y = o.y + dy;
      const g: { v?: number; h?: number } = {};
      // Snap the box centre and edges to the canvas centre and edges.
      const xs = [[x + o.width / 2, W / 2, -o.width / 2], [x, 0, 0], [x + o.width, W, -o.width]] as const;
      for (const [val, target, off] of xs) if (Math.abs(val - target) < snapDist) { x = target + off; g.v = target; break; }
      const ys = [[y + o.height / 2, H / 2, -o.height / 2], [y, 0, 0], [y + o.height, H, -o.height]] as const;
      for (const [val, target, off] of ys) if (Math.abs(val - target) < snapDist) { y = target + off; g.h = target; break; }
      setGuides(g);
      next = { x: Math.round(x), y: Math.round(y) };
    } else if (d.handle === 'rotate') {
      const cx = o.x + o.width / 2, cy = o.y + o.height / 2;
      let deg = (Math.atan2(pt.y - cy, pt.x - cx) * 180) / Math.PI + 90;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      else for (const s of [0, 90, 180, 270, 360, -90]) if (Math.abs(deg - s) < 4) deg = s;
      next = { rotation: Math.round(deg) };
    } else {
      // Resize in the box's own (unrotated) frame, anchored at the opposite side.
      const a = (o.rotation * Math.PI) / 180;
      const lx = dx * Math.cos(a) + dy * Math.sin(a);
      const ly = -dx * Math.sin(a) + dy * Math.cos(a);
      const hx = d.handle.includes('e') ? 1 : d.handle.includes('w') ? -1 : 0;
      const hy = d.handle.includes('s') ? 1 : d.handle.includes('n') ? -1 : 0;
      let w = Math.max(10, o.width + hx * lx);
      let h = Math.max(10, o.height + hy * ly);
      if (d.keepAspect && hx && hy) {
        const k = Math.max(w / o.width, h / o.height);
        w = o.width * k;
        h = o.height * k;
      }
      // Keep the anchor (opposite edge/corner) fixed in canvas space.
      const dw = w - o.width, dh = h - o.height;
      const shiftLX = (hx * dw) / 2, shiftLY = (hy * dh) / 2;
      const cx = o.x + o.width / 2 + shiftLX * Math.cos(a) - shiftLY * Math.sin(a);
      const cy = o.y + o.height / 2 + shiftLX * Math.sin(a) + shiftLY * Math.cos(a);
      next = { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: Math.round(w), height: Math.round(h) };
    }
    dispatch({ type: 'updateTransform', clipId: d.clipId, transform: next }, { merge: true });
  }

  function onPointerUp() {
    drag.current = null;
    regionDrag.current = null;
    setGuides({});
  }

  const end = projectDuration(project);
  const t = selClip?.transform;

  return (
    <div className="preview">
      <div className="preview-stage" ref={wrapRef} onPointerDown={(e) => e.target === e.currentTarget && select(null)}>
        <div
          className="canvas-wrap"
          style={{ width: cssW, height: cssH }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => pickMode && e.preventDefault()}
          data-picking={pickMode && selClip?.id === pickMode.clipId ? '' : undefined}
        >
          <canvas ref={canvasRef} width={Math.round(cssW * dpr)} height={Math.round(cssH * dpr)} style={{ width: cssW, height: cssH }} />
          {guides.v !== undefined && <div className="guide v" style={{ left: guides.v * scale }} />}
          {guides.h !== undefined && <div className="guide h" style={{ top: guides.h * scale }} />}
          {selVisible && t && (
            <div
              className={`selection ${selected!.track.locked ? 'locked' : ''}`}
              style={{
                left: t.x * scale,
                top: t.y * scale,
                width: t.width * scale,
                height: t.height * scale,
                transform: `rotate(${t.rotation}deg)`,
              }}
            >
              {overlay && overlay.clipId === selClip.id && <canvas ref={overlayRef} className="object-overlay" />}
              {selClip.regions?.map((rg) => (
                <div
                  key={rg.id}
                  className={`region ${rg.kind} ${rg.id === selectedRegionId ? 'sel' : ''} ${regionActiveAt(rg, selClip, time) ? '' : 'inactive'}`}
                  style={{ left: `${rg.x * 100}%`, top: `${rg.y * 100}%`, width: `${rg.width * 100}%`, height: `${rg.height * 100}%` }}
                  data-region={rg.id}
                  data-rhandle="move"
                  title={`${REGION_LABEL[rg.kind]} — drag to move, corners to resize`}
                >
                  <span className="region-label">{REGION_LABEL[rg.kind]}</span>
                  {!selected!.track.locked && (['nw', 'ne', 'sw', 'se'] as const).map((h) => (
                    <div key={h} className={`rhandle ${h}`} data-region={rg.id} data-rhandle={h} />
                  ))}
                </div>
              ))}
              {!selected!.track.locked && (
                <>
                  {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map((h) => (
                    <div key={h} className={`handle ${h}`} data-handle={h} />
                  ))}
                  <div className="rotate-stem" />
                  <div className="handle rotate" data-handle="rotate" title="Rotate (Shift = 15° steps)" />
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="transport">
        <button className="icon" title="Go to start (Home)" onClick={() => setTime(0)}>⏮</button>
        <button className="icon play" title="Play / pause (Space)" onClick={() => setPlaying(!playing)} disabled={!end}>
          {playing ? '⏸' : '▶'}
        </button>
        <button className="icon" title="Go to end (End)" onClick={() => setTime(end)}>⏭</button>
        <span className="timecode">{formatTime(time)} / {formatTime(end)}</span>
        <span className="muted small">{W}×{H} · {project.settings.fps} fps · {Math.round(scale * 100)}%</span>
      </div>
    </div>
  );
}
