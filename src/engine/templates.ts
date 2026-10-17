// Templates are ordinary projects built from editable layers. Media slots are
// shape layers with a `placeholder` hint; the user replaces them with their
// own video or image via "Replace media".

import { applyCommands, type EditCommand } from './commands';
import { createProject } from './project';
import type { Project } from './types';

export interface Template {
  id: string;
  name: string;
  category: string;
  description: string;
  build: () => Project;
}

function build(name: string, width: number, height: number, background: string, cmds: (W: number, H: number) => EditCommand[]): Project {
  return applyCommands(createProject(name, { width, height, background }), cmds(width, height));
}

const slot = (label: string, x: number, y: number, w: number, h: number, start = 0, duration = 8, fill = '#2a2f3a'): EditCommand => ({
  type: 'addShape',
  start,
  duration,
  style: { kind: 'rect', fill, radius: 24, stroke: '#ffffff33', strokeWidth: 4 },
  transform: { x, y, width: w, height: h },
});

/** Marks the most recently added clip as a media placeholder. */
function withPlaceholder(p: Project, hints: string[]): Project {
  let i = 0;
  return {
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => (c.type === 'shape' && c.shape?.stroke === '#ffffff33' ? { ...c, name: hints[i] ?? 'Media slot', placeholder: hints[i++] ?? 'Replace with your media' } : c)),
    })),
  };
}

