// Copies the code the app shares with wisp into www/shared, keeping the server's layout so the
// relative imports still resolve: one bootstrap script for the desktop and the phone.
import fs from 'node:fs';

const root = new URL('../../', import.meta.url);
const out = new URL('../www/shared/', import.meta.url);
const FILES = ['server/shq.js', 'server/machines/bootstrap.js', 'web/css/tokens.css'];
// Capacitor's own JS (registerPlugin), as one ES module with no imports: no bundler needed.
const CAPACITOR = ['node_modules/@capacitor/core/dist/index.js', 'capacitor-core.js'];

fs.rmSync(out, { recursive: true, force: true });
for (const f of FILES) {
  const to = new URL(f.replace(/^(server|web)\//, ''), out);
  fs.mkdirSync(new URL('.', to), { recursive: true });
  fs.copyFileSync(new URL(f, root), to);
}
fs.copyFileSync(new URL(`../${CAPACITOR[0]}`, import.meta.url), new URL(CAPACITOR[1], out));
console.log(`shared: ${FILES.length + 1} files → www/shared`);
