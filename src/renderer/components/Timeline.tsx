import { useRef, useState } from 'react';
import { clipEnd, findClip, getMedia, projectDuration, type Clip, type EditCommand } from '../../engine';
import { useEditor } from '../store';
import { CLIP_COLORS, formatTime } from '../util';

const HEADER_W = 170;
const ROW_H = 48;
const SNAP_PX = 8;

type Mode = 'move' | 'trim-l' | 'trim-r';

interface ClipDrag {
  mode: Mode;
  clip: Clip;
  trackId: string;
  startX: number;
  startY: number;
  moved: boolean;
}

export function Timeline() {
  const project = useEditor((s) => s.project);
  const time = useEditor((s) => s.time);
  const zoom = useEditor((s) => s.zoom);
  const selectedId = useEditor((s) => s.selectedId);
  const { dispatch, beginGesture, select, setTime, setZoom, setPlaying } = useEditor.getState();

  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef<ClipDrag | null>(null);
  const [ghost, setGhost] = useState<{ clipId: string; start: number; duration: number; trackId: string } | null>(null);

  const duration = projectDuration(project);
  const span = Math.max(duration + 10, 30);
  const width = span * zoom;
  // Top layer first, like a layers panel.
  const rows = [...project.tracks].reverse();

  const xToTime = (clientX: number) => {
    const r = scrollRef.current!.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + scrollRef.current!.scrollLeft - HEADER_W) / zoom);
  };

  function snap(t: number, ignoreId: string) {
    const points = [0, time];
    for (const tr of project.tracks) for (const c of tr.clips) if (c.id !== ignoreId) points.push(c.start, clipEnd(c));
    let best = t, bestD = SNAP_PX / zoom;
    for (const p of points) if (Math.abs(p - t) < bestD) { best = p; bestD = Math.abs(p - t); }
    return best;
  }

  // ---- playhead scrubbing
  function scrubStart(e: React.PointerEvent) {
    setPlaying(false);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setTime(xToTime(e.clientX));
  }
  function scrubMove(e: React.PointerEvent) {
    if (e.buttons === 1) setTime(xToTime(e.clientX));
  }

  // ---- clip dragging
  function clipDown(e: React.PointerEvent, clip: Clip, trackId: string, mode: Mode) {
    e.stopPropagation();
    if (e.button !== 0) return;
    select(clip.id);
    const track = project.tracks.find((t) => t.id === trackId)!;
    if (track.locked) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, clip, trackId, startX: e.clientX, startY: e.clientY, moved: false };
  }

  function clipMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dt = (e.clientX - d.startX) / zoom;
    if (!d.moved && Math.abs(e.clientX - d.startX) < 3 && Math.abs(e.clientY - d.startY) < 3) return;
    d.moved = true;
    const c = d.clip;
    if (d.mode === 'move') {
      let start = Math.max(0, c.start + dt);
      const snappedStart = snap(start, c.id);
      const snappedEnd = snap(start + c.duration, c.id) - c.duration;
      start = snappedStart !== start ? snappedStart : snappedEnd !== start ? Math.max(0, snappedEnd) : start;
      // Vertical: find the row under the pointer, if compatible.
      const rowIdx = Math.floor((e.clientY - scrollRef.current!.getBoundingClientRect().top - 28 + scrollRef.current!.scrollTop) / ROW_H);
      const row = rows[rowIdx];
      const ok = row && !row.locked && (row.kind === 'audio') === (c.type === 'audio');
      setGhost({ clipId: c.id, start, duration: c.duration, trackId: ok ? row.id : d.trackId });
    } else if (d.mode === 'trim-l') {
      const isTimed = c.type === 'video' || c.type === 'audio';
      let start = snap(c.start + dt, c.id);
      start = Math.min(start, clipEnd(c) - 0.1);
      if (isTimed) start = Math.max(start, c.start - c.inPoint);
      start = Math.max(0, start);
      setGhost({ clipId: c.id, start, duration: clipEnd(c) - start, trackId: d.trackId });
    } else {
      const media = getMedia(project, c.mediaId);
      let end = snap(clipEnd(c) + dt, c.id);
      end = Math.max(end, c.start + 0.1);
      if ((c.type === 'video' || c.type === 'audio') && media) end = Math.min(end, c.start + media.duration - c.inPoint);
      setGhost({ clipId: c.id, start: c.start, duration: end - c.start, trackId: d.trackId });
    }
  }

  function clipUp() {
    const d = drag.current;
    drag.current = null;
    if (!d || !ghost || !d.moved) {
      setGhost(null);
      return;
    }
    const c = d.clip;
    const cmds: EditCommand[] = [];
    if (d.mode === 'move') {
      cmds.push({ type: 'moveClip', clipId: c.id, start: ghost.start, trackId: ghost.trackId });
    } else {
      const delta = d.mode === 'trim-l' ? ghost.start - c.start : 0;
      const timed = c.type === 'video' || c.type === 'audio';
      cmds.push({ type: 'trimClip', clipId: c.id, start: ghost.start, duration: ghost.duration, inPoint: timed ? c.inPoint + delta : 0 });
    }
    dispatch(cmds);
    setGhost(null);
  }

  // ---- drop media from the media panel
  function onDrop(e: React.DragEvent, trackId?: string) {
    const mediaId = e.dataTransfer.getData('application/x-one-media');
    if (!mediaId) return;
    e.preventDefault();
    e.stopPropagation();
    const media = getMedia(project, mediaId);
    const track = project.tracks.find((t) => t.id === trackId);
    const fits = track && !track.locked && (track.kind === 'audio') === (media?.kind === 'audio');
    const clipId = `clip_${Date.now().toString(36)}`;
    if (dispatch({ type: 'addClipFromMedia', mediaId, start: snap(xToTime(e.clientX), ''), trackId: fits ? trackId : undefined, clipId })) select(clipId);
  }

  const sel = selectedId ? findClip(project, selectedId) : undefined;
  const ticks = tickStep(zoom);

  return (
    <div className="timeline">
      <div className="timeline-toolbar">
        <button onClick={() => sel && dispatch({ type: 'splitClip', clipId: sel.clip.id, at: time })} disabled={!sel} title="Split at playhead (S)">✂ Split</button>
        <button onClick={() => sel && dispatch({ type: 'duplicateClip', clipId: sel.clip.id })} disabled={!sel} title="Duplicate (Ctrl+D)">⧉ Duplicate</button>
        <button onClick={() => sel && dispatch({ type: 'deleteClip', clipId: sel.clip.id })} disabled={!sel} title="Delete (Del)">🗑 Delete</button>
        <span className="sep" />
        <button onClick={() => dispatch({ type: 'addTrack', kind: 'visual', name: 'Layer' })}>＋ Layer</button>
        <button onClick={() => dispatch({ type: 'addTrack', kind: 'audio', name: 'Audio', index: 0 })}>＋ Audio track</button>
        <span className="grow" />
        <span className="muted small">Zoom</span>
        <input type="range" min={10} max={400} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
      </div>
      <div className="timeline-scroll" ref={scrollRef} onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e)}>
        <div className="timeline-inner" style={{ width: width + HEADER_W }}>
          <div className="ruler" style={{ paddingLeft: HEADER_W }} onPointerDown={scrubStart} onPointerMove={scrubMove}>
            {Array.from({ length: Math.ceil(span / ticks) + 1 }, (_, i) => (
              <div key={i} className="tick" style={{ left: HEADER_W + i * ticks * zoom }}>
                <span>{formatTime(i * ticks).replace(/\.\d+$/, '')}</span>
              </div>
            ))}
          </div>
          {rows.length === 0 && (
            <div className="timeline-empty" style={{ marginLeft: HEADER_W }}>
              Drag media here, or pick a template to start
            </div>
          )}
          {rows.map((track) => (
            <div key={track.id} className={`track ${track.kind} ${track.hidden ? 'is-hidden' : ''}`} style={{ height: ROW_H }}>
              <div className="track-header" style={{ width: HEADER_W }}>
                <input
                  className="track-name"
                  value={track.name}
                  onFocus={beginGesture}
                  onChange={(e) => dispatch({ type: 'updateTrack', trackId: track.id, patch: { name: e.target.value } }, { merge: true })}
                />
                {track.kind === 'visual' && (
                  <button className={`icon tiny ${track.hidden ? 'off' : ''}`} title={track.hidden ? 'Show layer' : 'Hide layer'}
                    onClick={() => dispatch({ type: 'updateTrack', trackId: track.id, patch: { hidden: !track.hidden } })}>{track.hidden ? '◌' : '👁'}</button>
                )}
                <button className={`icon tiny ${track.muted ? 'off' : ''}`} title={track.muted ? 'Unmute' : 'Mute'}
                  onClick={() => dispatch({ type: 'updateTrack', trackId: track.id, patch: { muted: !track.muted } })}>{track.muted ? '🔇' : '🔊'}</button>
                <button className={`icon tiny ${track.locked ? 'on' : ''}`} title={track.locked ? 'Unlock' : 'Lock'}
                  onClick={() => dispatch({ type: 'updateTrack', trackId: track.id, patch: { locked: !track.locked } })}>{track.locked ? '🔒' : '🔓'}</button>
                <button className="icon tiny" title="Delete track"
                  onClick={() => dispatch({ type: 'deleteTrack', trackId: track.id })}>✕</button>
              </div>
              <div className="track-lane" onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, track.id)}
                onPointerDown={(e) => { if (e.target === e.currentTarget) { select(null); scrubStart(e); } }}
                onPointerMove={(e) => e.target === e.currentTarget && scrubMove(e)}>
                {track.clips.map((c) => {
                  const g = ghost?.clipId === c.id ? ghost : null;
                  if (g && g.trackId !== track.id) return null;
                  return <ClipBlock key={c.id} clip={c} start={g?.start ?? c.start} duration={g?.duration ?? c.duration} zoom={zoom}
                    selected={c.id === selectedId} locked={track.locked}
                    onDown={(e, mode) => clipDown(e, c, track.id, mode)} onMove={clipMove} onUp={clipUp} />;
                })}
                {ghost && ghost.trackId === track.id && !track.clips.some((c) => c.id === ghost.clipId) && (() => {
                  const c = findClip(project, ghost.clipId)?.clip;
                  return c ? <ClipBlock clip={c} start={ghost.start} duration={ghost.duration} zoom={zoom} selected locked={false} ghost /> : null;
                })()}
              </div>
            </div>
          ))}
          <div className="playhead" style={{ left: HEADER_W + time * zoom }} />
        </div>
      </div>
    </div>
  );
}

