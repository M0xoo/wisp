import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';

// `npm run gallery` in packages/ui: every kit component in every state, light and dark.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [solid()],
  server: { port: 5199, strictPort: false },
  build: { outDir: fileURLToPath(new URL('../../../node_modules/.cache/wisp-ui-gallery', import.meta.url)), emptyOutDir: true },
});
