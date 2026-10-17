import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Strict CSP for the packaged app. Not applied in dev, where Vite's HMR needs
// inline scripts.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: media:",
  "media-src 'self' blob: media:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self' media:",
].join('; ');

const csp = (): Plugin => ({
  name: 'csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), csp()],
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
