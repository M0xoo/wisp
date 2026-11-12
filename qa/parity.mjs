// The parity gate (design/foundation.md §3): renders v2 (apps/web with its mock peer, seeded from
// design/v1-reference/seed.json) in every view, width, theme and state of design/v1-reference/, and
// diffs it against v1: pixels (≤ 0.5 % differ, no differing region over 8×8 px) and metrics (every
// PARTS element's box, padding, margin, gap, font, colour, border and radius within ± 0.5 px or equal).
// Allowed differences come only from design/v1-reference/allowed.md.
//
//   node qa/parity.mjs                       starts apps/web's vite (mock peer) on QA_PARITY_PORT (4590)
//   PARITY_URL=http://127.0.0.1:5180 node qa/parity.mjs   against a v2 web already running
//   --views=home,task --widths=1440,390 --themes=dark     a subset (or VIEWS= WIDTHS= THEMES= in the env)
//   --modes=desktop                                       only the desktop app's shots (desktop-*), or browser
//   PARITY_SAVE=1                                          keep every v2 shot in qa/out/parity/<view>/, not only failures
//
// v2 is driven by the same openers as v1 (qa/views.mjs), through a translation of v1 selectors to the
// PARTS contract: a v1 PARTS selector becomes `[data-part="<name>"]`, a task's row is found by its
// title from seed.json. A view whose opener finds nothing in v2 fails as "not reachable".
// Diffs and v2 shots go to qa/out/parity/<view>/, the summary to qa/out/parity/summary.{json,md}.
// No dependencies: the PNG decoder, encoder and diff are below (node:zlib).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PARTS } from '../web/js/spell-schema.js';
import { inspect as layoutProblems } from './layout.mjs';
import { launchBrowser, OUT, ROOT } from './lib.mjs';
import { collectInPage, STATES, STRUCT } from './v1-reference.mjs';
import { views } from './views.mjs';

// ---------- PNG: decode (8-bit, non-interlaced, any colour type) and encode (RGB/RGBA) ----------

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let off = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let plte = null;
  let trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const t = buf.toString('latin1', off + 4, off + 8);
    const d = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (t === 'IHDR') [w, h, depth, type, interlace] = [d.readUInt32BE(0), d.readUInt32BE(4), d[8], d[9], d[12]];
    else if (t === 'PLTE') plte = d;
    else if (t === 'tRNS') trns = d;
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
  }
  if (depth !== 8 || interlace) throw new Error(`unsupported PNG (bit depth ${depth}, interlace ${interlace})`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const cur = y * stride;
    const prev = cur - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[cur + x - ch] : 0;
      const b = y ? px[prev + x] : 0;
      const c = x >= ch && y ? px[prev + x - ch] : 0;
      const v = raw[src + x];
      px[cur + x] = f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : f === 4 ? v + paeth(a, b, c) : v;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * ch;
    const o = i * 4;
    if (type === 6) px.copy(rgba, o, s, s + 4);
    else if (type === 2) [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]] = [px[s], px[s + 1], px[s + 2], 255];
    else if (type === 0) [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]] = [px[s], px[s], px[s], 255];
    else if (type === 4) [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]] = [px[s], px[s], px[s], px[s + 1]];
    else {
      const k = px[s];
      [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]] = [plte[k * 3], plte[k * 3 + 1], plte[k * 3 + 2], trns && k < trns.length ? trns[k] : 255];
    }
  }
  return { width: w, height: h, data: rgba };
}

export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 2; // Up: cheap and good enough for diff images
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = (data[y * stride + x] - (y ? data[(y - 1) * stride + x] : 0)) & 255;
  }
  const chunk = (t, d) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t, 'latin1'), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- Pixel diff ----------

