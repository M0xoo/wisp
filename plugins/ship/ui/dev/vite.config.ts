import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';

// `npm run dev` in this package: its views on a memory peer (dev/harness.tsx), until apps/web serves them.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [solid()],
  server: { port: 5320, strictPort: false },
});
