import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildExportPlan, parseProgress, type Project } from '../engine';
import type { ExportProgress } from '../shared/api';
import { ffmpegPath } from './binaries';

const QUALITY = {
  draft: { crf: 28, preset: 'veryfast' },
  standard: { crf: 20, preset: 'medium' },
  high: { crf: 16, preset: 'slow' },
} as const;

export class ExportJob {
  private child?: ChildProcess;
  private cancelled = false;

  constructor(private onProgress: (p: ExportProgress) => void) {}

  async run(project: Project, rasterPngs: Record<string, string>, output: string, quality: keyof typeof QUALITY) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'one-export-'));
    try {
      const rasters: Record<string, string> = {};
      for (const [clipId, b64] of Object.entries(rasterPngs)) {
        const file = path.join(dir, `${clipId}.png`);
        await fs.writeFile(file, Buffer.from(b64, 'base64'));
        rasters[clipId] = file;
      }
      const plan = buildExportPlan(project, { output, rasters, ...QUALITY[quality] });
      // Long graphs can exceed Windows' command-line limit, so pass it as a file.
      const script = path.join(dir, 'graph.txt');
      await fs.writeFile(script, plan.filter);
      const fi = plan.args.indexOf('-filter_complex');
      const args = [...plan.args];
      args.splice(fi, 2, '-filter_complex_script', script);

      this.onProgress({ state: 'running', progress: 0 });
      await new Promise<void>((resolve, reject) => {
        const child = spawn(ffmpegPath(), args, { windowsHide: true });
        this.child = child;
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => {
          const t = parseProgress(d.toString());
          if (t !== undefined) this.onProgress({ state: 'running', progress: Math.min(0.99, t / plan.duration) });
        });
        child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8000); });
        child.on('error', reject);
        child.on('close', (code) => {
          if (this.cancelled) reject(new Error('cancelled'));
          else if (code === 0) resolve();
          else reject(new Error(lastLines(stderr) || `FFmpeg exited with code ${code}`));
        });
      });
      this.onProgress({ state: 'done', progress: 1, output });
    } catch (e) {
      if (this.cancelled) {
        await fs.rm(output, { force: true });
        this.onProgress({ state: 'cancelled', progress: 0 });
      } else {
        this.onProgress({ state: 'error', progress: 0, message: (e as Error).message });
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  cancel() {
    this.cancelled = true;
    this.child?.kill();
  }
}

function lastLines(s: string) {
  return s.trim().split('\n').slice(-6).join('\n');
}
