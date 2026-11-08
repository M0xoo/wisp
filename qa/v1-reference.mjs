// The v1 visual spec for v2 (design/foundation.md §1): starts an isolated v1 seeded by qa/views.mjs's
// seededWisp and, for every view in qa/views.mjs, saves screenshots at six widths, light and dark, at
// rest (plus hovered / focused states of the list row, the task head and the composer toolbar), and
// metrics.json: each v1 PARTS element's (web/js/spell-schema.js) box and computed styles. Also writes
// seed.json (the exact data seededWisp produced) so the v2 mock peer can be seeded the same way.
//
//   node qa/v1-reference.mjs                  everything, into design/v1-reference/
//   VIEWS=home,task WIDTHS=1440 THEMES=dark   a subset (merges into the existing metrics.json)
//   QA_REF_PORT=4496  REF_JOBS=3              port of the QA wisp, views captured at once
//   REF_OUT=<dir>                             write somewhere else
//   REF_RESTORE=1 VIEWS=home,task             re-capture views from seed.json's exact state: before each
//                                             view the capture run's own home and repo (seed.json home/repo)
//                                             are put back as they were when seeded, a fresh v1 starts on
//                                             them, and the page clock reads the view's first capture time,
//                                             so names, ids and times match seed.json and no view sees what
//                                             another one changed (a task read, Worktree switched off)
//   REF_DETERMINISTIC=1                       a full capture done that way: seed once, then every view from it
//   REF_REASON='…'                            why: kept with the re-capture in index.json `recaptures`
//   REF_MODES=desktop                         the desktop app's mode as well (or only): window.wispDesktop is
//                                             set before the page runs, as the Tauri shell's init.js does, so
//                                             index.html adds body.desktop.mac; saved as desktop-<w>-<theme>-<state>.png
//                                             and metrics.widths["desktop-<w>-<theme>"]
//
// Never touches your wisp: qa/lib.mjs runs v1 with a temp WISP_HOME, fake agents and its own port.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PARTS } from '../web/js/spell-schema.js';
import { spawn } from 'node:child_process';
import { api, launchBrowser, qaEnv, ROOT, OUT } from './lib.mjs';
import { until } from '../test/helpers.js';
import { seededWisp, views } from './views.mjs';

export const WIDTHS = [[1440, 900], [1024, 768], [900, 900], [600, 900], [390, 844], [320, 640]];
export const THEMES = ['light', 'dark'];
// To keep the PNGs near 40 MB, the base screens get all six widths, and their variants (a menu, picker,
// panel or dialog opened over one of them) only the widths where the layout changes: desktop, the split
// point, phone and the smallest phone (1440, 900, 390, 320).
export const FULL_WIDTH_VIEWS = new Set(['home', 'task', 'task.composer', 'crew', 'stuff', 'palette', 'me-menu', 'projects', 'settings.general']);
export const VARIANT_WIDTHS = [1440, 900, 390, 320];
export const widthsFor = (view) => (FULL_WIDTH_VIEWS.has(view) ? WIDTHS : WIDTHS.filter(([w]) => VARIANT_WIDTHS.includes(w)));

// Structural elements beside the PARTS names, so the kit gets numbers for controls no spell names.
export const STRUCT = {
  'x.button': 'button',
  'x.input': 'input:not([type=hidden]), textarea, select',
  'x.menu': '.menu',
  'x.menuItem': '.menu [data-a], .menu button, .menu [role=menuitem]',
  'x.dialog': '[role=dialog], dialog[open], .modal, .sheet',
  'x.tab': '[role=tab]',
  'x.pill': '.pill',
  'x.heading': 'h1, h2, h3, h4',
  'x.row': '#feed .item[data-id]',
  'x.kbd': 'kbd, .kbd',
};

