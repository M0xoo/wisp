import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid({ hot: false })],
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
    // Zag's `solid-js/web` import must resolve to the browser build (keyed lists move there).
    server: { deps: { inline: [/@zag-js\//, /@solid-primitives\//] } },
  },
});
