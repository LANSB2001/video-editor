// AI editing assistant: natural language → EditCommand[].
//
// Two paths share one action vocabulary (AiAction):
//  * Claude (desktop, with an API key): the model sees a compact layer list and
//    returns actions through the `apply_edits` tool.
//  * Offline rules: a small parser for common phrasings, used when no key is
//    configured or the request fails.
// Either way, actions are validated and converted to EditCommands here, so the
// model can never do anything the editor couldn't do by hand — and every AI
// edit is undoable.

import type { EditCommand } from './commands';
import { CommandError } from './commands';
import { findClip, getMedia } from './project';
import type { AnimationKind, Clip, Project } from './types';

export type AiActionName =
  | 'move' | 'resize' | 'set_text' | 'set_style' | 'delete' | 'hide' | 'show'
  | 'add_text' | 'color_grade' | 'set_animation' | 'set_timing' | 'duplicate' | 'set_volume';

export interface AiAction {
  action: AiActionName;
  clipId?: string;
  x?: number; y?: number; width?: number; height?: number; rotation?: number; opacity?: number;
  text?: string; color?: string; fontSize?: number; fontWeight?: 'normal' | 'bold'; background?: string;
  fill?: string;
  brightness?: number; contrast?: number; saturation?: number;
  animationIn?: AnimationKind; animationOut?: AnimationKind;
  start?: number; duration?: number;
  volume?: number;
}

export interface AiResult {
  commands: EditCommand[];
  reply: string;
  source: 'claude' | 'offline';
}

const ANIMS: AnimationKind[] = ['none', 'fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down'];

/** JSON schema for the `apply_edits` tool given to Claude. */
export const APPLY_EDITS_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'One short sentence telling the user what you changed, or why you could not.' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['move', 'resize', 'set_text', 'set_style', 'delete', 'hide', 'show', 'add_text', 'color_grade', 'set_animation', 'set_timing', 'duplicate', 'set_volume'],
          },
          clipId: { type: 'string', description: 'Target layer id from the layer list. Omit only for add_text.' },
          x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
          rotation: { type: 'number', description: 'Degrees clockwise' },
          opacity: { type: 'number', description: '0..1' },
          text: { type: 'string' },
          color: { type: 'string', description: 'Text colour as #rrggbb' },
          fill: { type: 'string', description: 'Shape fill as #rrggbb or #rrggbbaa' },
          fontSize: { type: 'number' },
          fontWeight: { type: 'string', enum: ['normal', 'bold'] },
          background: { type: 'string', description: 'Text highlight box colour, empty string for none' },
          brightness: { type: 'number', description: '-1..1, 0 = unchanged' },
          contrast: { type: 'number', description: '0..2, 1 = unchanged' },
          saturation: { type: 'number', description: '0..3, 1 = unchanged' },
          animationIn: { type: 'string', enum: ANIMS },
          animationOut: { type: 'string', enum: ANIMS },
          start: { type: 'number', description: 'Timeline seconds' },
          duration: { type: 'number', description: 'Seconds' },
          volume: { type: 'number', description: '0..2' },
        },
        required: ['action'],
      },
    },
  },
  required: ['reply', 'actions'],
} as const;

export const AI_SYSTEM_PROMPT = `You are the editing assistant inside One Platform Studio, a layer-based video editor.
The user describes edits in plain language (often English, sometimes Hindi or Telugu written in English letters). Translate the request into editor actions and call the apply_edits tool exactly once.

Coordinates are project pixels with (0,0) at the top-left of the canvas; x/y are a layer's top-left corner. "Right side" means x near canvas width minus the layer width minus a margin of about 5% of the width; centre means x = (canvasWidth - width) / 2. Keep layers inside the canvas unless asked otherwise. When resizing media, keep its aspect ratio unless told otherwise.

Use only clipIds from the layer list. If the request refers to "it" or "this", use the selected layer. If the request is ambiguous or impossible with the available actions (for example, removing an object that is baked into a video's pixels), make no actions and explain briefly in reply. Object removal inside footage is not available yet; say so if asked.`;