// A pixel differs when any channel is off by more than `tol` (font antialiasing on one machine is
// stable, so tol stays small). Masked pixels (allowed differences) never count. Returns the share of
// differing pixels, the differing regions (8-connected) and a diff image: v1 dimmed, differences red,
// masked areas blue.
export function diffImages(a, b, { tol = 8, masks = [] } = {}) {
  const w = Math.max(a.width, b.width);
  const h = Math.max(a.height, b.height);
  const mask = new Uint8Array(w * h);
  for (const [x, y, mw, mh] of masks)
    for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(h, Math.ceil(y + mh)); yy++)
      for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(w, Math.ceil(x + mw)); xx++) mask[yy * w + xx] = 1;
  const diff = new Uint8Array(w * h);
  const img = Buffer.alloc(w * h * 4);
  let n = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const inA = x < a.width && y < a.height;
      const inB = x < b.width && y < b.height;
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      let off = !inA || !inB;
      if (!off)
        for (let c = 0; c < 4; c++)
          if (Math.abs(a.data[ia + c] - b.data[ib + c]) > tol) {
            off = true;
            break;
          }
      const o = i * 4;
      const g = inA ? Math.round(0.3 * a.data[ia] + 0.59 * a.data[ia + 1] + 0.11 * a.data[ia + 2]) : 0;
      const dim = 200 + Math.round(g * 0.2);
      if (mask[i]) [img[o], img[o + 1], img[o + 2]] = [Math.round(dim * 0.7), Math.round(dim * 0.8), 255];
      else if (off) {
        diff[i] = 1;
        n++;
        [img[o], img[o + 1], img[o + 2]] = [230, 20, 20];
      } else [img[o], img[o + 1], img[o + 2]] = [dim, dim, dim];
      img[o + 3] = 255;
    }
  // Regions: flood fill over differing pixels, keeping each region's bounding box.
  const regions = [];
  const stack = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (diff[s] !== 1) continue;
    let top = 0;
    stack[top++] = s;
    diff[s] = 2;
    let [x0, y0, x1, y1, count] = [w, h, 0, 0, 0];
    while (top) {
      const i = stack[--top];
      const x = i % w;
      const y = (i - x) / w;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (diff[j] === 1) {
            diff[j] = 2;
            stack[top++] = j;
          }
        }
    }
    regions.push({ box: [x0, y0, x1 - x0 + 1, y1 - y0 + 1], px: count });
  }
  regions.sort((p, q) => q.box[2] * q.box[3] - p.box[2] * p.box[3]);
  return { ratio: n / (w * h), differing: n, regions, image: { width: w, height: h, data: img } };
}

// ---------- Metrics diff ----------

const nums = (s) => (s ?? '').match(/-?\d*\.?\d+(?=px)/g)?.map(Number) ?? [];
const NUMERIC = ['pad', 'mar', 'gap', 'fs', 'lh', 'bw', 'rad'];
const EXACT = ['fw', 'ff', 'col', 'bg', 'bc'];

// One reference element against v2's element of the same part and index: a list of what differs.
export function diffElement(ref, got) {
  if (!got) return ['missing'];
  const out = [];
  ref.box.forEach((v, k) => {
    if (Math.abs(v - got.box[k]) > 0.5) out.push(`box[${'xywh'[k]}] ${v}→${got.box[k]}`);
  });
  for (const key of NUMERIC) {
    const a = ref.s[key] ?? '';
    const b = got.s[key] ?? '';
    if (a === b) continue;
    const na = nums(a);
    const nb = nums(b);
    const zero = (l) => l.every((v) => v === 0);
    if (!na.length && !nb.length ? a !== b : na.length && nb.length ? na.length !== nb.length || na.some((v, k) => Math.abs(v - nb[k]) > 0.5) : !zero(na.length ? na : nb))
      out.push(`${key} ${a || '0'}→${b || '0'}`);
  }
  for (const key of EXACT) if ((ref.s[key] ?? '') !== (got.s[key] ?? '')) out.push(`${key} ${ref.s[key] ?? '-'}→${got.s[key] ?? '-'}`);
  return out;
}

// ---------- allowed.md ----------

const glob = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
export function readAllowed(file) {
  const md = fs.readFileSync(file, 'utf8');
  const block = md.match(/```rules\n([\s\S]*?)```/)?.[1] ?? '';
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      // an optional fourth column names the widths the rule holds at ("390" or "320,390"); every width without it
      const [view, part, kind, widths] = l.split(/\s+/);
      if (!['wrap', 'pending', 'fold', 'owner'].includes(kind)) throw new Error(`allowed.md: unknown kind "${kind}" in "${l}"`);
      const at = widths ? widths.split(',').map(Number) : null;
      if (at?.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error(`allowed.md: bad widths "${widths}" in "${l}"`);
      return { view: glob(view), part: glob(part), name: part, kind, at };
    });
}

// ---------- Driving v2 with v1's openers ----------

const bySel = new Map();
for (const [name, sel] of Object.entries(PARTS)) for (const piece of sel.split(',')) bySel.set(piece.trim(), name);
const splitTop = (s) => {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && !depth) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  return [...out, cur.trim()];
};

// v1 selectors the openers use that aren't a PARTS entry, in terms of the parts v2 renders.
const EXTRA = {
  '.it-dock .composer textarea': '[data-part="composer.input"]',
  // the rail's Add a crew member (v1 has no PARTS name for it; v2's kit rail names it crew.add)
  '#crewRail .cl-add': '[data-part="crew.add"]',
  '#secCrew .cr-add': '[data-part="crew.add"]',
  // v1's Spells pane is v2's Plugins (ADR-0031: changes to wisp itself are plugins)
  'button[role="tab"][data-pane="spells"]': 'button[role="tab"][data-pane="plugins"]',
  // the phone list's Crew section: a member's row, not the dashed Add one (v2's empty row has no part)
  '#secCrew .cr-row:not(.cr-empty)': '[data-part="crew.row"]',
};

