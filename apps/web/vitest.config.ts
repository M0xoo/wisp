import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid({ hot: false })],
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    // as @wisp/shell's: Zag's `solid-js/web` import resolves to the browser build in happy-dom tests
    server: { deps: { inline: [/@zag-js\//, /@solid-primitives\//] } },
  },
});