// The three elements captured in more than their resting state (foundation §1), on the view that shows
// them. `selected` has no separate shot: the list row's selected state is the open row in `task`, the
// composer's selected toolbar item is `task.composer-goal`, and the open task head is always selected.
export const STATES = {
  // A v1 row has no DOM focus (its quick actions are aria-hidden spans). Its keyboard state is the
  // `.item.focused` highlight that j/k and Esc out of a task leave (feed.css, split.css); j also opens the
  // task, so the class is set directly on the second row.
  home: {
    what: 'list row',
    target: '#feed .item[data-id]:not(.open) .it-head',
    selected: 'task',
    focus: {
      target: '#feed .item.focused',
      run: (p) => p.evaluate(() => document.querySelectorAll('#feed .item[data-id]:not(.open)')[1]?.classList.add('focused')),
    },
  },
  task: { what: 'task head', target: '#splitHead button:visible, .item.open .it-actions button:visible', selected: 'task (rest)' },
  'task.composer': { what: 'composer toolbar', target: '.composer .c-mode:visible, .composer button:visible', selected: 'task.composer-goal' },
};

// Runs in the page: every visible element matching each selector, with its box and computed style.
// Values are kept as Chrome reports them (px strings, rgb()), with zero/none defaults dropped.
export function collectInPage({ sels, scope, max }) {
  const root = scope ? document.querySelector(scope) : document;
  const out = [];
  if (!root) return out;
  const pick = (cs) => {
    const s = {};
    const four = (p) => [cs[`${p}Top`], cs[`${p}Right`], cs[`${p}Bottom`], cs[`${p}Left`]].join(' ');
    const pad = four('padding');
    if (pad !== '0px 0px 0px 0px') s.pad = pad;
    const mar = four('margin');
    if (mar !== '0px 0px 0px 0px') s.mar = mar;
    if (cs.rowGap !== 'normal' || cs.columnGap !== 'normal') s.gap = `${cs.rowGap} ${cs.columnGap}`;
    s.fs = cs.fontSize;
    s.lh = cs.lineHeight;
    s.fw = cs.fontWeight;
    s.ff = cs.fontFamily;
    s.col = cs.color;
    if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)') s.bg = cs.backgroundColor;
    if (cs.backgroundImage !== 'none') s.bgi = cs.backgroundImage.slice(0, 200);
    const bw = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].join(' ');
    if (bw !== '0px 0px 0px 0px') {
      s.bw = bw;
      s.bc = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor].join(' ');
    }
    const rad = cs.borderRadius;
    if (rad !== '0px') s.rad = rad;
    if (cs.boxShadow !== 'none') s.sh = cs.boxShadow;
    if (cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px') s.ol = `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor} ${cs.outlineOffset}`;
    if (cs.opacity !== '1') s.op = cs.opacity;
    s.disp = cs.display;
    if (cs.whiteSpace !== 'normal') s.ws = cs.whiteSpace;
    return s;
  };
  for (const [part, sel] of Object.entries(sels)) {
    let els;
    try {
      els = [...root.querySelectorAll(sel)];
      if (scope && root.matches?.(sel)) els.unshift(root);
    } catch {
      continue; // a selector this engine can't parse
    }
    let i = 0;
    for (const el of els) {
      if (i >= (part === 'x.button' ? max * 5 : max)) break;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const round = (n) => Math.round(n * 2) / 2;
      out.push({ part, i: i++, box: [round(r.x), round(r.y), round(r.width), round(r.height)], s: pick(cs) });
    }
  }
  return out;
}