// A v1 selector, in terms of the PARTS contract v2 renders (data-part). Rows are found by their title.
export function translator(seed) {
  const title = (id) => seed.list.find?.((s) => s.id === id)?.title ?? seed.sessions[id]?.title ?? id;
  const row = (id) => ['card.head', 'list.row', 'card'].map((p) => `[data-part="${p}"]:has-text(${JSON.stringify(title(id))})`).join(', ');
  return (sel) =>
    splitTop(sel)
      .map((piece) => {
        const vis = piece.endsWith(':visible') ? ':visible' : '';
        const bare = vis ? piece.slice(0, -8) : piece;
        if (bySel.has(bare)) return `[data-part="${bySel.get(bare)}"]${vis}`;
        if (EXTRA[bare]) return `${EXTRA[bare]}${vis}`;
        // an item of an open menu (v1 .menu [data-a]: on a phone, the task's Transcript under More)
        const mi = bare.match(/^\.menu \[data-a="([\w-]+)"\]$/);
        if (mi) return `[data-kit="menu-item"][data-value="${mi[1]}"]${vis}`;
        const m = bare.match(/^#feed \.item\[data-id="(\w+)"\] \.it-head$/);
        if (m) return row(m[1]);
        // the open task's actions (v1 .item.open .it-actions [data-a=…]): v2's task bar carries the same data-a
        const act = bare.match(/^\.item\.open \.it-actions \[data-a="([\w-]+)"\]$/);
        if (act) return `[data-part="split.actions"] [data-a="${act[1]}"]${vis}`;
        return piece;
      })
      .join(', ');
}

const v2Page = (p, tr) =>
  new Proxy(p, {
    get(t, k) {
      if (k === 'locator') return (s, o) => t.locator(tr(s), o);
      if (k === 'isVisible') return (s, o) => t.isVisible(tr(s), o);
      if (k === 'fill') return (s, v, o) => t.fill(tr(s), v, o);
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });

// The focused state of a list row is its quick action focused by keyboard, as in the reference.
// v1's reference marks its second row focused by its class (STATES.home.focus: the j/k highlight, the
// prompt keeping the caret). v2's equivalent is the shell's keyboard selection: set the same way,
// straight on the app's state (the dev build's window.__wispShell), not by moving focus.
const V2_FOCUS = { home: ':nth-match([data-part="card"], 2)' };
const V2_FOCUS_RUN = {
  home: (p) =>
    p.evaluate(() => {
      const row = document.querySelectorAll('[data-part="card"]')[1];
      window.__wispShell?.context.selection.set(row?.getAttribute('data-id') ?? undefined);
    }),
};
const v2Target = (name, state) => (state === 'focus' && V2_FOCUS[name]) || V2_STATES[name] || 'nothing';
const V2_STATES = {
  home: '[data-part="card.head"], [data-part="list.row"]',
  // v1's first match in document order is the open task's Transcript action (its body sits in #feed,
  // before #splitHead), so v2 targets the same button.
  task: '[data-part="split.actions"] button:visible',
  'task.composer': '[data-part="composer.mode"]:visible, [data-part="composer"] button:visible',
};

// Commands that only read: they go through to the mock (the pane they fill is part of the shot)
const READS = /^(git\.(changes|status|tools)|runtime\.(cold|agents|get|list|search)|plugins\.(ui|list)|worktrees\.(files|grep)|machines\.reachable|runtime\.usage|budget\.view|crew\.stats)$/;

async function openV2(browser, url, open, [width, height], colorScheme, at, desktop) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  // The desktop app's mode (design/v1-reference desktop-* shots): v2 finds the Tauri shell by its
  // internals, as @wisp/shell's platform module does in the app; invoke answers nothing here.
  if (desktop) await ctx.addInitScript(() => (window.__TAURI_INTERNALS__ = { invoke: async () => null }));
  // Every shot sees the seed, as v1's reference did (qa/v1-reference.mjs restores it per view): what a
  // shot does (opening a task marks it read) shows on its own screen (the optimistic patch) but never
  // reaches the mock the other shots share, in parallel (PARITY_JOBS). Subscriptions go through.
  await ctx.route('**/api/events', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      try {
        // a write never reaches the shared mock; a read (git.changes, runtime.cold…) changes nothing there, so it goes
        const m = JSON.parse(req.postData() ?? '{}');
        if (m.t === 'mutate' && !READS.test(String(m.cmd ?? ''))) return void (await route.fulfill({ status: 204, body: '' }));
      } catch {}
    }
    await route.continue();
  });
  ctx.setDefaultTimeout(2500);
  ctx.setDefaultNavigationTimeout(30_000);
  const p = await ctx.newPage();
  // The page's clock reads the view's capture time, so relative times ("now", "1m") match v1's shot.
  if (at) await p.clock.setFixedTime(new Date(at));
  await p.goto(url);
  await p.locator('[data-part="shell.app"], [data-part="feed"]').first().waitFor({ state: 'attached', timeout: 20_000 });
  await p.waitForTimeout(500);
  // An opener that finds nothing in v2 leaves the page where it got to: it's still diffed (and fails),
  // so the diff shows what v2 has instead.
  const openErr = await open(p).then(() => '', (err) => String(err?.message || err).split('\n')[0].slice(0, 140));
  await p.mouse.move(0, height - 1);
  await p.waitForTimeout(1200); // v1 focuses the prompt a beat after load: let the page settle
  return { ctx, p, openErr };
}

