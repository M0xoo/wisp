import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

// Same setup as packages/ui: Zag and solid-primitives inlined so `solid-js/web` resolves to the
// browser build (keyed lists move in happy-dom).
export default defineConfig({
  plugins: [solid({ hot: false })],
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
    server: { deps: { inline: [/@zag-js\//, /@solid-primitives\//] } },
  },
});
