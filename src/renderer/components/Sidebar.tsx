import { useEffect, useRef, useState } from 'react';
import { TEMPLATES, type EditCommand, type MediaAsset, type Template } from '../../engine';
import { api } from '../platform';
import { drawFrame } from '../render';
import { useEditor } from '../store';
import { formatTime } from '../util';
import { AiPanel } from './AiPanel';

type Tab = 'media' | 'templates' | 'text' | 'elements' | 'ai';

const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: 'media', icon: '🎞', label: 'Media' },
  { id: 'templates', icon: '▦', label: 'Templates' },
  { id: 'text', icon: 'T', label: 'Text' },
  { id: 'elements', icon: '◆', label: 'Shapes' },
  { id: 'ai', icon: '✦', label: 'AI' },
];

export function Sidebar() {
  const [tab, setTab] = useState<Tab>('media');
  return (
    <aside className="sidebar">
      <nav className="sidebar-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)} title={t.label}>
            <span className="tab-icon">{t.icon}</span>
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-body">
        {tab === 'media' && <MediaPanel />}
        {tab === 'templates' && <TemplatesPanel />}
        {tab === 'text' && <TextPanel />}
        {tab === 'elements' && <ElementsPanel />}
        {tab === 'ai' && <AiPanel />}
      </div>
    </aside>
  );
}

export async function importMedia() {
  const assets = await api.openMedia();
  useEditor.getState().addMedia(assets);
}

function addToTimeline(asset: MediaAsset) {
  const s = useEditor.getState();
  const clipId = `clip_${Date.now().toString(36)}`;
  if (s.dispatch({ type: 'addClipFromMedia', mediaId: asset.id, start: s.time, clipId })) s.select(clipId);
}