async function focusFirst(p, loc) {
  const found = await loc.evaluate((el) => {
    const ok = (e) => e && (e.tabIndex >= 0 || /^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/.test(e.tagName));
    const t = ok(el) ? el : el.querySelector('button, a[href], [tabindex]:not([tabindex="-1"]), input, textarea') || el.closest('[tabindex], button, a[href]');
    if (!t) return false;
    t.setAttribute('data-ref-focus', '');
    t.focus();
    return document.activeElement === t;
  });
  if (!found) return false;
  // Reach it by keyboard (Shift+Tab, Tab) so :focus-visible applies, as it does for a person tabbing.
  await p.keyboard.press('Shift+Tab');
  await p.keyboard.press('Tab');
  return p.evaluate(() => {
    const t = document.querySelector('[data-ref-focus]');
    t?.removeAttribute('data-ref-focus');
    if (document.activeElement !== t) t?.focus();
    return document.activeElement === t;
  });
}

const v2Sels = () => ({
  // an element may carry two PARTS names, as v1's did (`split.body card.body`): match one word of data-part
  ...Object.fromEntries(Object.keys(PARTS).map((n) => [n, `[data-part~="${n}"]`])),
  ...STRUCT,
  'x.row': '[data-part="card"], [data-part="list.row"]',
  // v1's .pill is a class; v2's kit names it by data-kit
  'x.pill': '[data-kit="it-pill"], [data-kit="it-state"]',
});

// ---------- One view ----------

const PIXEL_MAX = 0.005;
const REGION_MAX = 8;
// Glyph rasterization (the owner's call, 2026-11-08; design/v1-reference/allowed.md §3): the same text in
// the same box can be antialiased a pixel column differently (a glyph's subpixel phase). A differing
// region no wider than GLYPH_W and no taller than GLYPH_H (one glyph of 11.5–14px text) is let through,
// and only on a shot whose metrics all match: every part's box, font and colour equal to v1's. Anything
// larger, or any metric off, still fails.
const GLYPH_W = 6;
const GLYPH_H = 10;
export const glyphSized = (g) => g.box[2] <= GLYPH_W && g.box[3] <= GLYPH_H;

// Folded bars at 320 px (the lead's call, 2026-11-08; design/v1-reference/allowed.md §4): where v1
// wrapped a bar onto more lines and v2 keeps it on one (ADR-0012), the bar is masked, what v1 drew
// inside it is skipped, and everything below it is compared shifted up by the height v2 saved (in the
// metrics, and by cutting those rows out of v1's shot). Only on shots FOLD_MAX_W wide or less, only for
// parts a `fold` rule names, and only when the layout gate (qa/layout.mjs inspect) finds nothing on
// that same v2 page: a fold that clips, wraps a control or hides a pinned item is not allowed.
const FOLD_MAX_W = 320;

/** The outermost folded bars: v1's bar taller than v2's, starting where v2's does (± 2 px, once earlier
 *  folds are taken out; an offset that small still fails on the parts around it). `dh` is what v2 saved:
 *  the distance between the two bottoms. */
export function findFolds(refParts, gotBy, isFold) {
  const cands = refParts
    .filter((r) => isFold(r.part))
    .map((r) => ({ r, g: gotBy.get(`${r.part}#${r.i}`) }))
    .filter(({ r, g }) => g && g.box[3] < r.box[3] - 0.5)
    .sort((a, b) => a.r.box[1] - b.r.box[1] || b.r.box[3] - a.r.box[3]);
  const out = [];
  let shift = 0;
  for (const { r, g } of cands) {
    const [x, y, w, h] = r.box;
    if (out.some((f) => x >= f.v1[0] - 0.5 && y >= f.v1[1] - 0.5 && x + w <= f.v1[0] + f.v1[2] + 0.5 && y + h <= f.v1[1] + f.v1[3] + 0.5)) continue;
    if (Math.abs(y - shift - g.box[1]) > 2) continue;
    const dh = y + h - shift - (g.box[1] + g.box[3]);
    if (dh <= 0.5) continue;
    out.push({ part: `${r.part}#${r.i}`, v1: r.box, v2: g.box, dh });
    shift += dh;
  }
  return out;
}