// Focuses the target, or its nearest focusable descendant or ancestor, the way the keyboard reaches it:
// focusable ancestor or descendant.
async function focusTarget(p, loc) {
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

export async function openView(browser, url, open, [width, height], colorScheme, { at, desktop } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  // The Tauri shell's init.js defines window.wispDesktop before the page's scripts run; index.html then
  // adds body.desktop and .mac (navigator.platform, a Mac here).
  if (desktop) await ctx.addInitScript(() => (window.wispDesktop = Object.freeze({ pickFolder: async () => null })));
  const p = await ctx.newPage();
  if (at) await p.clock.setFixedTime(new Date(at));
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(url);
  await p.locator('#feed .item[data-id]').first().waitFor({ state: 'attached', timeout: 20_000 });
  await p.waitForTimeout(300);
  await open(p);
  await p.mouse.move(0, height - 1); // nothing hovered by accident
  await p.waitForTimeout(1200); // v1 focuses the prompt a beat after load: let the page settle
  return { ctx, p, errors };
}

const sha = (buf) => createHash('sha1').update(buf).digest('hex');
const partSels = () => ({ ...PARTS, ...STRUCT });

async function captureView(browser, url, name, open, out, only, { at, modes = ['browser'] } = {}) {
  const dir = path.join(out, name);
  fs.mkdirSync(dir, { recursive: true });
  const metricsFile = path.join(dir, 'metrics.json');
  const metrics = fs.existsSync(metricsFile) && only ? JSON.parse(fs.readFileSync(metricsFile, 'utf8')) : { view: name, captured: new Date().toISOString(), widths: {} };
  const report = { name, shots: 0, skipped: [], errors: [] };
  for (const mode of modes)
  for (const size of widthsFor(name)) {
    if (only.widths && !only.widths.includes(size[0])) continue;
    for (const theme of THEMES) {
      if (only.themes && !only.themes.includes(theme)) continue;
      const key = `${mode === 'desktop' ? 'desktop-' : ''}${size[0]}-${theme}`;
      let v;
      try {
        v = await openView(browser, url, open, size, theme, { at, desktop: mode === 'desktop' });
      } catch (err) {
        report.errors.push(`${key}: ${String(err?.message || err).split('\n')[0]}`);
        continue;
      }
      const { ctx, p, errors } = v;
      const entry = { viewport: size, states: {} };
      try {
        const rest = await p.screenshot();
        fs.writeFileSync(path.join(dir, `${key}-rest.png`), rest);
        report.shots++;
        entry.states.rest = { png: `${key}-rest.png`, parts: await p.evaluate(collectInPage, { sels: partSels(), scope: null, max: 8 }) };
        const st = STATES[name];
        if (st) {
          const loc = p.locator(st.target).first();
          if (await loc.count()) {
            for (const state of ['hover', 'focus']) {
              await p.mouse.move(0, size[1] - 1);
              if (state === 'hover') await loc.hover({ force: true, timeout: 3000 }).catch(() => {});
              else if (st.focus) await st.focus.run(p);
              else if (!(await focusTarget(p, loc))) {
                report.skipped.push(`${key}-${state}: nothing focusable`);
                continue;
              }
              await p.waitForTimeout(250);
              const shot = await p.screenshot();
              if (sha(shot) === sha(rest)) {
                report.skipped.push(`${key}-${state}: same as rest`);
                entry.states[state] = { same: 'rest' };
                continue;
              }
              fs.writeFileSync(path.join(dir, `${key}-${state}.png`), shot);
              report.shots++;
              // Only the element that changed, and what's inside it: the rest is the resting metrics.
              const at = state === 'focus' && st.focus ? p.locator(st.focus.target).first() : loc;
              if (!(await at.count())) {
                report.skipped.push(`${key}-${state}: no ${st.what} after ${state}`);
                continue;
              }
              const tagged = await at.evaluate((el) => {
                el.setAttribute('data-ref-target', '');
                return true;
              });
              const parts = tagged ? await p.evaluate(collectInPage, { sels: { target: '*', ...partSels() }, scope: '[data-ref-target]', max: 30 }) : [];
              await at.evaluate((el) => el.removeAttribute('data-ref-target'));
              entry.states[state] = { png: `${key}-${state}.png`, target: state === 'focus' && st.focus ? st.focus.target : st.target, parts };
            }
          } else report.skipped.push(`${key}: no ${st.what} (${st.target})`);
        }
      } catch (err) {
        report.errors.push(`${key}: ${String(err?.message || err).split('\n')[0]}`);
      }
      if (errors.length) report.errors.push(`${key}: page error ${errors[0]}`);
      metrics.widths[key] = entry;
      await ctx.close();
    }
  }
  fs.writeFileSync(metricsFile, JSON.stringify(metrics));
  return report;
}

// ---------- REF_RESTORE: each view from seed.json's exact state ----------
// The capture run's home and repo (seed.json home, repo) hold its tasks, worktrees and config. Their
// state as seeded is kept once in a pristine copy (made the first time, with the read marks and the
// Worktree default put back to what seed.json says), and restored before every view, so no view sees
// what another one did. Nothing is deleted: files are copied back over the run's own.
const PRISTINE = process.env.REF_PRISTINE || '/tmp/wisp-v1-pristine';

export function makePristine(seed, { fresh = false } = {}) {
  if (fs.existsSync(PRISTINE) && !fresh) return;
  if (fresh) fs.rmSync(PRISTINE, { recursive: true, force: true }); // our own copy, made from the run's
  fs.cpSync(seed.home, path.join(PRISTINE, 'home'), { recursive: true });
  fs.cpSync(seed.repo, path.join(PRISTINE, 'repo'), { recursive: true });
  for (const [id, s] of Object.entries(seed.sessions)) {
    const f = path.join(PRISTINE, 'home', 'sessions', `${id}.json`);
    if (!fs.existsSync(f)) continue;
    const row = JSON.parse(fs.readFileSync(f, 'utf8'));
    row.unread = s.unread;
    fs.writeFileSync(f, JSON.stringify(row, null, 2));
  }
  const cf = path.join(PRISTINE, 'home', 'config.json');
  const config = JSON.parse(fs.readFileSync(cf, 'utf8'));
  config.defaults = seed.config.defaults;
  fs.writeFileSync(cf, JSON.stringify(config, null, 2));
}

export async function restoredWisp(seed, port) {
  fs.cpSync(path.join(PRISTINE, 'home'), seed.home, { recursive: true, force: true });
  if (fs.existsSync(path.join(PRISTINE, 'repo'))) fs.cpSync(path.join(PRISTINE, 'repo'), seed.repo, { recursive: true, force: true });
  const busy = await fetch(`http://localhost:${port}/api/health`).then(() => true, () => false);
  if (busy) throw new Error(`port ${port} is taken: lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill`);
  const { env } = qaEnv({ WISP_PORT: String(port), FAKE_DELAY: '300' });
  env.WISP_HOME = seed.home;
  const log = fs.openSync(path.join(OUT, `wisp-restore-${port}.log`), 'w');
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/wisp.js'), '--no-open', '--port', String(port)], { env, stdio: ['ignore', log, log] });
  const url = `http://localhost:${port}`;
  await until(async () => (await fetch(`${url}/api/config`)).ok, { timeout: 30_000, what: `wisp on ${port}` });
  // v1 works the overlaps out in the background after it starts, listing a task's others in the order
  // the tasks were first checked; a restart checks them newest first (ship.js boot), the seeding run
  // checked them as they launched. Reading each task checks it (GET /sessions/:id), so they're read
  // oldest first before the boot sweep, and the lists come out as seeded.
  for (const s of [...seed.list].sort((a, b) => a.createdAt - b.createdAt)) await api(url, `/api/sessions/${s.id}`);
  const first = seed.seeded.tasks[0];
  await until(async () => ((await api(url, `/api/sessions/${first}`)).json?.overlaps?.length ?? 0) > 0, { timeout: 60_000, what: 'the overlaps' });
  return { url, stop: () => new Promise((r) => (child.once('exit', r), child.kill('SIGTERM'))) };
}

// Every view's clock: the page reads this time (Playwright's clock), so relative times ("now", "1m") are
// the same on every capture. Kept per view in metrics.json `clock` (qa/parity.mjs pins v2 to it); a view
// captured for the first time reads the seed's time plus a second.
async function restoreRun(out, port, only, { fresh = false } = {}) {
  const seed = JSON.parse(fs.readFileSync(path.join(out, 'seed.json'), 'utf8'));
  makePristine(seed, { fresh });
  const started = new Date().toISOString();
  const modes = process.env.REF_MODES ? process.env.REF_MODES.split(',') : ['browser'];
  const openers = views({ tasks: seed.seeded.tasks.map((id) => ({ id })), goal: { id: seed.seeded.goal } });
  const names = (only.views ?? Object.keys(openers)).filter((n) => openers[n]);
  const browser = await launchBrowser();
  for (const name of names) {
    const file = path.join(out, name, 'metrics.json');
    const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
    const at = prev?.clock ?? prev?.captured ?? new Date(Date.parse(seed.captured) + 1000).toISOString();
    // every width, theme and mode from the same restored state
    for (const mode of modes)
      for (const size of widthsFor(name)) {
        if (only.widths && !only.widths.includes(size[0])) continue;
        for (const theme of THEMES) {
          if (only.themes && !only.themes.includes(theme)) continue;
          const w = await restoredWisp(seed, port);
          try {
            const r = await captureView(browser, w.url, name, openers[name], out, { ...only, widths: [size[0]], themes: [theme] }, { at, modes: [mode] });
            console.log(`  ${r.errors.length ? '✗' : '✔'} ${name} ${mode} ${size[0]} ${theme}: ${r.shots} shots${r.errors.length ? ` · ${r.errors.join(' | ')}` : ''}`);
          } finally {
            await w.stop();
          }
        }
      }
    // when it was captured (now), and the clock its pages read (v2's parity pins to it)
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    m.captured = new Date().toISOString();
    m.clock = at;
    fs.writeFileSync(file, JSON.stringify(m));
  }
  await browser.close();
  // the run's home and repo back as seeded, and the re-capture on record (design/foundation.md §1)
  await restoredWisp(seed, port).then((w) => w.stop());
  const indexFile = path.join(out, 'index.json');
  const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};
  index.recaptures = [...(index.recaptures ?? []), { started, finished: new Date().toISOString(), views: names, modes, widths: only.widths ?? 'all', themes: only.themes ?? 'all', reason: process.env.REF_REASON || '' }];
  fs.writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
}

