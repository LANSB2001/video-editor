import { execFile } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { uid, type MediaAsset, type MediaKind } from '../engine';
import { ffprobePath } from './binaries';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac']);
export const MEDIA_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', ...[...IMAGE_EXT, ...AUDIO_EXT].map((e) => e.slice(1))];

interface ProbeStream { codec_type: string; width?: number; height?: number; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))),
  );
}

export async function probe(file: string): Promise<MediaAsset> {
  const ext = path.extname(file).toLowerCase();
  const out = await run(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(out) as { format?: { duration?: string }; streams: ProbeStream[] };
  const video = info.streams.find((s) => s.codec_type === 'video');
  const audio = info.streams.find((s) => s.codec_type === 'audio');

  let kind: MediaKind = 'video';
  if (IMAGE_EXT.has(ext)) kind = 'image';
  else if (!video || AUDIO_EXT.has(ext)) kind = 'audio';
  if (kind === 'audio' && !audio) throw new Error(`${path.basename(file)} has no audio or video`);

  // Phone videos often store portrait as landscape + rotation metadata.
  let width = video?.width ?? 0, height = video?.height ?? 0;
  const rot = Math.abs(Number(video?.tags?.rotate ?? video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0));
  if (rot === 90 || rot === 270) [width, height] = [height, width];

  return {
    id: uid('media'),
    kind,
    name: path.basename(file),
    path: file,
    duration: kind === 'image' ? 0 : Number(info.format?.duration ?? 0),
    width: kind === 'audio' ? 0 : width,
    height: kind === 'audio' ? 0 : height,
    hasAudio: !!audio,
  };
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
};

// Lets the preview read pixels back from media (needed for area fixes).
const CORS = { 'Access-Control-Allow-Origin': '*' };

/**
 * Handler for media://local/<encoded path>. Serves local files with HTTP Range
 * support, which <video> needs for seeking.
 */
export async function serveMedia(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const file = decodeURIComponent(url.pathname.replace(/^\//, ''));
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = request.headers.get('range')?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    }
    const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', ...CORS },
    });
  }
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(body, { headers: { 'Content-Type': type, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes', ...CORS } });
}
