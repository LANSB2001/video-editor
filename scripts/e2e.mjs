// End-to-end smoke test of the desktop app: launches Electron, imports media,
// edits on the canvas and timeline, uses the AI assistant (offline rules),
// saves, reopens and exports a real MP4.
//
//   npm run build && node scripts/e2e.mjs [outDir]
//
// On Linux CI run it under xvfb-run. Screenshots are written to outDir.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const out = path.resolve(process.argv[2] ?? 'e2e-output');
mkdirSync(out, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const step = (s) => console.log(`• ${s}`);

// Sample media.
const video = path.join(out, 'sample.mp4');
const logo = path.join(out, 'logo.png');
if (!existsSync(video)) {
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=330:d=8',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xff9500:s=300x300,drawbox=x=60:y=60:w=180:h=180:color=white:t=fill', '-frames:v', '1', logo]);
}
// A red ball moving over a detailed still background (for the AI object tools).
const ball = path.join(out, 'ball.mp4');
if (!existsSync(ball)) {
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'mandelbrot=s=640x360:end_pts=1:start_scale=0.5', '-frames:v', '1', path.join(out, 'bg.png')]);
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', "color=c=black@0:s=90x90,format=rgba,geq=r='200':g='30':b='30':a='if(lte(hypot(X-45\\,Y-45)\\,42)\\,255\\,0)'", '-frames:v', '1', path.join(out, 'ballsprite.png')]);
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-loop', '1', '-i', path.join(out, 'bg.png'), '-loop', '1', '-i', path.join(out, 'ballsprite.png'), '-filter_complex',
    "[0]fps=30,format=yuv420p[b];[b][1]overlay=x='60+t*110':y='130+40*sin(t*2)':shortest=1,format=yuv420p", '-t', '3', '-c:v', 'libx264', '-crf', '14', ball]);
}
const projectFile = path.join(out, 'e2e.oneproj');
const exportFile = path.join(out, 'e2e-export.mp4');

const profile = mkdtempSync(path.join(os.tmpdir(), 'one-e2e-profile-'));
const app = await electron.launch({ args: ['.', '--no-sandbox'], env: { ...process.env, ANTHROPIC_API_KEY: '', ONE_USER_DATA: profile } });
// Stub native dialogs.
await app.evaluate(({ dialog }, files) => {
  dialog.showOpenDialog = async (_w, opts) => ({
    canceled: false,
    filePaths: opts?.filters?.[0]?.extensions?.includes('oneproj') ? [files.projectFile] : files.next ?? [files.video, files.logo],
  });
  dialog.showSaveDialog = async (_w, opts) => ({
    canceled: false,
    filePath: opts?.filters?.[0]?.extensions?.includes('mp4') ? files.exportFile : files.projectFile,
  });
}, { video, logo, projectFile, exportFile });

const page = await app.firstWindow();
await page.setViewportSize({ width: 1600, height: 960 }).catch(() => {});
await page.waitForSelector('.toolbar');
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await shot(page, '01-empty');

// Every main region must fit inside the window.
const vw = await page.evaluate(() => window.innerWidth);
for (const selector of ['.inspector', 'text=⬇ Export video', '.sidebar']) {
  const b = await page.locator(selector).boundingBox();
  if (!b || b.x + b.width > vw + 1) throw new Error(`${selector} is outside the window (${JSON.stringify(b)}, width ${vw})`);
}

step('import media');
await page.click('text=＋ Import video, image or audio');
await page.waitForSelector('.media-item >> nth=1');
await page.waitForTimeout(800);
await shot(page, '02-imported');

step('add video and logo to timeline');
await page.locator('.media-item').nth(0).locator('text=Add').click();
await page.locator('.media-item').nth(1).locator('text=Add').click();
await page.waitForSelector('.clip >> nth=1');

step('move logo with the AI assistant (offline rules)');
await page.click('.sidebar-tabs >> text=AI');
await page.fill('.ai-input textarea', 'make it smaller');
await page.click('.ai-input button');
await page.fill('.ai-input textarea', 'move the logo to the top right');
await page.click('.ai-input button');
await page.waitForTimeout(300);

step('add a heading and drag it on the canvas');
await page.click('.sidebar-tabs >> text=Text');
await page.click('.text-preset >> text=Heading');
const sel = page.locator('.selection');
await sel.waitFor();
const box = await sel.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2 + 120, { steps: 8 });
await page.mouse.up();
await page.fill('.props textarea', 'Summer Sale');
await page.locator('.props select').nth(2).selectOption('slide-up');

