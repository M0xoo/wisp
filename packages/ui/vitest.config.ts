import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid({ hot: false })],
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
    // The CSS rules test reads the kit's sheets with ?raw; vitest empties CSS it isn't told to keep.
    css: { include: [/src\/css\/.+\.css/] },
    // Inline Zag and solid-primitives so their `solid-js/web` import resolves to the browser build,
    // not the server one (where `isServer` is true and keyed lists never move).
    server: { deps: { inline: [/@zag-js\//, /@solid-primitives\//] } },
  },
});
