// apps/web: the one bundle. `vite` (npm run dev:web) serves it with the mock peer; `vite build`
// writes dist/ with content-hashed assets, which `wisp serve` serves (crates/wisp/src/serve.rs
// web_dir: WISP_WEB_DIR, else web/ by the binary, else this checkout's apps/web/dist) and the
// desktop and Android apps ship. The service worker builds to dist/sw.js (a fixed name: its scope
// is the site, and the page registers it by that name).

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { mockPeer } from './dev/vite-mock.ts';

function build(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return `dev-${Date.now().toString(36)}`;
  }
}

export default defineConfig(({ command }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [solid(), ...(command === 'serve' && process.env['WISP_MOCK'] !== '0' ? [mockPeer()] : [])],
  define: { __WISP_BUILD__: JSON.stringify(build()) },
  server: { port: Number(process.env['PORT'] ?? 5180), strictPort: false, host: '127.0.0.1' },
  preview: { port: Number(process.env['PORT'] ?? 5181), host: '127.0.0.1' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { index: fileURLToPath(new URL('index.html', import.meta.url)), sw: fileURLToPath(new URL('src/sw.ts', import.meta.url)) },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