/** v1's parts as they'd sit with the folds: inside a fold → dropped; below → moved up by what the folds
 *  saved, unless v2 shows it where v1 had it (pinned to the bottom: the composer, a footer); around →
 *  shorter, unless its height is fixed (the viewport, a pane). `limit` is where pinned content starts:
 *  rows move up only above it. */
export function foldParts(refParts, folds, vw, gotBy) {
  const bottom = (f) => f.v1[1] + f.v1[3];
  const shiftAt = (y) => folds.filter((f) => bottom(f) <= y + 0.5).reduce((n, f) => n + f.dh, 0);
  const parts = [];
  let limit = Infinity;
  for (const r of refParts) {
    const [x, y, w, h] = r.box;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const whole = (f) => x <= f.v1[0] + 0.5 && y <= f.v1[1] + 0.5 && x + w >= f.v1[0] + f.v1[2] - 0.5 && y + h >= bottom(f) - 0.5;
    if (folds.some((f) => cy >= f.v1[1] && cy <= bottom(f) && ((cx >= f.v1[0] && cx <= f.v1[0] + f.v1[2]) || cx < 0 || cx > vw) && !whole(f))) continue;
    if (folds.some((f) => f.part === `${r.part}#${r.i}`)) continue; // the folded bar itself: masked, the layout gate checks it
    const g = gotBy?.get(`${r.part}#${r.i}`);
    const off = cx < 0; // the column left of the screen (the list behind a stacked page) doesn't move; items v1 pushed past the right edge sit in the moving column
    let dy = off ? 0 : shiftAt(y);
    if (dy && g && Math.abs(g.box[1] - (y - dy)) > 0.5 && Math.abs(g.box[1] - y) <= 0.5) {
      dy = 0; // pinned: v2 has it where v1 does
      if (cx >= 0 && cx <= vw) limit = Math.min(limit, y);
    }
    const around = folds.filter((f) => whole(f) && !(cx < 0 || cx > vw));
    const shorter = h - around.reduce((n, f) => n + f.dh, 0);
    parts.push({ ...r, box: [x, y - dy, w, g && Math.abs(g.box[3] - shorter) <= 0.5 ? shorter : h] });
  }
  return { parts, limit };
}

/** v1's shot with each fold's saved rows cut out, rows below moving up as far as `limit` (pinned content
 *  stays); the rows freed just above `limit` are copied from v2's shot. */
export function foldImage(ref, shot, folds, limit = Infinity) {
  const { width: w, height: h } = ref;
  const end = Math.min(h, Math.round(limit));
  const data = Buffer.from(ref.data);
  for (const f of [...folds].sort((a, b) => b.v1[1] - a.v1[1])) {
    const from = Math.round(f.v1[1] + f.v1[3]);
    const n = Math.round(f.dh);
    if (n <= 0 || from >= end) continue;
    data.copy(data, (from - n) * w * 4, from * w * 4, end * w * 4);
  }
  const cut = Math.round(folds.reduce((n, f) => n + f.dh, 0));
  if (shot.width === w && cut > 0) shot.data.copy(data, (end - cut) * w * 4, (end - cut) * w * 4, end * w * 4);
  return { width: w, height: h, data };
}

// What each view is doing now, for the watchdog's report (a view that never returns names where it stopped).
const stepOf = new Map();