/** Compact description of the project the model reasons over. */
export function describeProject(p: Project, selectedId?: string, time = 0) {
  return {
    canvas: { width: p.settings.width, height: p.settings.height, fps: p.settings.fps },
    playhead: Number(time.toFixed(2)),
    selectedLayerId: selectedId ?? null,
    layers: p.tracks.flatMap((t, trackIndex) =>
      t.clips.map((c) => ({
        id: c.id,
        type: c.type,
        name: c.name,
        layerOrder: trackIndex,
        hidden: t.hidden,
        locked: t.locked,
        start: round(c.start),
        duration: round(c.duration),
        ...(c.type !== 'audio' ? { box: roundAll(c.transform) } : {}),
        ...(c.text ? { text: c.text.text, color: c.text.color, fontSize: c.text.fontSize } : {}),
        ...(c.shape ? { fill: c.shape.fill } : {}),
        ...(c.mediaId ? { media: getMedia(p, c.mediaId)?.name } : {}),
        ...(c.placeholder ? { placeholder: c.placeholder } : {}),
      })),
    ),
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
function roundAll<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])) as T;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function pick<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Validates model/parser actions and converts them to editor commands. */
export function actionsToCommands(p: Project, actions: AiAction[], time = 0): EditCommand[] {
  const cmds: EditCommand[] = [];
  for (const a of actions) {
    const need = (): Clip => {
      const f = a.clipId ? findClip(p, a.clipId) : undefined;
      if (!f) throw new CommandError(`Unknown layer "${a.clipId ?? ''}"`);
      return f.clip;
    };
    switch (a.action) {
      case 'move':
      case 'resize': {
        const c = need();
        const transform = pick({ x: num(a.x), y: num(a.y), width: num(a.width), height: num(a.height), rotation: num(a.rotation), opacity: num(a.opacity) });
        cmds.push({ type: 'updateTransform', clipId: c.id, transform });
        break;
      }
      case 'set_text':
      case 'set_style': {
        const c = need();
        if (c.type === 'text') {
          const style = pick({ text: a.text, color: a.color, fontSize: num(a.fontSize), fontWeight: a.fontWeight, background: a.background });
          if (Object.keys(style).length) cmds.push({ type: 'updateText', clipId: c.id, style });
        } else if (c.type === 'shape' && (a.fill || a.color)) {
          cmds.push({ type: 'updateShape', clipId: c.id, style: { fill: a.fill ?? a.color } });
        }
        if (num(a.opacity) !== undefined) cmds.push({ type: 'updateTransform', clipId: c.id, transform: { opacity: a.opacity } });
        break;
      }
      case 'delete':
        cmds.push({ type: 'deleteClip', clipId: need().id });
        break;
      case 'hide':
      case 'show': {
        const f = findClip(p, need().id)!;
        cmds.push({ type: 'updateTrack', trackId: f.track.id, patch: { hidden: a.action === 'hide' } });
        break;
      }
      case 'add_text':
        cmds.push({
          type: 'addText',
          text: a.text ?? 'Text',
          start: num(a.start) ?? time,
          duration: num(a.duration) ?? 5,
          style: pick({ color: a.color, fontSize: num(a.fontSize), fontWeight: a.fontWeight, background: a.background }),
          transform: pick({ x: num(a.x), y: num(a.y), width: num(a.width), height: num(a.height) }),
        });
        break;
      case 'color_grade':
        cmds.push({ type: 'updateColor', clipId: need().id, color: pick({ brightness: num(a.brightness), contrast: num(a.contrast), saturation: num(a.saturation) }) });
        break;
      case 'set_animation':
        cmds.push({
          type: 'updateAnimation',
          clipId: need().id,
          animation: pick({
            in: a.animationIn && ANIMS.includes(a.animationIn) ? a.animationIn : undefined,
            out: a.animationOut && ANIMS.includes(a.animationOut) ? a.animationOut : undefined,
            duration: num(a.duration),
          }),
        });
        break;
      case 'set_timing': {
        const c = need();
        if (num(a.start) !== undefined) cmds.push({ type: 'moveClip', clipId: c.id, start: a.start! });
        if (num(a.duration) !== undefined) cmds.push({ type: 'trimClip', clipId: c.id, start: num(a.start) ?? c.start, duration: a.duration!, inPoint: c.inPoint });
        break;
      }
      case 'duplicate':
        cmds.push({ type: 'duplicateClip', clipId: need().id });
        break;
      case 'set_volume':
        cmds.push({ type: 'updateClip', clipId: need().id, patch: { volume: Math.max(0, Math.min(2, num(a.volume) ?? 1)) } });
        break;
      default:
        throw new CommandError(`Unsupported action "${(a as AiAction).action}"`);
    }
  }
  return cmds;
}

