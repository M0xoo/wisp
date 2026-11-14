// The layout rules of design/layout.md §6, in real Chrome: the kit gallery (packages/ui/gallery) at
// 1440, 1024, 900, 600, 390 and 320 px, light and dark. It fails when
//
//   control-wraps   an element with data-text="control" spans more than one line box
//   bar-height      a bar ([data-kit=toolbar|bar]) is taller than its token (--bar-h, --bar-h-compact)
//   bar-rows        two items of one bar sit on different rows
//   overflow-x      anything overflows the viewport horizontally
//   pin-hidden      an item with data-priority="pin" is hidden, or not in its full form (data-form)
//
//   node qa/layout.mjs                 starts the gallery (vite) on a free port, checks, stops it
//   GALLERY_URL=http://localhost:5199 node qa/layout.mjs     against a gallery already running
//   WIDTHS=390,320 THEMES=dark node qa/layout.mjs            narrower
//   node qa/layout.mjs --area=shell    the app instead (apps/web on the mock peer, `npm run dev:web`),
//                                      at the paths qa/layout-areas.mjs lists for that area
//   APP_URL=http://127.0.0.1:5180 node qa/layout.mjs --area=shell     against an app already running
//
// Needs playwright-core in PW_DIR (default /tmp/wisp-qa-pw) and the system Chrome (qa/lib.mjs).
// Writes qa/out/layout.json and, per failing width and theme, qa/out/layout/<width>-<theme>.png.
//
// The kit's side of the contract: control text carries data-text="control"; bars are
// [data-kit=toolbar] or [data-kit=bar] (data-size="compact" for the compact height); a toolbar
// item carries data-priority ('pin' or a number) and data-form ('full' | 'icon' | 'overflow').

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser, OUT, ROOT } from './lib.mjs';
import { AREAS } from './layout-areas.mjs';

const AREA = process.argv.find((a) => a.startsWith('--area='))?.slice('--area='.length);

const WIDTHS = (process.env.WIDTHS || '1440,1024,900,600,390,320').split(',').map(Number);
const THEMES = (process.env.THEMES || 'light,dark').split(',');
const SHOTS = path.join(OUT, 'layout');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

