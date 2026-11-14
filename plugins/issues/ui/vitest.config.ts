import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid({ hot: false })],
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
    // Inline Zag and solid-primitives so their `solid-js/web` import resolves to the browser build,
    // not the server one (where `isServer` is true and keyed lists never move).
    server: { deps: { inline: [/@zag-js\//, /@solid-primitives\//] } },
  },
});