function ClipBlock(props: {
  clip: Clip; start: number; duration: number; zoom: number; selected: boolean; locked: boolean; ghost?: boolean;
  onDown?: (e: React.PointerEvent, mode: Mode) => void; onMove?: (e: React.PointerEvent) => void; onUp?: () => void;
}) {
  const { clip, zoom } = props;
  const label = clip.type === 'text' ? clip.text?.text : clip.name;
  return (
    <div
      className={`clip ${props.selected ? 'selected' : ''} ${props.ghost ? 'ghost' : ''} ${clip.placeholder ? 'placeholder' : ''}`}
      style={{ left: props.start * zoom, width: Math.max(4, props.duration * zoom), background: CLIP_COLORS[clip.type] }}
      onPointerDown={(e) => props.onDown?.(e, 'move')}
      onPointerMove={props.onMove}
      onPointerUp={props.onUp}
      title={`${clip.name} · ${formatTime(props.start)} → ${formatTime(props.start + props.duration)}`}
    >
      {!props.locked && <div className="trim l" onPointerDown={(e) => props.onDown?.(e, 'trim-l')} onPointerMove={props.onMove} onPointerUp={props.onUp} />}
      <span className="clip-label">{clip.placeholder ? '＋ ' : ''}{label}</span>
      {!props.locked && <div className="trim r" onPointerDown={(e) => props.onDown?.(e, 'trim-r')} onPointerMove={props.onMove} onPointerUp={props.onUp} />}
    </div>
  );
}

function tickStep(zoom: number) {
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60]) if (s * zoom >= 60) return s;
  return 120;
}
