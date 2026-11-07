import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';

// `npm run dev` in plugins/crew/ui: this plugin's screens on the stub shell and the mock peer,
// until apps/web serves the whole app. ?theme=light|dark&screen=<id>.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [solid()],
  server: { port: 0, strictPort: false },
});