async function checkView(browser, url, name, open, ref, allowed, only, outDir) {
  const metrics = JSON.parse(fs.readFileSync(path.join(ref, name, 'metrics.json'), 'utf8'));
  const forView = allowed.filter((r) => r.view.test(name));
  let rules = forView;
  const wrapRule = (part) => rules.some((r) => r.kind === 'wrap' && r.part.test(part));
  const pendingRule = (part) => rules.some((r) => r.kind === 'pending' && r.part.test(part));
  const foldRule = (part) => rules.some((r) => r.kind === 'fold' && r.part.test(part));
  const ownerRule = (part) => rules.some((r) => r.kind === 'owner' && r.part.test(part));
  const res = { view: name, shots: 0, pixelPass: 0, metricPass: 0, pass: 0, reachable: true, note: '', worst: [], metrics: {}, shotsBy: {} };
  const dir = path.join(outDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [key, entry] of Object.entries(metrics.widths)) {
    const desktop = key.startsWith('desktop-');
    const [w, theme] = (desktop ? key.slice(8) : key).split('-');
    if (only.modes && !only.modes.includes(desktop ? 'desktop' : 'browser')) continue;
    if (only.widths && !only.widths.includes(Number(w))) continue;
    if (only.themes && !only.themes.includes(theme)) continue;
    rules = forView.filter((r) => !r.at || r.at.includes(Number(w)));
    const states = Object.entries(entry.states).filter(([, s]) => s.png || s.same?.includes('/'));
    res.shots += states.length;
    let v;
    stepOf.set(name, `opening ${key}`);
    try {
      v = await openV2(browser, url, open, entry.viewport, theme, metrics.clock ?? metrics.captured, desktop);
    } catch (err) {
      res.worst.push(`${key}: v2 did not load (${String(err?.message || err).split('\n')[0].slice(0, 100)})`);
      continue;
    }
    const { ctx, p, openErr } = v;
    if (openErr && res.reachable) {
      res.reachable = false;
      res.note = `not reachable in v2 (${key}): ${openErr}`;
    }
    for (const [state, s] of states) {
      stepOf.set(name, `${key}-${state}`);
      try {
        if (state !== 'rest') {
          const loc = p.locator(v2Target(name, state)).first();
          await p.mouse.move(0, entry.viewport[1] - 1);
          if (!(await loc.count())) {
            res.worst.push(`${key}-${state}: no ${STATES[name]?.what ?? 'target'} in v2`);
            continue;
          }
          if (state === 'hover') await loc.hover({ force: true });
          else if (V2_FOCUS_RUN[name]) await V2_FOCUS_RUN[name](p);
          else await focusFirst(p, loc);
          await p.waitForTimeout(250);
        }
        const shot = await p.screenshot();
        const refPng = path.join(ref, s.png ? path.join(name, s.png) : s.same);
        let refParts = s.parts ?? entry.states.rest.parts ?? [];
        let got;
        if (state === 'rest') got = await p.evaluate(collectInPage, { sels: v2Sels(), scope: null, max: 8 });
        else {
          // As in the reference: the hovered or focused element and what's inside it.
          const loc = p.locator(v2Target(name, state)).first();
          await loc.evaluate((el) => el.setAttribute('data-ref-target', ''));
          got = await p.evaluate(collectInPage, { sels: { target: '*', ...v2Sels() }, scope: '[data-ref-target]', max: 30 });
          await loc.evaluate((el) => el.removeAttribute('data-ref-target'));
        }
        const busy = await p.evaluate(() => [...document.querySelectorAll('[aria-busy="true"], [data-pending]')].map((e) => [e.dataset.part ?? '', ...((r) => [r.x, r.y, r.width, r.height])(e.getBoundingClientRect())]));
        const gotBy = new Map(got.map((g) => [`${g.part}#${g.i}`, g]));
        // Allowed at 320: bars v1 wrapped and v2 folds (allowed.md §4), only when the layout gate passes.
        let folds = [];
        if (Number(w) <= FOLD_MAX_W && rules.some((r) => r.kind === 'fold')) {
          const all = state === 'rest' ? got : await p.evaluate(collectInPage, { sels: v2Sels(), scope: null, max: 8 });
          const found = findFolds(entry.states.rest.parts ?? [], new Map(all.map((g) => [`${g.part}#${g.i}`, g])), foldRule);
          if (found.length) {
            const problems = await p.evaluate(layoutProblems);
            if (problems.length) res.worst.push(`${key}-${state}: fold refused, layout gate: ${problems[0].rule} ${problems[0].part} (${problems[0].detail})`);
            else folds = found;
          }
        }
        let foldLimit = Infinity;
        if (folds.length) {
          // the rest state's parts say where pinned content starts, in every state of the shot
          foldLimit = foldParts(entry.states.rest.parts ?? [], folds, entry.viewport[0], state === 'rest' ? gotBy : new Map((await p.evaluate(collectInPage, { sels: v2Sels(), scope: null, max: 8 })).map((g) => [`${g.part}#${g.i}`, g]))).limit;
          refParts = foldParts(refParts, folds, entry.viewport[0], gotBy).parts;
        }
        // Allowed: bars v1 wrapped and v2 keeps on one line; controls pending in v2.
        const masks = folds.flatMap((f) => [f.v2]);
        const exempt = [];
        for (const r of refParts) {
          if (!wrapRule(r.part) || folds.length) continue;
          const g = gotBy.get(`${r.part}#${r.i}`);
          if (g && g.box[3] < r.box[3] - 0.5) {
            masks.push(r.box, g.box);
            exempt.push(r.box);
          }
        }
        for (const [part, ...box] of busy) if (pendingRule(part || '*')) masks.push(box);
        // Allowed: the owner's decisions (allowed.md §5). The part's box, v1's and v2's, is masked; it and what's inside
        // it aren't compared; the generic parts (x.button…) are counted again on both sides without them, so one
        // decided difference doesn't shift every later index.
        const owned = { ref: refParts.filter((r) => ownerRule(r.part)).map((r) => r.box), v2: got.filter((g) => ownerRule(g.part)).map((g) => g.box) };
        // a part only v2 has (no v1 PARTS name: the owner renamed what v1 called something else), found by its data-part
        for (const r of rules.filter((x) => x.kind === 'owner' && !x.name.includes('*'))) {
          const extra = await p.evaluate((n) => [...document.querySelectorAll(`[data-part~="${n}"]`)].map((e) => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }).filter((b) => b[2] > 0), r.name);
          owned.v2.push(...extra);
        }
        if (owned.ref.length || owned.v2.length) {
          masks.push(...owned.ref, ...owned.v2);
          const within = (b, boxes) => boxes.some(([x, y, bw, bh]) => b[0] + b[2] / 2 >= x && b[0] + b[2] / 2 <= x + bw && b[1] + b[3] / 2 >= y && b[1] + b[3] / 2 <= y + bh);
          const recount = (list, boxes) => {
            const n = {};
            return [...list]
              .filter((x) => !ownerRule(x.part) && !within(x.box, boxes))
              .sort((a, b) => (a.part === b.part ? a.i - b.i : 0))
              .map((x) => (x.part.startsWith('x.') ? { ...x, i: (n[x.part] = (n[x.part] ?? -1) + 1) } : x));
          };
          refParts = recount(refParts, [...owned.ref, ...owned.v2]);
          gotBy.clear();
          for (const g of recount(got, [...owned.v2, ...owned.ref])) gotBy.set(`${g.part}#${g.i}`, g);
        }
        const inside = (b) => exempt.some(([x, y, ew, eh]) => b[0] + b[2] / 2 >= x && b[0] + b[2] / 2 <= x + ew && b[1] + b[3] / 2 >= y && b[1] + b[3] / 2 <= y + eh);
        const mdiffs = [];
        for (const r of refParts) {
          if (inside(r.box)) continue;
          const d = diffElement(r, gotBy.get(`${r.part}#${r.i}`));
          if (d.length) mdiffs.push(`${r.part}#${r.i}: ${d.slice(0, 3).join(', ')}`);
        }
        const shotPng = decodePng(shot);
        const refImg = folds.length ? foldImage(decodePng(fs.readFileSync(refPng)), shotPng, folds, foldLimit) : decodePng(fs.readFileSync(refPng));
        const px = diffImages(refImg, shotPng, { masks });
        const big = px.regions.filter((g) => g.box[2] > REGION_MAX || g.box[3] > REGION_MAX);
        const metricOk = mdiffs.length === 0;
        // glyph-sized regions only count when a metric is off too (see GLYPH_W)
        const glyphs = metricOk ? big.filter(glyphSized) : [];
        if (glyphs.length) big.splice(0, big.length, ...big.filter((g) => !glyphSized(g)));
        if (mdiffs.length) res.metrics[`${key}-${state}`] = mdiffs;
        const pixelOk = px.ratio <= PIXEL_MAX && !big.length;
        if (pixelOk) res.pixelPass++;
        if (metricOk) res.metricPass++;
        if (pixelOk && metricOk) res.pass++;
        res.shotsBy[`${key}-${state}`] = { pass: pixelOk && metricOk, px: Math.round(px.ratio * 10000) / 100, regions: big.length, parts: mdiffs.length, ...(folds.length && { folds: folds.map((f) => f.part) }) };
        if (!pixelOk) fs.writeFileSync(path.join(dir, `${key}-${state}.diff.png`), encodePng(px.image));
        // PARITY_SAVE=1 keeps every v2 shot (for side-by-sides), not only the failing ones
        if (!pixelOk || process.env.PARITY_SAVE) fs.writeFileSync(path.join(dir, `${key}-${state}.v2.png`), shot);
        if (!pixelOk || !metricOk)
          res.worst.push(`${key}-${state}: ${(px.ratio * 100).toFixed(1)}% px, ${big.length} regions >8×8, ${mdiffs.length}/${refParts.length} parts off${mdiffs.length ? ` (${mdiffs[0]})` : ''}`);
      } catch (err) {
        res.worst.push(`${key}-${state}: ${String(err?.message || err).split('\n')[0].slice(0, 120)}`);
      }
    }
    await ctx.close();
  }
  return res;
}