function MediaPanel() {
  const media = useEditor((s) => s.project.media);
  const project = useEditor((s) => s.project);
  const used = new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.mediaId)));
  return (
    <div className="panel">
      <h3>Media</h3>
      <button className="primary wide" onClick={importMedia}>＋ Import video, image or audio</button>
      <p className="hint">Or drag files anywhere onto the window. Drag an item onto the timeline, or double-click to add it at the playhead.</p>
      <div className="media-grid">
        {media.map((m) => (
          <div
            key={m.id}
            className="media-item"
            draggable
            onDragStart={(e) => e.dataTransfer.setData('application/x-one-media', m.id)}
            onDoubleClick={() => addToTimeline(m)}
            title={m.name}
          >
            <div className="thumb">
              {m.kind === 'image' && <img src={api.mediaUrl(m.path)} alt="" />}
              {m.kind === 'video' && <video src={api.mediaUrl(m.path) + '#t=0.5'} muted preload="metadata" />}
              {m.kind === 'audio' && <span className="audio-icon">♪</span>}
              {m.duration > 0 && <span className="badge">{formatTime(m.duration).replace(/\.\d+$/, '')}</span>}
            </div>
            <div className="media-name">{m.name}</div>
            <div className="media-actions">
              <button className="tiny" onClick={() => addToTimeline(m)}>Add</button>
              {!used.has(m.id) && (
                <button className="tiny" onClick={() => useEditor.getState().dispatch({ type: 'removeMedia', mediaId: m.id })}>Remove</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TemplateThumb({ template }: { template: Template }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const p = template.build();
    const c = ref.current!;
    const k = c.width / p.settings.width;
    c.height = Math.round(p.settings.height * k);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawFrame(ctx, p, 2.5, () => null, { placeholders: true });
  }, [template]);
  return <canvas ref={ref} width={240} />;
}

function TemplatesPanel() {
  const { load, toast } = useEditor.getState();
  const categories = [...new Set(TEMPLATES.map((t) => t.category))];
  const use = (t: Template) => {
    if (useEditor.getState().dirty && !confirm('Replace the current project with this template? Unsaved changes will be lost.')) return;
    load(t.build());
    toast(`Template “${t.name}” loaded. Select a ＋ slot and use “Replace media” to drop in your own footage.`);
  };
  return (
    <div className="panel">
      <h3>Templates</h3>
      <p className="hint">Every template is made of editable layers. Change any text, colour or position, and replace the ＋ slots with your media.</p>
      {categories.map((cat) => (
        <div key={cat}>
          <h4>{cat}</h4>
          <div className="template-grid">
            {TEMPLATES.filter((t) => t.category === cat).map((t) => (
              <button key={t.id} className="template" onClick={() => use(t)} title={t.description}>
                <TemplateThumb template={t} />
                <span>{t.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const TEXT_PRESETS: { label: string; cmd: Omit<Extract<EditCommand, { type: 'addText' }>, 'type'> }[] = [
  { label: 'Heading', cmd: { text: 'Add a heading', style: { fontSize: 120, fontWeight: 'bold' } } },
  { label: 'Subheading', cmd: { text: 'Add a subheading', style: { fontSize: 64, fontWeight: 'bold' } } },
  { label: 'Body text', cmd: { text: 'Add a little bit of body text', style: { fontSize: 44, fontWeight: 'normal' } } },
  { label: 'Caption box', cmd: { text: 'Caption', style: { fontSize: 56, background: '#000000aa' } } },
  { label: 'Highlight', cmd: { text: 'SALE 50% OFF', style: { fontSize: 80, color: '#111111', background: '#ffd60a' } } },
];

function TextPanel() {
  const add = (cmd: (typeof TEXT_PRESETS)[number]['cmd']) => {
    const s = useEditor.getState();
    const clipId = `clip_${Date.now().toString(36)}`;
    const { width: W, height: H } = s.project.settings;
    const h = (cmd.style?.fontSize ?? 96) * 1.6;
    if (s.dispatch({ type: 'addText', ...cmd, clipId, start: s.time, transform: { x: W * 0.1, y: (H - h) / 2, width: W * 0.8, height: h } })) s.select(clipId);
  };
  return (
    <div className="panel">
      <h3>Text</h3>
      {TEXT_PRESETS.map((p) => (
        <button key={p.label} className="text-preset" onClick={() => add(p.cmd)}
          style={{ fontSize: Math.max(13, (p.cmd.style?.fontSize ?? 40) / 4), fontWeight: p.cmd.style?.fontWeight === 'normal' ? 400 : 700,
            background: p.cmd.style?.background || undefined, color: p.cmd.style?.color }}>
          {p.label}
        </button>
      ))}
    </div>
  );
}

function ElementsPanel() {
  const add = (style: Extract<EditCommand, { type: 'addShape' }>['style'], size?: { w: number; h: number }) => {
    const s = useEditor.getState();
    const clipId = `clip_${Date.now().toString(36)}`;
    const { width: W, height: H } = s.project.settings;
    const w = size?.w ?? W * 0.25, h = size?.h ?? W * 0.25;
    if (s.dispatch({ type: 'addShape', clipId, start: s.time, style, transform: { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h } })) s.select(clipId);
  };
  const W = useEditor((s) => s.project.settings.width);
  return (
    <div className="panel">
      <h3>Shapes</h3>
      <div className="shape-grid">
        <button onClick={() => add({ kind: 'rect', fill: '#7c5cff' })}><span className="sw" style={{ background: '#7c5cff' }} />Rectangle</button>
        <button onClick={() => add({ kind: 'rect', fill: '#ff2d55', radius: 40 })}><span className="sw" style={{ background: '#ff2d55', borderRadius: 6 }} />Rounded</button>
        <button onClick={() => add({ kind: 'ellipse', fill: '#00c2ff' })}><span className="sw" style={{ background: '#00c2ff', borderRadius: '50%' }} />Circle</button>
        <button onClick={() => add({ kind: 'rect', fill: '#00000000', stroke: '#ffffff', strokeWidth: 8, radius: 16 })}><span className="sw" style={{ border: '2px solid #fff' }} />Frame</button>
        <button onClick={() => add({ kind: 'rect', fill: '#ffffff' }, { w: W * 0.4, h: 10 })}><span className="sw line" />Line</button>
        <button onClick={() => add({ kind: 'rect', fill: '#000000aa' }, { w: W, h: W * 0.08 })}><span className="sw" style={{ background: '#0008' }} />Lower bar</button>
      </div>
    </div>
  );
}
