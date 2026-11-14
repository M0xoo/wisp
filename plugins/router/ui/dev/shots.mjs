// Screenshots of this plugin's screens (dev/seed.ts SCREENS) in real Chrome at 1440, 900, 390 and
// 320 px, light and dark, into /tmp/v2-shots/<area>/, then qa/layout.mjs on each screen.
//   node dev/shots.mjs              every screen
//   node dev/shots.mjs rail org     some
//   NO_LAYOUT=1 node dev/shots.mjs  screenshots only
// Needs playwright-core in /tmp/wisp-qa-pw and the system Chrome (qa/lib.mjs).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.dirname(HERE);
const ROOT = path.resolve(PKG, '../../..');
const AREA = path.basename(path.dirname(PKG));
const OUT = path.join('/tmp/v2-shots', AREA);
const WIDTHS = (process.env.WIDTHS || '1440,900,390,320').split(',').map(Number);
const THEMES = (process.env.THEMES || 'light,dark').split(',');

const { SCREENS } = await import(path.join(HERE, 'seed.ts'));
const pick = process.argv.slice(2);
const screens = Object.keys(SCREENS).filter((s) => !pick.length || pick.includes(s));

const port = await new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--config', 'dev/vite.config.ts', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: PKG, stdio: 'ignore' });
const url = `http://127.0.0.1:${port}`;
for (let i = 0; i < 150; i++) {
  try {
    if ((await fetch(url)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const { launchBrowser } = await import(path.join(ROOT, 'qa/lib.mjs'));
const browser = await launchBrowser();
fs.mkdirSync(OUT, { recursive: true });
const errors = [];
try {
  for (const screen of screens) {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
        page.on('pageerror', (e) => errors.push(`${screen} ${width} ${theme}: ${e.message}`));
        await page.goto(`${url}/s/${screen}/?theme=${theme}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, `${screen}-${width}-${theme}.png`), fullPage: true });
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
}
let failed = errors.length > 0;
for (const e of errors) console.log(`page error: ${e}`);
if (!process.env.NO_LAYOUT) {
  for (const screen of screens) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'qa/layout.mjs')], { env: { ...process.env, GALLERY_URL: `${url}/s/${screen}`, WIDTHS: WIDTHS.join(','), QA_OUT: path.join(OUT, 'layout', screen) }, encoding: 'utf8' });
    const last = (r.stdout || '').trim().split('\n');
    console.log(`${screen}: ${last.at(-1)}`);
    if (r.status !== 0) {
      failed = true;
      console.log(last.slice(0, -1).join('\n'));
    }
  }
}
vite.kill();
console.log(`${screens.length} screens × ${WIDTHS.length} widths × ${THEMES.length} themes → ${OUT}`);
process.exit(failed ? 1 : 0);
