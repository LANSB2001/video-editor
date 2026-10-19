import { useEffect, useRef, useState } from 'react';
import { getMedia, sourceTime, uid, type Clip, type EditCommand, type MediaAsset } from '../../engine';
import type { ObjectAction, VisionInfo, VisionProgress } from '../../shared/api';
import { api } from '../platform';
import { useEditor } from '../store';

const MAX_SECONDS = 30;

type Phase = 'idle' | 'preparing' | 'picking' | 'tracking' | 'tracked' | 'applying';

const STAGE_LABEL: Record<VisionProgress['stage'], string> = {
  prepare: 'Loading frames and the AI model…',
  track: 'Following the object through the clip…',
  fill: 'Rebuilding the background…',
  render: 'Creating the new video…',
};

/**
 * AI object tools for a video clip: click an object to select it, follow it
 * through the clip, then remove / move / cut out / blur / pixelate it.
 * Runs locally (MobileSAM on the CPU) — free and offline.
 */
export function ObjectTools({ clip }: { clip: Clip }) {
  const vision = api.vision;
  const project = useEditor((s) => s.project);
  const time = useEditor((s) => s.time);
  const { dispatch, setObjectOverlay, setPickMode, select, setTime, toast } = useEditor.getState();
  const media = getMedia(project, clip.mediaId);

  const [phase, setPhase] = useState<Phase>('idle');
  const [info, setInfo] = useState<VisionInfo | null>(null);
  const [points, setPoints] = useState<{ x: number; y: number; label: 0 | 1 }[]>([]);
  const [progress, setProgress] = useState<VisionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<string | null>(null);
  const session = useRef<string | null>(null);
  const busy = useRef(false);

  useEffect(() => vision?.onProgress(setProgress), [vision]);

  // Leaving the clip (or unmounting) ends the session.
  useEffect(() => () => {
    if (session.current) vision?.end(session.current);
    session.current = null;
    setObjectOverlay(null);
    setPickMode(null);
  }, [clip.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // After tracking, the overlay follows the playhead.
  useEffect(() => {
    if (phase !== 'tracked' || !info || !session.current || busy.current) return;
    const id = session.current;
    busy.current = true;
    vision!.maskAt(id, sourceTime(clip, time)).then((mask) => {
      busy.current = false;
      if (session.current !== id) return;
      setObjectOverlay(mask ? { clipId: clip.id, mask, width: info.width, height: info.height } : null);
    }).catch(() => (busy.current = false));
  }, [time, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!vision || !media) {
    return (
      <div className="group ai-tools">
        <h4>AI object tools</h4>
        <p className="hint">Available in the desktop app.</p>
      </div>
    );
  }

  const tooLong = clip.duration > MAX_SECONDS;
  const fail = (e: unknown) => {
    const msg = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    setError(msg);
    setProgress(null);
  };

  function reset() {
    if (session.current) vision!.end(session.current);
    session.current = null;
    setInfo(null);
    setPoints([]);
    setCoverage(null);
    setProgress(null);
    setObjectOverlay(null);
    setPickMode(null);
    setPhase('idle');
  }

  async function start() {
    setError(null);
    // Pick on the frame under the playhead; move it into the clip if needed.
    const s = useEditor.getState();
    if (s.time < clip.start || s.time >= clip.start + clip.duration) setTime(clip.start + Math.min(1, clip.duration / 2));
    s.setPlaying(false);
    setPhase('preparing');
    try {
      const inf = await vision!.begin({
        path: media!.path, name: media!.name, width: media!.width, height: media!.height, fps: media!.fps || 30,
        srcStart: clip.inPoint, srcEnd: clip.inPoint + clip.duration,
      });
      session.current = inf.sessionId;
      setInfo(inf);
      setProgress(null);
      setPhase('picking');
      setPickMode({ clipId: clip.id, onPick: (nx, ny, label) => addPoint(inf, { x: nx * inf.width, y: ny * inf.height, label }) });
    } catch (e) {
      fail(e);
      setPhase('idle');
    }
  }

  // Points accumulate; each click re-runs the (fast) decoder.
  const pointsRef = useRef(points);
  pointsRef.current = points;
  async function addPoint(inf: VisionInfo, p: { x: number; y: number; label: 0 | 1 }) {
    const next = [...pointsRef.current, p];
    setPoints(next);
    await runSelect(inf, next);
  }

  async function runSelect(inf: VisionInfo, pts: typeof points) {
    if (!session.current) return;
    setError(null);
    setCoverage(null);
    if (!pts.some((p) => p.label === 1)) { setObjectOverlay(null); return; }
    try {
      const st = sourceTime(clip, useEditor.getState().time);
      const r = await vision!.select(session.current, st, pts);
      setObjectOverlay({ clipId: clip.id, mask: r.mask, width: r.width, height: r.height });
      if (!r.area) setError('Nothing found there — try clicking right on the object.');
      setPhase('picking');
    } catch (e) {
      fail(e);
    }
  }

  async function undoPoint() {
    const next = points.slice(0, -1);
    setPoints(next);
    if (info) await runSelect(info, next);
  }

  async function track() {
    if (!session.current || !info) return;
    setError(null);
    setPickMode(null);
    setPhase('tracking');
    try {
      const r = await vision!.track(session.current);
      const toSec = (i: number) => (i / info.fps).toFixed(1);
      const whole = r.first === 0 && r.last === r.frameCount - 1;
      setCoverage(whole
        ? 'Found in the whole clip.'
        : `Found from ${toSec(r.first)}s to ${toSec(r.last + 1)}s of this clip (it leaves the frame or gets hidden outside that).`);
      setProgress(null);
      setPhase('tracked');
    } catch (e) {
      fail(e);
      setPhase('picking');
      setPickMode({ clipId: clip.id, onPick: (nx, ny, label) => addPoint(info, { x: nx * info.width, y: ny * info.height, label }) });
    }
  }

  async function apply(kind: ObjectAction | 'move') {
    if (!session.current) return;
    setError(null);
    setPhase('applying');
    try {
      const id = session.current;
      const cmds: EditCommand[] = [];
      let selectId: string | null = null;
      const addCutout = (asset: MediaAsset) => {
        const clipId = uid('clip');
        cmds.push(
          { type: 'addMedia', asset },
          { type: 'addClipFromMedia', mediaId: asset.id, start: clip.start, clipId },
          { type: 'updateTransform', clipId, transform: clip.transform },
        );
        selectId = clipId;
      };
      if (kind === 'cutout') {
        addCutout(await vision!.apply(id, 'cutout'));
      } else {
        const action: ObjectAction = kind === 'move' ? 'remove' : kind;
        // For "move", cut the object out first (from the original pixels).
        const cut = kind === 'move' ? await vision!.apply(id, 'cutout') : null;
        const asset = await vision!.apply(id, action);
        cmds.push({ type: 'addMedia', asset }, { type: 'replaceMedia', clipId: clip.id, mediaId: asset.id });
        if (cut) addCutout(cut);
      }
      reset();
      if (dispatch(cmds)) {
        if (selectId) select(selectId);
        toast({
          remove: 'Object removed. Ctrl+Z to undo.',
          move: 'Object cut out onto its own layer. Drag it to its new place.',
          cutout: 'Object copied onto a new layer above. Drag it anywhere.',
          blur: 'Object blurred — the blur follows it as it moves.',
          pixelate: 'Object pixelated — it follows the object as it moves.',
        }[kind]);
      }
    } catch (e) {
      fail(e);
      setPhase('tracked');
    }
  }

  const pct = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;
  const stepClass = (n: number) => {
    const at = phase === 'idle' || phase === 'preparing' ? 0 : phase === 'picking' ? (points.some((p) => p.label) ? 1 : 0) : phase === 'tracking' ? 1 : 2;
    return n < at ? 'done' : n === at ? 'now' : '';
  };

  return (
    <div className="group ai-tools">
      <h4>AI object tools <span className="badge-free">free · runs on this PC</span></h4>
      {phase === 'idle' && (
        <>
          <p className="hint">Select something in the video — a person, product, phone, car — then remove it, move it, cut it out or blur it.</p>
          <button className="primary wide" onClick={start} disabled={tooLong}>✦ Select an object</button>
          {tooLong && <p className="hint">Works on up to {MAX_SECONDS}s at a time. Split this clip (S) and select the part you need.</p>}
        </>
      )}

      {phase !== 'idle' && (
        <ol className="steps">
          <li className={stepClass(0)}>Click on the object in the video</li>
          <li className={stepClass(1)}>Follow it through the clip</li>
          <li className={stepClass(2)}>Choose what to do with it</li>
        </ol>
      )}

      {phase === 'picking' && (
        <>
          <p className="hint">Click the object on the canvas. Click more spots to add parts; <b>Alt+click</b> or right-click to exclude parts.</p>
          <div className="row">
            <button className="primary" onClick={track} disabled={!points.some((p) => p.label === 1)}>Follow through clip →</button>
            <button onClick={undoPoint} disabled={!points.length}>Undo click</button>
            <button onClick={reset}>Cancel</button>
          </div>
        </>
      )}

      {(phase === 'preparing' || phase === 'tracking' || phase === 'applying') && (
        <div className="status">
          <p>{progress ? STAGE_LABEL[progress.stage] : phase === 'applying' ? 'Working…' : 'Starting…'}</p>
          <div className="progress"><div style={{ width: `${pct}%` }} /></div>
          {phase === 'tracking' && <button className="tiny" onClick={() => session.current && vision!.cancel(session.current)}>Cancel</button>}
        </div>
      )}

      {phase === 'tracked' && (
        <>
          {coverage && <p className="status ok">✓ {coverage} Scrub the timeline to check the outline.</p>}
          <div className="actions-grid">
            <button className="primary" onClick={() => apply('remove')} title="Erase it and rebuild the background behind it">Remove object</button>
            <button onClick={() => apply('move')} title="Cut it out onto its own layer and fill the hole, so you can drag it elsewhere">Move object</button>
            <button onClick={() => apply('cutout')} title="Copy it onto a transparent layer above">Cut out to layer</button>
            <button onClick={() => apply('blur')}>Blur object</button>
            <button onClick={() => apply('pixelate')}>Pixelate object</button>
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <button className="tiny" onClick={() => { setPhase('picking'); setPickMode({ clipId: clip.id, onPick: (nx, ny, label) => info && addPoint(info, { x: nx * info.width, y: ny * info.height, label }) }); }}>Adjust selection</button>
            <button className="tiny" onClick={reset}>Start over</button>
          </div>
          <p className="hint">Background rebuilding works best when the camera is still and the object moves. A new video file is created; the original stays in Media.</p>
        </>
      )}

      {error && <p className="warn">{error}</p>}
    </div>
  );
}