export const TEMPLATES: Template[] = [
  {
    id: 'product-launch',
    name: 'Product Launch',
    category: 'Products',
    description: '16:9 launch video: product shot, headline, price tag and call to action.',
    build: () =>
      withPlaceholder(
        build('Product Launch', 1920, 1080, '#0d0f1a', (W, H) => [
          slot('Product', W * 0.52, H * 0.12, W * 0.42, H * 0.76),
          { type: 'addText', text: 'Introducing', start: 0.2, duration: 7.8, style: { fontSize: 48, fontWeight: 'normal', color: '#a99bff', align: 'left' }, transform: { x: W * 0.06, y: H * 0.25, width: W * 0.42, height: 80 } },
          { type: 'addText', text: 'Your Product', start: 0.4, duration: 7.6, style: { fontSize: 120, color: '#ffffff', align: 'left' }, transform: { x: W * 0.06, y: H * 0.33, width: W * 0.46, height: 160 } },
          { type: 'addText', text: 'Faster. Smarter. Yours.', start: 1, duration: 7, style: { fontSize: 44, fontWeight: 'normal', color: '#c9cbd6', align: 'left' }, transform: { x: W * 0.06, y: H * 0.5, width: W * 0.42, height: 70 } },
          { type: 'addShape', start: 2, duration: 6, style: { kind: 'rect', fill: '#7c5cff', radius: 40 }, transform: { x: W * 0.06, y: H * 0.64, width: 360, height: 90 } },
          { type: 'addText', text: 'Shop now', start: 2, duration: 6, style: { fontSize: 44, color: '#ffffff' }, transform: { x: W * 0.06, y: H * 0.64 + 12, width: 360, height: 66 } },
        ]),
        ['Drop your product video or image'],
      ),
  },
  {
    id: 'app-promo',
    name: 'Mobile App Promo',
    category: 'Mobile apps',
    description: 'Phone screen recording with feature headline and store badge text.',
    build: () =>
      withPlaceholder(
        build('Mobile App Promo', 1920, 1080, '#081420', (W, H) => [
          { type: 'addShape', duration: 10, style: { kind: 'ellipse', fill: '#00e0ff22' }, transform: { x: W * 0.55, y: -H * 0.2, width: W * 0.6, height: W * 0.6 } },
          { type: 'addShape', duration: 10, style: { kind: 'rect', fill: '#111111', radius: 70, stroke: '#3a4a5a', strokeWidth: 10 }, transform: { x: W * 0.62, y: H * 0.06, width: 470, height: H * 0.88 } },
          slot('Screen', W * 0.62 + 20, H * 0.06 + 20, 430, H * 0.88 - 40, 0, 10, '#1d2733'),
          { type: 'addText', text: 'Meet the app\nyou’ll use every day', start: 0.3, duration: 9.7, style: { fontSize: 92, color: '#ffffff', align: 'left' }, transform: { x: W * 0.07, y: H * 0.28, width: W * 0.5, height: 260 } },
          { type: 'addText', text: 'Available on Android & iOS', start: 1.2, duration: 8.8, style: { fontSize: 42, fontWeight: 'normal', color: '#00e0ff', align: 'left' }, transform: { x: W * 0.07, y: H * 0.58, width: W * 0.5, height: 70 } },
        ]),
        ['Drop your app screen recording'],
      ),
  },
  {
    id: 'reel-promo',
    name: 'Instagram Reel',
    category: 'Social media',
    description: '9:16 vertical video with bold top hook and bottom caption.',
    build: () =>
      withPlaceholder(
        build('Instagram Reel', 1080, 1920, '#000000', (W, H) => [
          slot('Background', 0, 0, W, H, 0, 10, '#1b1b1f'),
          { type: 'addText', text: 'Wait for it…', start: 0, duration: 3, style: { fontSize: 110, color: '#ffffff', background: '#ff2d55' }, transform: { x: W * 0.08, y: H * 0.12, width: W * 0.84, height: 180 } },
          { type: 'addText', text: 'Follow for more', start: 7, duration: 3, style: { fontSize: 72, color: '#ffffff' }, transform: { x: W * 0.08, y: H * 0.78, width: W * 0.84, height: 120 } },
        ]),
        ['Drop your vertical video'],
      ),
  },
  {
    id: 'youtube-intro',
    name: 'YouTube Intro',
    category: 'Personal branding',
    description: 'Short channel intro with name, tagline and logo slot.',
    build: () =>
      withPlaceholder(
        build('YouTube Intro', 1920, 1080, '#14111f', (W, H) => [
          { type: 'addShape', duration: 5, style: { kind: 'rect', fill: '#ff3d3d' }, transform: { x: 0, y: H * 0.62, width: W, height: 12 } },
          slot('Logo', W / 2 - 150, H * 0.14, 300, 300, 0, 5),
          { type: 'addText', text: 'CHANNEL NAME', start: 0.5, duration: 4.5, style: { fontSize: 130, color: '#ffffff' }, transform: { x: W * 0.1, y: H * 0.44, width: W * 0.8, height: 160 } },
          { type: 'addText', text: 'New videos every week', start: 1.2, duration: 3.8, style: { fontSize: 48, fontWeight: 'normal', color: '#d0c8ff' }, transform: { x: W * 0.1, y: H * 0.68, width: W * 0.8, height: 80 } },
        ]),
        ['Drop your logo'],
      ),
  },
  {
    id: 'real-estate',
    name: 'Property Showcase',
    category: 'Real estate',
    description: 'Full-frame property footage with price and location lower third.',
    build: () =>
      withPlaceholder(
        build('Property Showcase', 1920, 1080, '#000000', (W, H) => [
          slot('Property', 0, 0, W, H, 0, 12, '#26302a'),
          { type: 'addShape', start: 0.5, duration: 11.5, style: { kind: 'rect', fill: '#000000aa', radius: 16 }, transform: { x: W * 0.05, y: H * 0.72, width: W * 0.5, height: H * 0.2 } },
          { type: 'addText', text: '3 BHK Villa · Hyderabad', start: 0.7, duration: 11.3, style: { fontSize: 56, color: '#ffffff', align: 'left' }, transform: { x: W * 0.07, y: H * 0.74, width: W * 0.46, height: 80 } },
          { type: 'addText', text: '₹1.2 Cr onwards', start: 1, duration: 11, style: { fontSize: 44, fontWeight: 'normal', color: '#ffd166', align: 'left' }, transform: { x: W * 0.07, y: H * 0.83, width: W * 0.46, height: 64 } },
        ]),
        ['Drop your property video'],
      ),
  },
];

// Give every template the same tasteful default motion on its text layers.
for (const t of TEMPLATES) {
  const inner = t.build;
  t.build = () => {
    const p = inner();
    return {
      ...p,
      tracks: p.tracks.map((tr) => ({
        ...tr,
        clips: tr.clips.map((c) => (c.type === 'text' ? { ...c, animation: { in: 'slide-up', out: 'fade', duration: 0.6 } } : c)),
      })),
    };
  };
}