// What seededWisp left on the server: the list, every task in full (turns and blocks), the crew.
async function writeSeed(seeded, out) {
  const { w } = seeded;
  const get = async (p) => (await api(w.url, p)).json;
  const list = await get('/api/sessions');
  const ids = (Array.isArray(list) ? list : list?.sessions || []).map((s) => s.id);
  const sessions = {};
  for (const id of ids) sessions[id] = await get(`/api/sessions/${id}`);
  const seed = {
    note: 'Captured from v1 by qa/v1-reference.mjs (qa/views.mjs seededWisp, fake agents, FAKE_DELAY=300). Paths are the temp repo/home of the capture run.',
    captured: new Date().toISOString(),
    repo: w.repo,
    home: w.home,
    seeded: { tasks: seeded.tasks.map((t) => t.id), goal: seeded.goal.id },
    list,
    sessions,
    crew: await get('/api/crew'),
    config: await get('/api/config'),
  };
  fs.writeFileSync(path.join(out, 'seed.json'), `${JSON.stringify(seed, null, 2)}\n`);
  return { sessions: ids.length, crew: (Array.isArray(seed.crew) ? seed.crew : seed.crew?.members || []).length };
}

// A shot identical to the same width/theme/state of an earlier view (a menu that doesn't open at that
// width, two views that end in the same state) is kept once: the later view's metrics entry says
// `same: "<view>/<file>"` and its PNG is dropped. qa/parity.mjs follows the pointer.
function dedupe(out, names) {
  const seen = new Map();
  let n = 0;
  for (const name of names) {
    const file = path.join(out, name, 'metrics.json');
    if (!fs.existsSync(file)) continue;
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const entry of Object.values(m.widths))
      for (const st of Object.values(entry.states)) {
        if (!st.png) continue;
        const png = path.join(out, name, st.png);
        const key = `${st.png}:${sha(fs.readFileSync(png))}`;
        const first = seen.get(key);
        if (!first) {
          seen.set(key, `${name}/${st.png}`);
          continue;
        }
        fs.rmSync(png);
        st.same = first;
        delete st.png;
        n++;
      }
    fs.writeFileSync(file, JSON.stringify(m));
  }
  return n;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.env.REF_OUT || path.join(ROOT, 'design', 'v1-reference');
  fs.mkdirSync(out, { recursive: true });
  const port = Number(process.env.QA_REF_PORT) || 4496;
  const only = {
    views: process.env.VIEWS?.split(','),
    widths: process.env.WIDTHS?.split(',').map(Number),
    themes: process.env.THEMES?.split(','),
  };
  const t0 = Date.now();
  if (process.env.REF_RESTORE) {
    await restoreRun(out, port, only);
    process.exit(0);
  }
  if (process.env.REF_DETERMINISTIC) {
    // A full capture that no view can disturb: seed once (seed.json), then every view from that state
    // with its clock pinned, exactly as REF_RESTORE re-captures one later.
    const seeded = await seededWisp(port);
    const seedInfo = await writeSeed(seeded, out);
    console.log(`  seed.json: ${seedInfo.sessions} sessions, ${seedInfo.crew} crew`);
    seeded.w.stop();
    await new Promise((r) => setTimeout(r, 1000));
    await restoreRun(out, port, only, { fresh: true });
    process.exit(0);
  }
  const seeded = await seededWisp(port);
  // A subset run starts a new seed (new ids, a new temp repo name): its shots then differ from the rest
  // in those names, and seed.json stays the full run's. Re-capture everything before committing.
  if (only.views || only.widths || only.themes) console.log('  subset run: seed.json left as it is; ids and repo name differ from the full capture');
  else {
    const seedInfo = await writeSeed(seeded, out);
    console.log(`  seed.json: ${seedInfo.sessions} sessions, ${seedInfo.crew} crew`);
  }
  const browser = await launchBrowser();
  const all = Object.entries(views(seeded)).filter(([n]) => !only.views || only.views.includes(n));
  const queue = [...all];
  const reports = [];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const r = await captureView(browser, seeded.w.url, job[0], job[1], out, only.views || only.widths || only.themes ? only : {});
      reports.push(r);
      console.log(`  ${r.errors.length ? '✗' : '✔'} ${r.name}: ${r.shots} shots${r.errors.length ? ` · ${r.errors.slice(0, 2).join(' | ')}` : ''}`);
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.REF_JOBS) || 3 }, worker));
  await browser.close();
  seeded.w.stop();
  const dups = dedupe(out, reports.map((r) => r.name).sort());
  console.log(`  deduped ${dups} shots identical to another view's`);
  const index = {
    captured: new Date().toISOString(),
    widths: WIDTHS,
    variantWidths: VARIANT_WIDTHS,
    fullWidthViews: [...FULL_WIDTH_VIEWS],
    themes: THEMES,
    states: STATES,
    file: '<view>/<width>-<theme>-<state>.png; <view>/metrics.json: widths["<width>-<theme>"].states[state].parts[] = {part, i, box:[x,y,w,h], s:{pad, mar, gap, fs, lh, fw, ff, col, bg, bw, bc, rad, …}}',
    views: Object.fromEntries(reports.sort((a, b) => a.name.localeCompare(b.name)).map((r) => [r.name, { shots: r.shots, skipped: r.skipped, errors: r.errors }])),
  };
  if (!only.views && !only.widths && !only.themes) fs.writeFileSync(path.join(out, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  const failed = reports.filter((r) => r.errors.length);
  console.log(`\n  v1-reference: ${reports.length} views, ${reports.reduce((n, r) => n + r.shots, 0)} shots, ${failed.length} with errors · ${Math.round((Date.now() - t0) / 1000)} s · ${out}`);
  process.exit(failed.length ? 1 : 0);
}