// ---------- The v2 web ----------

async function startV2(seedFile) {
  const port = Number(process.env.QA_PARITY_PORT) || 4590;
  const url = `http://127.0.0.1:${port}/`;
  if (await fetch(url).then(() => true, () => false)) throw new Error(`port ${port} is taken: lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill`);
  const log = fs.openSync(path.join(OUT, `parity-vite-${port}.log`), 'w');
  // MOCK_SEED: the reference data for the mock peer. It is honoured once apps/web/dev/seed.ts reads it;
  // until then the mock peer serves its own seed and every task view fails on its title.
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'], {
    cwd: path.join(ROOT, 'apps/web'),
    env: { ...process.env, PORT: String(port), MOCK_SEED: seedFile },
    stdio: ['ignore', log, log],
    detached: false,
  });
  // Gone with this run whatever ends it (a throw, Ctrl-C, a watchdog): a server left on the port made every later run
  // fail with "port taken" (round 27's batch), and a busy vite can sit out a SIGTERM.
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  process.once('exit', kill);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => (kill(), process.exit(130)));
  for (let i = 0; i < 60; i++) {
    if (await fetch(url).then((r) => r.ok, () => false)) return { url, stop: () => (child.kill('SIGTERM'), setTimeout(kill, 3000).unref()) };
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill('SIGTERM');
  throw new Error(`apps/web did not start on ${port} (see ${OUT}/parity-vite-${port}.log)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ref = process.env.REF_DIR || path.join(ROOT, 'design', 'v1-reference');
  const outDir = path.join(OUT, 'parity');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const seedFile = path.join(ref, 'seed.json');
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const allowed = readAllowed(path.join(ref, 'allowed.md'));
  // --views=home,task --widths=1440,390 --themes=dark (or VIEWS / WIDTHS / THEMES in the env)
  const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) || process.env[k.toUpperCase()];
  const only = { views: arg('views')?.split(','), widths: arg('widths')?.split(',').map(Number), themes: arg('themes')?.split(','), modes: arg('modes')?.split(',') };
  const t0 = Date.now();
  const v2 = process.env.PARITY_URL ? { url: process.env.PARITY_URL, stop: () => {} } : await startV2(seedFile);
  const tr = translator(seed);
  const openers = views({ tasks: seed.seeded.tasks.map((id) => ({ id })), goal: { id: seed.seeded.goal } });
  const names = fs
    .readdirSync(ref)
    .filter((n) => fs.existsSync(path.join(ref, n, 'metrics.json')) && openers[n])
    .filter((n) => !only.views || only.views.includes(n))
    .sort();
  const browser = await launchBrowser();
  const queue = [...names];
  const results = [];
  const worker = async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      // A view that never returns (a wait with no end) is a failure that says where it stopped, not a batch that hangs.
      const limit = Number(process.env.PARITY_VIEW_TIMEOUT) || 240_000;
      let timer;
      const r = await Promise.race([
        checkView(browser, v2.url, name, (p) => openers[name](v2Page(p, tr)), ref, allowed, only, outDir),
        new Promise((done) => {
          timer = setTimeout(() => done({ view: name, shots: 1, pixelPass: 0, metricPass: 0, pass: 0, reachable: false, note: `timed out after ${limit / 1000} s at ${stepOf.get(name) ?? 'the start'}`, worst: [`timed out at ${stepOf.get(name) ?? 'the start'}`], metrics: {}, shotsBy: {} }), limit);
        }),
      ]);
      clearTimeout(timer);
      results.push(r);
      if (!r.shots) r.note = `no reference${only.modes ? ` for ${only.modes.join(', ')}` : ''}: not covered`;
      console.log(`  ${!r.shots ? '–' : r.pass === r.shots ? '✔' : '✗'} ${name}: ${r.shots ? `${r.pass}/${r.shots}` : r.note}${r.reachable ? '' : ` · ${r.note}`}`);
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.PARITY_JOBS) || 3 }, worker));
  await browser.close();
  v2.stop();
  results.sort((a, b) => a.view.localeCompare(b.view));
  const total = results.reduce((t, r) => ({ shots: t.shots + r.shots, pass: t.pass + r.pass, px: t.px + r.pixelPass, m: t.m + r.metricPass }), { shots: 0, pass: 0, px: 0, m: 0 });
  const md = [
    `# Parity: v2 against design/v1-reference (${new Date().toISOString()})`,
    '',
    `v2: ${v2.url} · ${results.length} views (${results.filter((r) => !r.shots).length} with no reference: not covered) · ${total.pass}/${total.shots} shots pass (pixels ${total.px}, metrics ${total.m})`,
    '',
    '| View | Shots | Pass | Pixels ok | Metrics ok | Note |',
    '|---|---:|---:|---:|---:|---|',
    ...results.map((r) => `| ${r.view} | ${r.shots || '–'} | ${r.shots ? r.pass : '–'} | ${r.shots ? r.pixelPass : '–'} | ${r.shots ? r.metricPass : '–'} | ${(!r.shots || !r.reachable ? r.note : (r.worst[0] ?? '')).replace(/\|/g, '\\|')} |`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'summary.md'), md);
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ v2: v2.url, total, views: results }, null, 2));
  console.log(`\n${md}\n  parity: ${total.pass}/${total.shots} pass · ${Math.round((Date.now() - t0) / 1000)} s · ${outDir}`);
  process.exit(total.pass === total.shots ? 0 : 1);
}
