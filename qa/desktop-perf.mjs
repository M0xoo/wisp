// How fast wisp's page is in a desktop browser (or the desktop app, which shows the same page):
// the cold load, opening tasks in split view and moving between them, New task, Settings, search,
// typing in the prompt box and launching a task, each timed from the click or key to the frame
// that shows it. Prints a table and writes qa/out/desktop-perf.json, with a CPU profile's top
// functions. The phone app's counterpart is qa/mobile-perf.mjs.
//
//   node qa/desktop-perf.mjs                   an isolated wisp with a few fake tasks
//   PERF_SESSIONS=~/.wisp/sessions node qa/desktop-perf.mjs
//                                              a copy of real tasks (the folder is copied, never touched)
//   PERF_CPU=4                                 Chrome's CPU slowed 4x (an older laptop)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { until } from '../test/helpers.js';
import { CHROME, OUT, api, playwright, startWisp } from './lib.mjs';

const TASKS = Number(process.env.PERF_TASKS || 8);
const CPU = Number(process.env.PERF_CPU || 1);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-dperf-home-'));
const src = process.env.PERF_SESSIONS?.replace(/^~/, os.homedir());
if (src) {
  fs.cpSync(src, path.join(home, 'sessions'), { recursive: true });
  try {
    const { projects } = JSON.parse(fs.readFileSync(path.join(src, '..', 'config.json'), 'utf8'));
    if (projects) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ projects }));
  } catch {}
}
const boot0 = Date.now();
const wisp = await startWisp({ port: Number(process.env.PERF_PORT || 4551), extraEnv: { WISP_HOME: home } });
const bootMs = Date.now() - boot0;
if (!src) {
  for (let i = 0; i < TASKS; i++) {
    const r = await api(wisp.url, '/api/sessions', { prompt: `task ${i}: fix the add function`, cwd: wisp.repo, agent: 'claude' });
    await until(async () => (await api(wisp.url, `/api/sessions/${r.json.id}`)).json?.state !== 'running', { timeout: 60_000, what: `task ${i}` });
  }
}

