// Keeps one <video>/<audio> element per timeline clip (so the same file can play
// in two places at once) and one <img> per image asset, and keeps them in sync
// with the playhead.

import { getMedia, isActive, type Clip, type Project } from '../engine';
import { api } from './platform';

const DRIFT = 0.25; // seconds of allowed drift while playing

class MediaPool {
  private videos = new Map<string, HTMLVideoElement>();
  private audios = new Map<string, HTMLAudioElement>();
  private images = new Map<string, HTMLImageElement>();
  /** Called when a seek finishes so a paused preview can redraw. */
  onFrame: () => void = () => {};

  private element(p: Project, clip: Clip): HTMLMediaElement | undefined {
    const media = getMedia(p, clip.mediaId);
    if (!media) return;
    const map = clip.type === 'audio' ? this.audios : this.videos;
    let el = map.get(clip.id);
    const src = api.mediaUrl(media.path);
    if (!el) {
      el = document.createElement(clip.type === 'audio' ? 'audio' : 'video') as HTMLVideoElement;
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      el.addEventListener('seeked', () => this.onFrame());
      el.addEventListener('loadeddata', () => this.onFrame());
      map.set(clip.id, el as HTMLVideoElement);
    }
    if (el.dataset.src !== src) {
      el.dataset.src = src;
      el.src = src;
    }
    return el;
  }

  image(p: Project, clip: Clip): HTMLImageElement | null {
    const media = getMedia(p, clip.mediaId);
    if (!media) return null;
    let img = this.images.get(media.id);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => this.onFrame();
      img.src = api.mediaUrl(media.path);
      this.images.set(media.id, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  video(clipId: string): HTMLVideoElement | null {
    const v = this.videos.get(clipId);
    return v && v.readyState >= 2 ? v : null;
  }

  /** Bring every media element in line with time t. */
  sync(p: Project, t: number, playing: boolean) {
    const live = new Set<string>();
    for (const track of p.tracks) {
      for (const clip of track.clips) {
        if (clip.type !== 'video' && clip.type !== 'audio') continue;
        live.add(clip.id);
        const el = this.element(p, clip);
        if (!el) continue;
        const active = isActive(clip, t) && !(clip.type === 'video' && track.hidden && track.muted);
        if (!active) {
          if (!el.paused) el.pause();
          continue;
        }
        const target = clip.inPoint + (t - clip.start);
        el.muted = track.muted || clip.volume === 0;
        el.volume = Math.min(1, clip.volume);
        if (playing) {
          if (Math.abs(el.currentTime - target) > DRIFT) el.currentTime = target;
          if (el.paused) el.play().catch(() => {});
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - target) > 1 / 60) el.currentTime = target;
        }
      }
    }
    // Drop elements for clips that no longer exist.
    for (const map of [this.videos, this.audios]) {
      for (const [id, el] of map) {
        if (!live.has(id)) {
          el.pause();
          el.removeAttribute('src');
          el.load();
          map.delete(id);
        }
      }
    }
  }

  pauseAll() {
    for (const el of [...this.videos.values(), ...this.audios.values()]) el.pause();
  }
}

export const mediaPool = new MediaPool();