// ---------------------------------------------------------------- offline rules

const COLORS: Record<string, string> = {
  red: '#ff3b30', blue: '#2f7bff', green: '#34c759', yellow: '#ffd60a', orange: '#ff9500', purple: '#8e5cff',
  pink: '#ff2d92', white: '#ffffff', black: '#000000', gray: '#8e8e93', grey: '#8e8e93', gold: '#ffc94d', cyan: '#00e0ff',
};

function resolveTarget(p: Project, phrase: string, selectedId?: string): Clip | undefined {
  const all = p.tracks.flatMap((t) => t.clips);
  if (/\b(it|this|selected|selection)\b/.test(phrase) && selectedId) return all.find((c) => c.id === selectedId);
  // Name or text match first.
  const words = phrase.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const byName = all.find((c) => words.some((w) => c.name.toLowerCase().includes(w) || c.text?.text.toLowerCase().includes(w)));
  if (byName) return byName;
  const largestText = () => all.filter((c) => c.type === 'text').sort((a, b) => (b.text!.fontSize - a.text!.fontSize))[0];
  if (/\b(title|heading|headline)\b/.test(phrase)) return largestText();
  if (/\b(text|caption)\b/.test(phrase)) return all.find((c) => c.type === 'text');
  if (/\b(logo|image|picture|photo)\b/.test(phrase)) return all.find((c) => c.type === 'image');
  if (/\b(video|clip|footage)\b/.test(phrase)) return all.find((c) => c.type === 'video');
  if (/\b(shape|box|button)\b/.test(phrase)) return all.find((c) => c.type === 'shape');
  if (/\b(music|audio|song)\b/.test(phrase)) return all.find((c) => c.type === 'audio');
  return selectedId ? all.find((c) => c.id === selectedId) : undefined;
}