/** Starts the gallery's vite server (or, with --area, the app on the mock peer) and resolves its URL once it answers. */
async function startGallery() {
  const port = await freePort();
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const args = AREA ? ['--port', String(port), '--strictPort', '--host', '127.0.0.1'] : ['--config', 'gallery/vite.config.ts', '--port', String(port), '--strictPort', '--host', '127.0.0.1'];
  const child = spawn(process.execPath, [vite, ...args], {
    cwd: AREA ? path.join(ROOT, 'apps', 'web') : path.join(ROOT, 'packages', 'ui'),
    // the app on v1's reference data, as qa/parity.mjs runs it: qa/layout-areas.mjs paths use its ids
    env: AREA ? { ...process.env, MOCK_SEED: path.join(ROOT, 'design', 'v1-reference', 'seed.json') } : process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`the gallery exited:\n${log}`);
    try {
      if ((await fetch(url)).ok) return { url, stop: () => child.kill() };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`the gallery didn't answer on ${url} in 30 s:\n${log}`);
}

/** Runs in the page: every layout rule, as {rule, part, detail}. qa/parity.mjs runs it too (allowed.md §4). */
export function inspect() {
  const out = [];
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const name = (el) => el.getAttribute('data-part') || el.getAttribute('data-kit') || el.tagName.toLowerCase();
  const text = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const px = (expr) => {
    const probe = document.createElement('div');
    probe.style.cssText = `position:absolute;visibility:hidden;height:${expr}`;
    document.body.append(probe);
    const h = probe.getBoundingClientRect().height;
    probe.remove();
    return h;
  };

  for (const el of document.querySelectorAll('[data-text="control"]')) {
    if (!visible(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
    if (tops.size > 1) out.push({ rule: 'control-wraps', part: name(el), detail: `"${text(el)}" on ${tops.size} lines` });
  }

  const root = getComputedStyle(document.documentElement);
  const tokens = { normal: root.getPropertyValue('--bar-h').trim(), compact: root.getPropertyValue('--bar-h-compact').trim() };
  if (!tokens.normal) out.push({ rule: 'bar-height', part: ':root', detail: 'no --bar-h token: bar heights are not checked' });
  for (const bar of document.querySelectorAll('[data-kit="toolbar"], [data-kit="bar"]')) {
    if (!visible(bar)) continue;
    const compact = bar.getAttribute('data-size') === 'compact';
    const token = compact ? tokens.compact || tokens.normal : tokens.normal;
    const h = bar.getBoundingClientRect().height;
    if (token && h > px(`var(${compact && tokens.compact ? '--bar-h-compact' : '--bar-h'})`) + 1) out.push({ rule: 'bar-height', part: name(bar), detail: `${Math.round(h)} px, the token is ${token}` });
    // display: contents wrappers (extension slots) hand their children to the bar's row
    const items = [];
    const collect = (parent) => {
      for (const c of parent.children) {
        if (getComputedStyle(c).display === 'contents') collect(c);
        else if (visible(c) && getComputedStyle(c).position !== 'absolute') items.push(c.getBoundingClientRect());
      }
    };
    collect(bar);
    if (items.length > 1) {
      const maxTop = Math.max(...items.map((r) => r.top));
      const minBottom = Math.min(...items.map((r) => r.bottom));
      if (maxTop >= minBottom - 1) out.push({ rule: 'bar-rows', part: name(bar), detail: `${items.length} items on more than one row` });
    }
  }

  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw + 1) {
    const wide = [...document.querySelectorAll('body *')].filter((el) => visible(el) && el.getBoundingClientRect().right > vw + 1);
    // the outermost offenders say where to look; their children only repeat it
    const outer = wide.filter((el) => !wide.includes(el.parentElement)).slice(0, 5);
    out.push({ rule: 'overflow-x', part: outer.map(name).join(', ') || 'body', detail: `page is ${document.documentElement.scrollWidth} px wide in ${vw}` });
  }

  for (const el of document.querySelectorAll('[data-priority="pin"]')) {
    const form = el.getAttribute('data-form');
    if (!visible(el) || (form && form !== 'full')) out.push({ rule: 'pin-hidden', part: name(el), detail: visible(el) ? `form ${form}` : 'hidden' });
  }
  return out;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  if (AREA && !AREAS[AREA]) throw new Error(`no paths for --area=${AREA}: add them to qa/layout-areas.mjs`);
  const fixed = AREA ? process.env.APP_URL : process.env.GALLERY_URL;
  const gallery = fixed ? { url: fixed, stop: () => {} } : await startGallery();
  const pages = AREA ? AREAS[AREA] : [{ name: 'gallery', path: '/', ready: 'body' }];
  const browser = await launchBrowser();
  const results = [];
  try {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        for (const at of pages) {
          const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme === 'dark' ? 'dark' : 'light' });
          const errors = [];
          page.on('pageerror', (e) => errors.push(e.message));
          // the app holds its sync stream open, so it never goes network-idle: wait for what the area draws
          await page.goto(AREA ? `${gallery.url}${at.path}` : `${gallery.url}/?theme=${theme}`, { waitUntil: AREA ? 'load' : 'networkidle' });
          if (AREA) await page.waitForSelector(at.ready, { timeout: 15_000 }).catch(() => errors.push(`${at.ready} never showed`));
          await page.evaluate(() => document.fonts.ready);
          if (AREA) await page.waitForTimeout(400); // the Toolbar's ResizeObserver settles its folding
          const found = [...(await page.evaluate(inspect)), ...errors.map((e) => ({ rule: 'page-error', part: 'page', detail: e }))];
          for (const f of found) results.push({ width, theme, page: at.name, ...f });
          if (found.length) await page.screenshot({ path: path.join(SHOTS, `${AREA ? `${AREA}-${at.name}-` : ''}${width}-${theme}.png`), fullPage: !AREA });
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
    gallery.stop();
  }
  fs.writeFileSync(path.join(OUT, 'layout.json'), `${JSON.stringify(results, null, 2)}\n`);
  for (const r of results) console.log(`${r.page ? `${r.page} ` : ''}${r.width} ${r.theme} ${r.rule} ${r.part}: ${r.detail}`);
  console.log(`layout${AREA ? ` (${AREA})` : ''}: ${results.length} problem${results.length === 1 ? '' : 's'} (${pages.length} page${pages.length === 1 ? '' : 's'} × ${WIDTHS.length} widths × ${THEMES.length} themes)${results.length ? `; screenshots in ${path.relative(ROOT, SHOTS)}` : ''}`);
  process.exitCode = results.length ? 1 : 0;
}

// run as a script, not when qa/parity.mjs imports inspect()
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