// Event timing, long animation frames, and a wait for the first frame where conditions hold
// (as in mobile-perf.mjs).
const probe = () => {
  window.__ev = [];
  window.__loaf = [];
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (e.interactionId) __ev.push({ name: e.name, dur: e.duration });
  }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) __loaf.push({ start: e.startTime, dur: e.duration, scripts: e.scripts.map((s) => ({ fn: s.sourceFunctionName, src: (s.sourceURL || '').replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, ''), at: s.sourceCharPosition, dur: Math.round(s.duration) })) });
  }).observe({ type: 'long-animation-frame', buffered: true });
  window.__arm = (conds) => {
    window.__t0 = null;
    for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, (e) => (window.__t0 ??= e.timeStamp), { capture: true, once: true });
    const hits = {};
    window.__done = new Promise((resolve) => {
      const seen = {};
      const tick = () => {
        if (window.__t0 != null)
          for (const [k, src] of Object.entries(conds))
            if (!(k in seen) && new Function(`return (${src})`)()) (seen[k] = 1), setTimeout(() => (hits[k] = performance.now()));
        if (Object.keys(seen).length === Object.keys(conds).length) return setTimeout(() => setTimeout(() => resolve(hits)));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  };
};

const vis = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].some((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')`;
const opened = (id) => ({
  page: `document.querySelector('#splitHead')?.dataset.id === ${JSON.stringify(id)}`,
  content: `!!document.querySelector('.item.open .it-body .turns, .item.open .it-body .tui-term') && !document.querySelector('.item.open .it-loading')`,
});
const menuOpen = `[...document.querySelectorAll('.menu, .pop, [role="menu"], [role="dialog"], dialog[open], .overlay')].some((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).opacity > 0.01)`;

const { chromium } = playwright();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = { when: new Date().toISOString(), cpu: CPU, bootMs, sessions: src ? fs.readdirSync(path.join(home, 'sessions')).filter((f) => f.endsWith('.json')).length : TASKS };
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(probe);
  const cdp = await ctx.newCDPSession(page);
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  let reqs = [];
  page.on('requestfinished', async (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/')) return;
    reqs.push(`${r.method()} ${u.pathname} ${Math.round(r.timing().responseEnd)}ms`);
  });

  // Cold load: to the first paint, the list, and the page settled (every request in).
  const cold0 = Date.now();
  await page.goto(wisp.url);
  await page.waitForSelector('#feed .item[data-id]', { timeout: 30_000 });
  const listMs = Date.now() - cold0;
  await page.waitForLoadState('networkidle').catch(() => {});
  const load = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const paint = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
    const res = performance.getEntriesByType('resource');
    return { ttfb: Math.round(nav.responseStart), domContentLoaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), fcp: paint['first-contentful-paint'], requests: res.length + 1, kb: Math.round((nav.transferSize + res.reduce((a, r) => a + (r.transferSize || 0), 0)) / 1024) };
  });
  report.load = { listMs, ...load };

  const steps = [];
  const step = async (name, conds, act) => {
    reqs = [];
    await page.evaluate(() => ((__ev.length = 0), (__loaf.length = 0)));
    await page.evaluate((c) => __arm(c), conds);
    await act();
    const hits = await page.evaluate(() => Promise.race([__done, new Promise((r) => setTimeout(() => r(null), 20_000))]));
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => ({ t0: __t0, ev: __ev.slice(), loaf: __loaf.slice() }));
    const at = (k) => (hits && m.t0 != null && hits[k] != null ? Math.round(hits[k] - m.t0) : null);
    const loafs = m.loaf.filter((l) => l.start >= (m.t0 ?? 0) - 5);
    const s = { name, page: at('page'), content: conds.content ? at('content') : null, inp: Math.round(Math.max(0, ...m.ev.map((e) => e.dur))), busy: Math.round(loafs.reduce((a, l) => a + l.dur, 0)), longest: Math.round(Math.max(0, ...loafs.map((l) => l.dur))), reqs, frames: loafs.map((l) => ({ dur: Math.round(l.dur), scripts: l.scripts.filter((x) => x.dur >= 5) })) };
    if (!hits) s.timeout = true;
    steps.push(s);
    return s;
  };

  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');

  // Done unfolded, as someone going through finished tasks has it.
  if (await page.locator('#secDone.collapsed').count()) await step('unfold Done', { page: `!document.querySelector('#secDone.collapsed') && document.querySelectorAll('#secDone .item[data-id]').length > 0` }, () => page.locator('#secDone .sec-toggle').click());
  const ids = await page.evaluate(() => [...document.querySelectorAll('#feed .item[data-id]:not(.pending)')].filter((e) => e.getClientRects().length).slice(0, 6).map((e) => e.dataset.id));
  for (const id of [...ids, ...ids.slice(0, 2)]) {
    const again = steps.some((x) => x.name.endsWith(id));
    await step(`${again ? 're' : ''}open ${id}`, opened(id), () => page.locator(`.item[data-id="${id}"] .it-head`).first().click());
  }
  await step('New task', { page: vis('#splitHome') }, () => page.keyboard.press('Escape').then(() => page.locator('#topbar .brand').click()));
  await step('type in the prompt', { page: `document.querySelector('#prompt').value.endsWith('x')` }, () => page.locator('#prompt').pressSequentially('fix the flaky test x', { delay: 30 }));
  await page.locator('#prompt').fill('');
  await step('avatar menu', { page: menuOpen }, () => page.locator('#meBtn').click());
  await step('Settings', { page: vis('.settings-modal') }, () => page.locator('#settingsBtn').click());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await step('search (⌘K)', { page: menuOpen }, () => page.keyboard.press('ControlOrMeta+k'));
  await step('type a search', { page: 'true' }, () => page.keyboard.type('fix', { delay: 60 }));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  // Launch: Enter to the new task's card, and to its first answer (a fake agent).
  await page.locator('#topbar .brand').click();
  await page.locator('#prompt').fill('qa: say hi');
  const before = await page.evaluate(() => new Set([...document.querySelectorAll('#feed .item[data-id]')].map((e) => e.dataset.id)).size);
  await step('launch (Enter)', { page: `document.querySelectorAll('#feed .item[data-id]').length > ${before}` }, () => page.locator('#prompt').press('Enter'));

  const { profile } = await cdp.send('Profiler.stop');
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  profile.samples.forEach((id, i) => {
    const f = byId.get(id).callFrame;
    const key = f.url ? `${f.functionName || '(anonymous)'} ${f.url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '')}:${f.lineNumber + 1}` : f.functionName || '(program)';
    self.set(key, (self.get(key) || 0) + (profile.timeDeltas[i] || 0) / 1000);
  });
  // Native work (layout, style, DOM calls) charged to the nearest wisp function that asked for it.
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const owner = new Map();
  profile.samples.forEach((id, i) => {
    let k = byId.get(id).callFrame.functionName || '(program)';
    for (let x = id; x != null; x = parent.get(x)) {
      const f = byId.get(x).callFrame;
      if (f.url) {
        k = `${f.functionName || '(anonymous)'} ${f.url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '')}:${f.lineNumber + 1}`;
        break;
      }
    }
    owner.set(k, (owner.get(k) || 0) + (profile.timeDeltas[i] || 0) / 1000);
  });
  report.owners = [...owner].filter(([k]) => !/^\((idle|program|garbage collector)\)$/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([fn, ms]) => ({ fn, ms: Math.round(ms) }));
  report.top = [...self].filter(([k]) => !/^\((idle|program|garbage collector)\)$/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([fn, ms]) => ({ fn, ms: Math.round(ms) }));

  // Reloaded: the browser's cache warm, as the desktop app is on every open.
  const warm0 = Date.now();
  await page.reload();
  await page.waitForSelector('#feed .item[data-id]', { timeout: 30_000 });
  report.load.warmListMs = Date.now() - warm0;
  report.steps = steps;

  console.log(`boot ${bootMs}ms · cold load: list ${listMs}ms, FCP ${load.fcp}ms, DCL ${load.domContentLoaded}ms, ${load.requests} requests, ${load.kb} KB · reload: list ${report.load.warmListMs}ms`);
  console.table(steps.map((s) => ({ step: s.name, 'page ms': s.page, 'content ms': s.content, 'INP ms': s.inp, 'busy ms': s.busy, 'longest frame': s.longest, requests: s.reqs.join(' | ') })));
  console.log('top self time (ms):');
  for (const t of report.top.slice(0, 12)) console.log(`  ${String(t.ms).padStart(6)}  ${t.fn}`);
  console.log('by the wisp function that caused it (ms):');
  for (const t of report.owners.slice(0, 15)) console.log(`  ${String(t.ms).padStart(6)}  ${t.fn}`);
} finally {
  fs.writeFileSync(path.join(OUT, `desktop-perf${process.env.PERF_TAG ? `-${process.env.PERF_TAG}` : ''}.json`), JSON.stringify(report, null, 2));
  await browser.close();
  wisp.stop();
}