/** Best-effort parser for common single-step requests. Returns null if unsure. */
export function parseOffline(p: Project, input: string, selectedId?: string, time = 0): AiResult | null {
  const s = input.toLowerCase().trim();
  const { width: W, height: H } = p.settings;
  const margin = Math.round(W * 0.05);

  const addMatch = input.match(/add (?:a )?(?:text|title|caption)\s*(?:saying|that says|:)?\s*["“']?([^"”']+)["”']?/i);
  if (addMatch) {
    const actions: AiAction[] = [{ action: 'add_text', text: addMatch[1].trim(), start: time }];
    return { commands: actionsToCommands(p, actions, time), reply: `Added text “${addMatch[1].trim()}”.`, source: 'offline' };
  }

  const target = resolveTarget(p, s, selectedId);
  if (!target) return null;
  const t = target.transform;
  const label = `“${target.name}”`;
  const done = (actions: AiAction[], reply: string): AiResult | null => {
    const commands = actionsToCommands(p, actions, time);
    return commands.length ? { commands, reply, source: 'offline' } : null;
  };
  const one = (a: Omit<AiAction, 'clipId'>, reply: string) => done([{ ...a, clipId: target.id }], reply);

  if (/\b(delete|remove)\b/.test(s)) return one({ action: 'delete' }, `Removed ${label}.`);
  if (/\bhide\b/.test(s)) return one({ action: 'hide' }, `Hid ${label}.`);
  if (/\bshow\b/.test(s)) return one({ action: 'show' }, `Showing ${label}.`);
  if (/\bduplicate|copy\b/.test(s)) return one({ action: 'duplicate' }, `Duplicated ${label}.`);

  if (/\b(move|put|place|align|shift)\b/.test(s)) {
    let { x, y } = t;
    if (/\bleft\b/.test(s)) x = margin;
    if (/\bright\b/.test(s)) x = W - t.width - margin;
    if (/\b(top|up)\b/.test(s)) y = Math.round(H * 0.05);
    if (/\b(bottom|down)\b/.test(s)) y = H - t.height - Math.round(H * 0.05);
    if (/\b(centre|center|middle)\b/.test(s)) {
      if (!/\b(left|right)\b/.test(s)) x = (W - t.width) / 2;
      if (!/\b(top|bottom|up|down)\b/.test(s)) y = (H - t.height) / 2;
    }
    if (x === t.x && y === t.y) return null;
    return one({ action: 'move', x, y }, `Moved ${label}.`);
  }

  const bigger = /\b(bigger|larger|enlarge|increase size|zoom in)\b/.test(s);
  const smaller = /\b(smaller|shrink|reduce size|zoom out)\b/.test(s);
  if (bigger || smaller) {
    const k = bigger ? 1.25 : 0.8;
    const width = t.width * k, height = t.height * k;
    const actions: AiAction[] = [{ action: 'resize', clipId: target.id, width, height, x: t.x - (width - t.width) / 2, y: t.y - (height - t.height) / 2 }];
    if (target.type === 'text') actions.push({ action: 'set_style', clipId: target.id, fontSize: Math.round(target.text!.fontSize * k) });
    return done(actions, `Made ${label} ${bigger ? 'bigger' : 'smaller'}.`);
  }

  const rot = s.match(/rotate.*?(-?\d+)/);
  if (rot) return one({ action: 'resize', rotation: Number(rot[1]) }, `Rotated ${label} to ${rot[1]}°.`);

  const graded = target.type === 'video' || target.type === 'image';
  if (graded && /\bbright(er|en)?\b/.test(s)) return one({ action: 'color_grade', brightness: Math.min(1, target.color.brightness + 0.1) }, `Brightened ${label}.`);
  if (graded && /\bdark(er|en)?\b/.test(s)) return one({ action: 'color_grade', brightness: Math.max(-1, target.color.brightness - 0.1) }, `Darkened ${label}.`);
  if (graded && /\b(black and white|grayscale|greyscale|b&w)\b/.test(s)) return one({ action: 'color_grade', saturation: 0 }, `Made ${label} black and white.`);
  if (graded && /\b(vibrant|saturate|more colou?r)\b/.test(s)) return one({ action: 'color_grade', saturation: Math.min(3, target.color.saturation + 0.3) }, `Boosted colour on ${label}.`);

  const colorWord = Object.keys(COLORS).find((c) => new RegExp(`\\b${c}\\b`).test(s));
  const hex = s.match(/#[0-9a-f]{6}\b/)?.[0];
  if ((colorWord || hex) && (target.type === 'text' || target.type === 'shape') && /\b(colou?r|make|change|turn|set)\b/.test(s)) {
    const color = hex ?? COLORS[colorWord!];
    return one(target.type === 'shape' ? { action: 'set_style', fill: color } : { action: 'set_style', color }, `Changed ${label} to ${colorWord ?? hex}.`);
  }

  const textChange = input.match(/(?:change|set|replace).*?(?:text|title|heading|caption).*?(?:to|with)\s+["“']?([^"”']+)["”']?$/i);
  if (textChange && target.type === 'text') return one({ action: 'set_text', text: textChange[1].trim() }, `Changed the text of ${label}.`);


  if (/\bfade\b/.test(s)) return one({ action: 'set_animation', animationIn: 'fade', animationOut: 'fade' }, `Added fade in/out to ${label}.`);
  const slide = s.match(/slide.*?\b(left|right|up|down)\b/);
  if (slide) return one({ action: 'set_animation', animationIn: `slide-${slide[1]}` as AnimationKind }, `${label} now slides ${slide[1]} in.`);

  if (/\b(mute|silent)\b/.test(s)) return one({ action: 'set_volume', volume: 0 }, `Muted ${label}.`);
  if (/\b(louder|volume up)\b/.test(s)) return one({ action: 'set_volume', volume: Math.min(2, target.volume + 0.25) }, `Raised volume on ${label}.`);
  if (/\b(quieter|volume down|softer)\b/.test(s)) return one({ action: 'set_volume', volume: Math.max(0, target.volume - 0.25) }, `Lowered volume on ${label}.`);

  return null;
}
