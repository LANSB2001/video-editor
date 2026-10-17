import { existsSync } from 'node:fs';
import path from 'node:path';

// ffmpeg-static / ffprobe-static ship per-platform binaries. Inside a packaged
// app they live in app.asar.unpacked (see "asarUnpack" in package.json).
function unpacked(p: string | null | undefined): string | undefined {
  if (!p) return undefined;
  const fixed = p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return existsSync(fixed) ? fixed : existsSync(p) ? p : undefined;
}

export function ffmpegPath(): string {
  return process.env.ONE_FFMPEG ?? unpacked(require('ffmpeg-static') as string) ?? 'ffmpeg';
}

export function ffprobePath(): string {
  return process.env.ONE_FFPROBE ?? unpacked((require('ffprobe-static') as { path: string }).path) ?? 'ffprobe';
}
