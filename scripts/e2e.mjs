// End-to-end smoke test of the desktop app: launches Electron, imports media,
// edits on the canvas and timeline, uses the AI assistant (offline rules),
// saves, reopens and exports a real MP4.
//
//   npm run build && node scripts/e2e.mjs [outDir]
//
// On Linux CI run it under xvfb-run. Screenshots are written to outDir.

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
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
const projectFile = path.join(out, 'e2e.oneproj');
const exportFile = path.join(out, 'e2e-export.mp4');

const app = await electron.launch({ args: ['.', '--no-sandbox'], env: { ...process.env, ANTHROPIC_API_KEY: '' } });
// Stub native dialogs.
await app.evaluate(({ dialog }, files) => {
  dialog.showOpenDialog = async (_w, opts) => ({
    canceled: false,
    filePaths: opts?.filters?.[0]?.extensions?.includes('oneproj') ? [files.projectFile] : [files.video, files.logo],
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

await app.close();

const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', exportFile]).toString());
console.log(`export: ${statSync(exportFile).size} bytes, ${Number(info.format.duration).toFixed(2)}s, streams: ${info.streams.map((s) => `${s.codec_type}/${s.codec_name}`).join(', ')}`);
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-ss', '2', '-i', exportFile, '-frames:v', '1', path.join(out, '07-export-frame.png')]);
if (errors.length) {
  console.log('renderer errors:\n  ' + errors.join('\n  '));
  process.exit(1);
}
console.log('E2E OK — screenshots in', out);
