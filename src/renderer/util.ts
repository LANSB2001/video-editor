export function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const f = Math.floor((s % 1) * 100);
  return `${m}:${String(sec).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export const CLIP_COLORS: Record<string, string> = {
  video: '#3b6fe0',
  image: '#2e9c7a',
  text: '#a05ce0',
  shape: '#d08a2e',
  audio: '#2e8fa8',
};