step('colour grade the video via AI');
await page.click('.sidebar-tabs >> text=AI');
await page.fill('.ai-input textarea', 'make the video black and white');
await page.click('.ai-input button');
await page.waitForTimeout(300);
const aiErrors = await page.locator('.ai-msg.error').count();
if (aiErrors) throw new Error(`AI assistant failed ${aiErrors} request(s): ${await page.locator('.ai-msg.error').first().textContent()}`);
const lastReply = await page.locator('.ai-msg.assistant').last().textContent();
if (!/black and white/.test(lastReply)) throw new Error(`unexpected AI reply: ${lastReply}`);

step('fix areas: blur and remove on the video');
await page.locator('.clip').filter({ hasText: 'sample.mp4' }).click({ position: { x: 60, y: 10 } });
await page.click('.region-add >> text=Blur');
const region = page.locator('.region').first();
await region.waitFor();
const rb = await region.boundingBox();
await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
await page.mouse.down();
await page.mouse.move(rb.x + rb.width / 2 - 200, rb.y + rb.height / 2 - 80, { steps: 6 });
await page.mouse.up();
const rb2 = await region.boundingBox();
if (Math.abs(rb2.x - (rb.x - 200)) > 4) throw new Error(`area did not move (${rb.x} → ${rb2.x})`);
await page.click('.region-add >> text=Remove');
if ((await page.locator('.region').count()) !== 2) throw new Error('expected 2 areas');
// The preview must be able to read video pixels (needed for Remove).
await page.click('.sidebar-tabs >> text=Media');
const readable = await page.evaluate(async () => {
  const src = document.querySelector('.media-item video')?.getAttribute('src')?.replace(/#.*$/, '');
  if (!src) return 'no video';
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous';
  v.muted = true;
  v.src = src;
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('load failed')); });
  const c = document.createElement('canvas');
  c.width = 8; c.height = 8;
  const cx = c.getContext('2d');
  cx.drawImage(v, 0, 0, 8, 8);
  try { cx.getImageData(0, 0, 1, 1); return 'ok'; } catch (e) { return String(e); }
});
if (readable !== 'ok') throw new Error(`preview cannot read video pixels: ${readable}`);
await page.waitForTimeout(300);
// Inside each area the preview must still honour the clip's black & white grade.
for (const i of [0, 1]) {
  const b = await page.locator('.region').nth(i).boundingBox();
  const px = await page.evaluate(({ x, y }) => {
    const c = document.querySelector('.canvas-wrap canvas');
    const r = c.getBoundingClientRect();
    const k = c.width / r.width;
    return [...c.getContext('2d').getImageData(Math.round((x - r.left) * k), Math.round((y - r.top) * k), 1, 1).data];
  }, { x: b.x + b.width * 0.3, y: b.y + b.height * 0.5 });
  if (Math.max(px[0], px[1], px[2]) - Math.min(px[0], px[1], px[2]) > 25) throw new Error(`area ${i} preview is not black & white: ${px}`);
}
await shot(page, '03b-areas');

step('seek and screenshot');
await page.keyboard.press('Escape');
await page.locator('.ruler').click({ position: { x: 170 + 80 * 2, y: 10 } });
await page.waitForTimeout(800);
await shot(page, '03-edited');

step('undo / redo');
await page.click('button[title^="Undo"]');
await page.click('button[title^="Redo"]');

step('split the video at 4s');
await page.locator('.clip').filter({ hasText: 'sample.mp4' }).click({ position: { x: 20, y: 10 } });
await page.locator('.ruler').click({ position: { x: 170 + 80 * 4, y: 10 } });
await page.click('text=✂ Split');
const clipCount = await page.locator('.clip').count();
if (clipCount !== 4) throw new Error(`expected 4 clips after split, got ${clipCount}`);

step('save, new, reopen');
await page.click('.menu-buttons >> text=Save');
await page.waitForTimeout(300);
if (!existsSync(projectFile)) throw new Error('project not saved');
page.once('dialog', (d) => d.accept());
await page.click('.menu-buttons >> text=New');
await page.click('.menu-buttons >> text=Open');
await page.waitForSelector('.clip >> nth=3');

step('templates');
await page.click('.sidebar-tabs >> text=Templates');
await page.waitForTimeout(300);
await shot(page, '04-templates');

step('export');
await page.click('text=⬇ Export video');
await page.selectOption('.modal select', 'draft');
await page.click('.modal >> button.primary');
await page.waitForSelector('.export-status .ok, .export-status .error', { timeout: 120000 });
await shot(page, '05-exported');
const err = await page.locator('.export-status .error').textContent().catch(() => null);
if (err) throw new Error(`export failed: ${err}`);
await page.click('.modal >> text=Close');

step('load a template');
page.once('dialog', (d) => d.accept());
await page.locator('.template').first().click();
await page.waitForTimeout(500);
await page.locator('.ruler').click({ position: { x: 170 + 80 * 3, y: 10 } });
await page.waitForTimeout(300);
await shot(page, '06-template-loaded');

