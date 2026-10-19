import { useState } from 'react';
import {
  ASPECT_PRESETS, findClip, getMedia, sourceTime, timelineTime,
  type AnimationKind, type Clip, type EditCommand, type Region, type RegionKind, type Track,
} from '../../engine';
import { useEditor } from '../store';
import { ObjectTools } from './ObjectTools';
import { CLIP_COLORS, formatTime } from '../util';
import { api } from '../platform';

const FONTS = ['Inter, Segoe UI, Arial, sans-serif', 'Arial', 'Arial Black', 'Impact', 'Georgia', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Courier New', 'Comic Sans MS'];
const ANIMS: { id: AnimationKind; label: string }[] = [
  { id: 'none', label: 'None' }, { id: 'fade', label: 'Fade' },
  { id: 'slide-up', label: 'Slide up' }, { id: 'slide-down', label: 'Slide down' },
  { id: 'slide-left', label: 'Slide left' }, { id: 'slide-right', label: 'Slide right' },
];

/** Right-hand column: layer list on top, properties of the selection below. */
export function Inspector() {
  return (
    <aside className="inspector">
      <LayersPanel />
      <Properties />
    </aside>
  );
}

function LayersPanel() {
  const project = useEditor((s) => s.project);
  const selectedId = useEditor((s) => s.selectedId);
  const { dispatch, select } = useEditor.getState();
  const [dragId, setDragId] = useState<string | null>(null);
  const visual = project.tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.kind === 'visual').reverse();

  const iconFor = (track: Track) => {
    const c = track.clips[0];
    return c ? ({ video: '🎞', image: '🖼', text: 'T', shape: '◆', audio: '♪' } as const)[c.type] : '▢';
  };

  return (
    <section className="layers">
      <h3>Layers <span className="muted small">top → bottom</span></h3>
      {visual.length === 0 && <p className="hint">No layers yet.</p>}
      <ul>
        {visual.map(({ t, i }) => {
          const active = t.clips.some((c) => c.id === selectedId);
          return (
            <li
              key={t.id}
              className={`${active ? 'active' : ''} ${t.hidden ? 'is-hidden' : ''} ${dragId === t.id ? 'dragging' : ''}`}
              draggable
              onDragStart={() => setDragId(t.id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragId && dragId !== t.id) dispatch({ type: 'reorderTrack', trackId: dragId, index: i }); setDragId(null); }}
              onClick={() => t.clips[0] && select(t.clips.find((c) => c.id === selectedId)?.id ?? t.clips[0].id)}
            >
              <span className="layer-icon" style={{ background: t.clips[0] ? CLIP_COLORS[t.clips[0].type] : '#444' }}>{iconFor(t)}</span>
              <span className="layer-name">{t.clips[0]?.type === 'text' ? t.clips[0].text?.text : t.clips[0]?.name ?? t.name}</span>
              <button className="icon tiny" title="Bring forward" disabled={i === project.tracks.length - 1}
                onClick={(e) => { e.stopPropagation(); dispatch({ type: 'reorderTrack', trackId: t.id, index: i + 1 }); }}>▲</button>
              <button className="icon tiny" title="Send backward" disabled={i === 0}
                onClick={(e) => { e.stopPropagation(); dispatch({ type: 'reorderTrack', trackId: t.id, index: i - 1 }); }}>▼</button>
              <button className={`icon tiny ${t.hidden ? 'off' : ''}`} title={t.hidden ? 'Show' : 'Hide'}
                onClick={(e) => { e.stopPropagation(); dispatch({ type: 'updateTrack', trackId: t.id, patch: { hidden: !t.hidden } }); }}>{t.hidden ? '◌' : '👁'}</button>
              <button className={`icon tiny ${t.locked ? 'on' : ''}`} title={t.locked ? 'Unlock' : 'Lock'}
                onClick={(e) => { e.stopPropagation(); dispatch({ type: 'updateTrack', trackId: t.id, patch: { locked: !t.locked } }); }}>{t.locked ? '🔒' : '🔓'}</button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ fields

function Num(props: { label: string; value: number; step?: number; min?: number; max?: number; onChange: (v: number) => void; suffix?: string }) {
  const { beginGesture } = useEditor.getState();
  return (
    <label className="field num">
      <span>{props.label}</span>
      <input
        type="number"
        value={Number(props.value.toFixed(2))}
        step={props.step ?? 1}
        min={props.min}
        max={props.max}
        onFocus={beginGesture}
        onChange={(e) => e.target.value !== '' && props.onChange(Number(e.target.value))}
      />
      {props.suffix && <em>{props.suffix}</em>}
    </label>
  );
}

function Slider(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; reset?: number }) {
  const { beginGesture } = useEditor.getState();
  return (
    <label className="field slider">
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value}
        onPointerDown={beginGesture} onChange={(e) => props.onChange(Number(e.target.value))}
        onDoubleClick={() => props.reset !== undefined && props.onChange(props.reset)} />
      <em>{props.value.toFixed(2)}</em>
    </label>
  );
}

function Color(props: { label: string; value: string; onChange: (v: string) => void; allowNone?: boolean }) {
  const { beginGesture } = useEditor.getState();
  const hex = /^#[0-9a-f]{6}/i.test(props.value) ? props.value.slice(0, 7) : '#000000';
  return (
    <label className="field color">
      <span>{props.label}</span>
      <input type="color" value={hex} onFocus={beginGesture} onClick={beginGesture} onChange={(e) => props.onChange(e.target.value + (props.value.length === 9 ? props.value.slice(7) : ''))} />
      <input type="text" value={props.value} onFocus={beginGesture} onChange={(e) => props.onChange(e.target.value)} placeholder={props.allowNone ? 'none' : ''} />
    </label>
  );
}

// ------------------------------------------------------------------ properties

function Properties() {
  const project = useEditor((s) => s.project);
  const selectedId = useEditor((s) => s.selectedId);
  const found = selectedId ? findClip(project, selectedId) : undefined;
  if (!found) return <ProjectSettings />;
  return <ClipProperties clip={found.clip} locked={found.track.locked} />;
}

function ProjectSettings() {
  const project = useEditor((s) => s.project);
  const { dispatch } = useEditor.getState();
  const s = project.settings;
  const preset = Object.entries(ASPECT_PRESETS).find(([, p]) => p.width === s.width && p.height === s.height)?.[0] ?? 'custom';
  const even = (v: number) => Math.max(16, Math.round(v / 2) * 2);
  return (
    <section className="props">
      <h3>Project</h3>
      <label className="field">
        <span>Format</span>
        <select value={preset} onChange={(e) => {
          const p = ASPECT_PRESETS[e.target.value];
          if (p) dispatch({ type: 'updateSettings', settings: { width: p.width, height: p.height } });
        }}>
          {Object.entries(ASPECT_PRESETS).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
          {preset === 'custom' && <option value="custom">Custom</option>}
        </select>
      </label>
      <div className="row">
        <Num label="W" value={s.width} step={2} onChange={(v) => dispatch({ type: 'updateSettings', settings: { width: even(v) } }, { merge: true })} />
        <Num label="H" value={s.height} step={2} onChange={(v) => dispatch({ type: 'updateSettings', settings: { height: even(v) } }, { merge: true })} />
      </div>
      <label className="field">
        <span>Frame rate</span>
        <select value={s.fps} onChange={(e) => dispatch({ type: 'updateSettings', settings: { fps: Number(e.target.value) } })}>
          {[24, 25, 30, 50, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}
        </select>
      </label>
      <Color label="Background" value={s.background} onChange={(v) => dispatch({ type: 'updateSettings', settings: { background: v } }, { merge: true })} />
      <p className="hint">Select a layer on the canvas or timeline to edit it.</p>
    </section>
  );
}

function ClipProperties({ clip, locked }: { clip: Clip; locked: boolean }) {
  const project = useEditor((s) => s.project);
  const { dispatch, beginGesture } = useEditor.getState();
  const d = (cmd: EditCommand) => dispatch(cmd, { merge: true });
  const id = clip.id;
  const t = clip.transform;
  const media = getMedia(project, clip.mediaId);
  const replaceable = clip.type === 'video' || clip.type === 'image' || clip.type === 'audio' || !!clip.placeholder;
  const candidates = project.media.filter((m) => (m.kind === 'audio') === (clip.type === 'audio') && m.id !== clip.mediaId);
  const isVisual = clip.type !== 'audio';

  return (
    <section className={`props ${locked ? 'locked' : ''}`}>
      <h3>
        <span className="type-pill" style={{ background: CLIP_COLORS[clip.type] }}>{clip.type}</span>
        <input className="clip-name" value={clip.name} onFocus={beginGesture} disabled={locked}
          onChange={(e) => d({ type: 'updateClip', clipId: id, patch: { name: e.target.value } })} />
      </h3>
      {locked && <p className="hint">This layer is locked. Unlock it in the Layers list to edit.</p>}
      <fieldset disabled={locked}>
        {clip.placeholder && <p className="placeholder-hint">＋ {clip.placeholder}</p>}

        {replaceable && (
          <label className="field">
            <span>{clip.placeholder ? 'Fill slot' : 'Replace media'}</span>
            <select value="" onChange={(e) => e.target.value && dispatch({ type: 'replaceMedia', clipId: id, mediaId: e.target.value })}>
              <option value="">{candidates.length ? 'Choose from Media…' : 'Import media first'}</option>
              {candidates.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        )}

        {clip.type === 'text' && clip.text && (
          <div className="group">
            <h4>Text</h4>
            <textarea value={clip.text.text} rows={3} onFocus={beginGesture}
              onChange={(e) => d({ type: 'updateText', clipId: id, style: { text: e.target.value } })} />
            <label className="field">
              <span>Font</span>
              <select value={clip.text.fontFamily} onChange={(e) => dispatch({ type: 'updateText', clipId: id, style: { fontFamily: e.target.value } })}>
                {FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f.split(',')[0]}</option>)}
              </select>
            </label>
            <div className="row">
              <Num label="Size" value={clip.text.fontSize} min={4} onChange={(v) => d({ type: 'updateText', clipId: id, style: { fontSize: Math.max(4, v) } })} />
              <div className="seg">
                <button className={clip.text.fontWeight === 'bold' ? 'on' : ''} onClick={() => dispatch({ type: 'updateText', clipId: id, style: { fontWeight: clip.text!.fontWeight === 'bold' ? 'normal' : 'bold' } })}><b>B</b></button>
                <button className={clip.text.italic ? 'on' : ''} onClick={() => dispatch({ type: 'updateText', clipId: id, style: { italic: !clip.text!.italic } })}><i>I</i></button>
                {(['left', 'center', 'right'] as const).map((a) => (
                  <button key={a} className={clip.text!.align === a ? 'on' : ''} onClick={() => dispatch({ type: 'updateText', clipId: id, style: { align: a } })}>
                    {a === 'left' ? '⇤' : a === 'right' ? '⇥' : '↔'}
                  </button>
                ))}
              </div>
            </div>
            <Color label="Colour" value={clip.text.color} onChange={(v) => d({ type: 'updateText', clipId: id, style: { color: v } })} />
            <Color label="Highlight" value={clip.text.background} allowNone onChange={(v) => d({ type: 'updateText', clipId: id, style: { background: v } })} />
          </div>
        )}

        {clip.type === 'shape' && clip.shape && (
          <div className="group">
            <h4>Shape</h4>
            <label className="field">
              <span>Kind</span>
              <select value={clip.shape.kind} onChange={(e) => dispatch({ type: 'updateShape', clipId: id, style: { kind: e.target.value as 'rect' | 'ellipse' } })}>
                <option value="rect">Rectangle</option>
                <option value="ellipse">Ellipse</option>
              </select>
            </label>
            <Color label="Fill" value={clip.shape.fill} onChange={(v) => d({ type: 'updateShape', clipId: id, style: { fill: v } })} />
            <Color label="Border" value={clip.shape.stroke} allowNone onChange={(v) => d({ type: 'updateShape', clipId: id, style: { stroke: v } })} />
            <div className="row">
              <Num label="Border" value={clip.shape.strokeWidth} min={0} onChange={(v) => d({ type: 'updateShape', clipId: id, style: { strokeWidth: Math.max(0, v) } })} />
              <Num label="Radius" value={clip.shape.radius} min={0} onChange={(v) => d({ type: 'updateShape', clipId: id, style: { radius: Math.max(0, v) } })} />
            </div>
          </div>
        )}

        {isVisual && (
          <div className="group">
            <h4>Position & size</h4>
            <div className="row">
              <Num label="X" value={t.x} onChange={(v) => d({ type: 'updateTransform', clipId: id, transform: { x: v } })} />
              <Num label="Y" value={t.y} onChange={(v) => d({ type: 'updateTransform', clipId: id, transform: { y: v } })} />
            </div>
            <div className="row">
              <Num label="W" value={t.width} min={1} onChange={(v) => d({ type: 'updateTransform', clipId: id, transform: { width: v } })} />
              <Num label="H" value={t.height} min={1} onChange={(v) => d({ type: 'updateTransform', clipId: id, transform: { height: v } })} />
            </div>
            <div className="row">
              <Num label="Rotate" value={t.rotation} suffix="°" onChange={(v) => d({ type: 'updateTransform', clipId: id, transform: { rotation: v } })} />
              <Num label="Opacity" value={Math.round(t.opacity * 100)} min={0} max={100} suffix="%" onChange={(v) => d({ type: 'updateTransform', clipId: id, transform: { opacity: v / 100 } })} />
            </div>
            <div className="align-row">
              <span>Align</span>
              {([
                ['⇤', { x: 0 }], ['↔', { x: (project.settings.width - t.width) / 2 }], ['⇥', { x: project.settings.width - t.width }],
                ['⤒', { y: 0 }], ['↕', { y: (project.settings.height - t.height) / 2 }], ['⤓', { y: project.settings.height - t.height }],
              ] as const).map(([icon, tr], i) => (
                <button key={i} className="icon tiny" onClick={() => dispatch({ type: 'updateTransform', clipId: id, transform: tr })}>{icon}</button>
              ))}
              <button className="tiny" title="Fill the canvas" onClick={() => dispatch({ type: 'updateTransform', clipId: id, transform: { x: 0, y: 0, width: project.settings.width, height: project.settings.height, rotation: 0 } })}>Fill</button>
            </div>
          </div>
        )}

        <div className="group">
          <h4>Timing</h4>
          <div className="row">
            <Num label="Start" value={clip.start} step={0.1} min={0} suffix="s" onChange={(v) => d({ type: 'moveClip', clipId: id, start: v })} />
            <Num label="Length" value={clip.duration} step={0.1} min={0.1} suffix="s" onChange={(v) => d({ type: 'trimClip', clipId: id, start: clip.start, duration: v, inPoint: clip.inPoint })} />
          </div>
          {(clip.type === 'video' || clip.type === 'audio') && (
            <Num label="Source in" value={clip.inPoint} step={0.1} min={0} suffix="s" onChange={(v) => d({ type: 'trimClip', clipId: id, start: clip.start, duration: clip.duration, inPoint: v })} />
          )}
          {media && <p className="hint">{media.name}{media.duration ? ` · source ${media.duration.toFixed(1)}s` : ''}{media.width ? ` · ${media.width}×${media.height}` : ''}</p>}
        </div>

        {isVisual && (
          <div className="group">
            <h4>Animation</h4>
            <div className="row">
              <label className="field">
                <span>In</span>
                <select value={clip.animation.in} onChange={(e) => dispatch({ type: 'updateAnimation', clipId: id, animation: { in: e.target.value as AnimationKind } })}>
                  {ANIMS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Out</span>
                <select value={clip.animation.out} onChange={(e) => dispatch({ type: 'updateAnimation', clipId: id, animation: { out: e.target.value as AnimationKind } })}>
                  {ANIMS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </label>
            </div>
            <Slider label="Speed" value={clip.animation.duration} min={0.1} max={3} step={0.1} reset={0.5}
              onChange={(v) => d({ type: 'updateAnimation', clipId: id, animation: { duration: v } })} />
          </div>
        )}

        {clip.type === 'video' && !locked && <ObjectTools clip={clip} />}
        {(clip.type === 'video' || clip.type === 'image') && <RegionsGroup clip={clip} />}

        {(clip.type === 'video' || clip.type === 'image') && (
          <div className="group">
            <h4>Colour</h4>
            <Slider label="Brightness" value={clip.color.brightness} min={-1} max={1} step={0.01} reset={0} onChange={(v) => d({ type: 'updateColor', clipId: id, color: { brightness: v } })} />
            <Slider label="Contrast" value={clip.color.contrast} min={0} max={2} step={0.01} reset={1} onChange={(v) => d({ type: 'updateColor', clipId: id, color: { contrast: v } })} />
            <Slider label="Saturation" value={clip.color.saturation} min={0} max={3} step={0.01} reset={1} onChange={(v) => d({ type: 'updateColor', clipId: id, color: { saturation: v } })} />
            <button className="tiny" onClick={() => dispatch({ type: 'updateColor', clipId: id, color: { brightness: 0, contrast: 1, saturation: 1 } })}>Reset colour</button>
          </div>
        )}

        {(clip.type === 'audio' || (clip.type === 'video' && media?.hasAudio)) && (
          <div className="group">
            <h4>Audio</h4>
            <Slider label="Volume" value={clip.volume} min={0} max={2} step={0.01} reset={1} onChange={(v) => d({ type: 'updateClip', clipId: id, patch: { volume: v } })} />
          </div>
        )}

        <div className="group actions">
          <button onClick={() => dispatch({ type: 'duplicateClip', clipId: id })}>Duplicate</button>
          <button className="danger" onClick={() => dispatch({ type: 'deleteClip', clipId: id })}>Delete</button>
        </div>
      </fieldset>
    </section>
  );
}

const REGION_KINDS: { id: RegionKind; label: string; hint: string }[] = [
  { id: 'remove', label: 'Remove', hint: 'Fill the area from the pixels around it — best for logos, watermarks and small objects on simple backgrounds' },
  { id: 'blur', label: 'Blur', hint: 'Blur faces, number plates or private details' },
  { id: 'pixelate', label: 'Pixelate', hint: 'Cover the area with large pixel blocks' },
];

/** "Fix areas": remove / blur / pixelate rectangles on a video or image layer. */
function RegionsGroup({ clip }: { clip: Clip }) {
  const selectedRegionId = useEditor((s) => s.selectedRegionId);
  const time = useEditor((s) => s.time);
  const { dispatch, beginGesture, selectRegion, toast } = useEditor.getState();
  const regions = clip.regions ?? [];
  const update = (r: Region, patch: Partial<Region>, merge = false) =>
    dispatch({ type: 'updateRegion', clipId: clip.id, regionId: r.id, patch }, { merge });

  function add(kind: RegionKind) {
    const id = `rgn_${Date.now().toString(36)}`;
    if (dispatch({ type: 'addRegion', clipId: clip.id, region: { id, kind } })) selectRegion(id);
  }

  const project = useEditor((s) => s.project);
  const media = getMedia(project, clip.mediaId);
  const [finding, setFinding] = useState<string | null>(null);

  // Times are stored in source seconds; show them in timeline seconds.
  const toTimeline = (s: number) => timelineTime(clip, s);
  const clipSrcStart = sourceTime(clip, clip.start), clipSrcEnd = sourceTime(clip, clip.start + clip.duration);

  /** The screen (shot) under the playhead: between the scene cuts around it. */
  async function thisScreen(r: Region) {
    const at = playheadSource;
    let from = clipSrcStart, to = clipSrcEnd;
    if (api.detectScenes && media && clip.type === 'video') {
      setFinding(r.id);
      try {
        const cuts = await api.detectScenes(media.path);
        from = Math.max(clipSrcStart, ...cuts.filter((c) => c <= at + 1e-3), 0);
        to = Math.min(clipSrcEnd, ...cuts.filter((c) => c > at + 1e-3));
        if (!cuts.length) toast('No screen changes found in this video — the area applies from start to end. Use Start here / End here to adjust.');
      } catch (e) {
        toast(`Could not find screen changes: ${(e as Error).message}`, 'error');
        return;
      } finally {
        setFinding(null);
      }
    }
    beginGesture();
    update(r, { from, to });
  }
  const playheadSource = Math.min(Math.max(sourceTime(clip, time), sourceTime(clip, clip.start)), sourceTime(clip, clip.start + clip.duration));

  return (
    <div className="group">
      <h4>Fix areas</h4>
      <p className="hint">Hide a logo, watermark, face or number plate. Add an area, then drag its box on the canvas over the thing to fix.</p>
      <div className="region-add">
        {REGION_KINDS.map((k) => (
          <button key={k.id} className="tiny" title={k.hint} onClick={() => add(k.id)}>＋ {k.label}</button>
        ))}
      </div>
      {regions.map((r) => {
        const whole = r.from === undefined && r.to === undefined;
        return (
          <div key={r.id} className={`region-row ${r.id === selectedRegionId ? 'sel' : ''}`} onClick={() => selectRegion(r.id)}>
            <div className="row">
              <select value={r.kind} onChange={(e) => update(r, { kind: e.target.value as RegionKind })}>
                {REGION_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
              <label className="check">
                <input type="checkbox" checked={whole} onChange={(e) => (e.target.checked
                  ? update(r, { from: undefined, to: undefined })
                  : thisScreen(r))} />
                Whole clip
              </label>
              <button className="icon tiny" title="Delete area" onClick={(e) => { e.stopPropagation(); dispatch({ type: 'deleteRegion', clipId: clip.id, regionId: r.id }); }}>✕</button>
            </div>
            {r.kind !== 'remove' && (
              <Slider label="Strength" value={r.strength} min={1} max={10} step={1} onChange={(v) => update(r, { strength: v }, true)} />
            )}
            {!whole && (
              <div className="row">
                <Num label="From" value={toTimeline(r.from ?? 0)} step={0.1} suffix="s" onChange={(v) => update(r, { from: sourceTime(clip, v) }, true)} />
                <Num label="To" value={toTimeline(r.to ?? sourceTime(clip, clip.start + clip.duration))} step={0.1} suffix="s" onChange={(v) => update(r, { to: sourceTime(clip, v) }, true)} />
              </div>
            )}
            <div className="row small-actions">
              <button className="tiny" disabled={finding === r.id} title="Only while the screen under the playhead is showing"
                onClick={(e) => { e.stopPropagation(); thisScreen(r); }}>{finding === r.id ? 'Finding screen…' : '▣ This screen only'}</button>
              {!whole && <button className="tiny" onClick={() => { beginGesture(); update(r, { from: playheadSource }); }}>Start here</button>}
              {!whole && <button className="tiny" onClick={() => { beginGesture(); update(r, { to: playheadSource }); }}>End here</button>}
            </div>
            <p className="hint region-when">
              {whole ? 'Active for the whole clip' : `Active ${formatTime(toTimeline(r.from ?? clipSrcStart))} → ${formatTime(toTimeline(r.to ?? clipSrcEnd))}`}
            </p>
          </div>
        );
      })}
      {regions.some((r) => r.kind === 'remove') && (
        <p className="hint">Remove works best on small, still objects over simple backgrounds. AI removal for moving objects is coming next.</p>
      )}
    </div>
  );
}
