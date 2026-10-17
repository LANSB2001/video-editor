// Dev loop: Vite dev server for the UI + Electron pointed at it.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const server = await createServer({ configFile: 'vite.config.mts' });
await server.listen();
await import('./build-main.mjs');

const electron = (await import('electron')).default;
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: 'http://localhost:5173' },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