step('AI object tools: select the ball, follow it, move it');
await app.evaluate((_, b) => { globalThis.__ball = b; }, ball);
await app.evaluate(({ dialog }, b) => {
  const orig = dialog.showOpenDialog;
  dialog.showOpenDialog = async (w, opts) => (opts?.filters?.[0]?.extensions?.includes('mp4') ? { canceled: false, filePaths: [b] } : orig(w, opts));
}, ball);
page.once('dialog', (d) => d.accept());
await page.click('.menu-buttons >> text=New');
await page.click('.sidebar-tabs >> text=Media');
await page.click('text=＋ Import video, image or audio');
await page.locator('.media-item').filter({ hasText: 'ball.mp4' }).locator('text=Add').click();
await page.locator('.ruler').click({ position: { x: 170 + 80 * 1, y: 10 } }); // playhead to 1s
await page.click('text=✦ Select an object');
await page.waitForSelector('text=Click the object on the canvas', { timeout: 120000 });
const cv = await page.locator('.canvas-wrap canvas').first().boundingBox();
// At t=1s the ball centre is at (215, 210) of 640×360.
await page.mouse.click(cv.x + cv.width * (215 / 640), cv.y + cv.height * (210 / 360));
await page.waitForSelector('.object-overlay', { timeout: 60000 });
await shot(page, '08-ai-selected');
await page.getByRole('button', { name: 'Follow through clip →' }).click();
await page.waitForSelector('text=Found in the whole clip', { timeout: 300000 });
await page.getByRole('button', { name: 'Move object', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.ai-tools .warn')
  || [...document.querySelectorAll('.clip')].some((c) => c.textContent.includes('cut-out')), null, { timeout: 300000 })
  .catch(async (e) => { await shot(page, 'fail-move'); throw e; });
const aiWarn = await page.locator('.ai-tools .warn').textContent().catch(() => null);
if (aiWarn) { await shot(page, 'fail-move'); throw new Error(`Move object failed: ${aiWarn}`); }
const names = await page.locator('.clip').allTextContents();
if (!names.some((n) => n.includes('object removed')) || !names.some((n) => n.includes('cut-out'))) throw new Error(`unexpected clips: ${names}`);
// Drag the cut-out ball 300 screen px to the right.
await page.waitForTimeout(1500);
const ballX = cv.x + cv.width * (215 / 640), ballY = cv.y + cv.height * (210 / 360);
await page.mouse.move(ballX, ballY);
await page.mouse.down();
await page.mouse.move(ballX + 300, ballY, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(800);
const sample = async (x, y) => page.evaluate(({ x, y }) => {
  const c = document.querySelector('.canvas-wrap canvas');
  const r = c.getBoundingClientRect();
  const k = c.width / r.width;
  return [...c.getContext('2d').getImageData(Math.round((x - r.left) * k), Math.round((y - r.top) * k), 1, 1).data];
}, { x, y });
const oldSpot = await sample(ballX, ballY), newSpot = await sample(ballX + 300, ballY);
const isRed = (p) => p[0] > 150 && p[1] < 80 && p[2] < 80;
if (isRed(oldSpot)) throw new Error(`ball still visible at its old place: ${oldSpot}`);
if (!isRed(newSpot)) throw new Error(`ball not at its new place: ${newSpot}`);
await page.click('.ruler', { position: { x: 5, y: 10 } });
await page.waitForTimeout(500);
await shot(page, '09-ai-moved');

step('export the moved-ball video');
await page.click('text=⬇ Export video');
await page.selectOption('.modal select', 'draft');
await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, path.join(out, 'e2e-moved.mp4'));
await page.click('.modal >> button.primary');
await page.waitForSelector('.export-status .ok, .export-status .error', { timeout: 180000 });
const err2 = await page.locator('.export-status .error').textContent().catch(() => null);
if (err2) throw new Error(`export failed: ${err2}`);
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-ss', '1', '-i', path.join(out, 'e2e-moved.mp4'), '-frames:v', '1', path.join(out, '10-moved-export-frame.png')]);

await app.close();

const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', exportFile]).toString());
console.log(`export: ${statSync(exportFile).size} bytes, ${Number(info.format.duration).toFixed(2)}s, streams: ${info.streams.map((s) => `${s.codec_type}/${s.codec_name}`).join(', ')}`);
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-ss', '2', '-i', exportFile, '-frames:v', '1', path.join(out, '07-export-frame.png')]);
if (errors.length) {
  console.log('renderer errors:\n  ' + errors.join('\n  '));
  process.exit(1);
}
console.log('E2E OK — screenshots in', out);
