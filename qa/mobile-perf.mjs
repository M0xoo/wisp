// How fast the phone app moves between pages: wisp's page as the app's WebView shows it (phone
// viewport, touch, `wispMobile` in the user agent), on a slowed CPU and a tunnel's round trip,
// timing each step from the tap to the frame that shows it. Prints a table per profile and writes
// qa/out/mobile-perf.json (steps, slow frames with the scripts in them, and a CPU profile's top
// functions).
//
//   node qa/mobile-perf.mjs                    an isolated wisp with a few fake tasks
//   PERF_SESSIONS=~/.wisp/sessions node qa/mobile-perf.mjs
//                                              a copy of real tasks (the folder is copied, never touched)
//   PERF_PROFILES=pixel                        only some profiles (comma-separated names below)
//   PERF_STRESS=4000 PERF_SESSIONS=~/.wisp/sessions
//                                              4000 tasks cloned from those (qa/stress-data.mjs), a task
//                                              with 400 turns and one with a huge prompt, and the stress
//                                              steps: those opened, the list flung, search typed into, a
//                                              big prompt pasted, the connection lost and back

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { until } from '../test/helpers.js';
import { CHROME, OUT, api, playwright, startWisp } from './lib.mjs';
import { HUGE, WORDY, makeStress } from './stress-data.mjs';

const UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro XL) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 wispMobile';
// cpu: Chrome's CPU throttling rate. rtt: added to every request (the SSH tunnel over Wi-Fi/Tailscale).
// down / up: Mbit/s (40 / 10 unless said).
const PROFILES = [
  { name: 'laptop', cpu: 1, rtt: 0 },
  { name: 'pixel', cpu: 4, rtt: 60 },
  { name: 'pixel-far', cpu: 4, rtt: 150 },
  // Away from home: mobile data to the laptop over Tailscale (often through a relay).
  { name: 'remote', cpu: 4, rtt: 250, down: 5, up: 2 },
  // A bad connection: a weak signal, or a relay on the other side of the world.
  { name: 'bad', cpu: 4, rtt: 600, down: 1, up: 0.5 },
].filter((p) => !process.env.PERF_PROFILES || process.env.PERF_PROFILES.split(',').includes(p.name));
const TASKS = Number(process.env.PERF_TASKS || 8);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-perf-home-'));
const src = process.env.PERF_SESSIONS?.replace(/^~/, os.homedir());
const STRESS = Number(process.env.PERF_STRESS || 0);
if (src) {
  if (STRESS) console.log('stress data:', makeStress(src, path.join(home, 'sessions'), STRESS));
  else fs.cpSync(src, path.join(home, 'sessions'), { recursive: true });
  // Its projects too (the top bar's chips), and nothing else of that wisp's config.
  try {
    const { projects } = JSON.parse(fs.readFileSync(path.join(src, '..', 'config.json'), 'utf8'));
    if (projects) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ projects }));
  } catch {}
}
const wisp = await startWisp({ port: Number(process.env.PERF_PORT || 4550), extraEnv: { WISP_HOME: home } });
if (STRESS) await fetch(`${wisp.url}/api/sessions`); // the server's first list of thousands is slow: not the phone's to wait for
if (!src) {
  for (let i = 0; i < TASKS; i++) {
    const r = await api(wisp.url, '/api/sessions', { prompt: `task ${i}: fix the add function`, cwd: wisp.repo, agent: 'claude' });
    await until(async () => (await api(wisp.url, `/api/sessions/${r.json.id}`)).json?.state !== 'running', { timeout: 60_000, what: `task ${i}` });
  }
}

// In the page: event timing (tap to the frame after it), long animation frames (what ran in them),
// and a wait that resolves on the first frame where a condition holds.
const probe = () => {
  window.__ev = [];
  window.__loaf = [];
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (e.interactionId) __ev.push({ name: e.name, start: e.startTime, dur: e.duration, delay: e.processingStart - e.startTime, proc: e.processingEnd - e.processingStart });
  }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries())
      __loaf.push({
        start: e.startTime,
        dur: e.duration,
        block: e.blockingDuration,
        style: e.duration - (e.styleAndLayoutStart ? e.styleAndLayoutStart - e.startTime : e.duration),
        scripts: e.scripts.map((s) => ({ inv: s.invoker, fn: s.sourceFunctionName, src: (s.sourceURL || '').replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, ''), at: s.sourceCharPosition, dur: Math.round(s.duration), layout: Math.round(s.forcedStyleAndLayoutDuration) })),
      });
  }).observe({ type: 'long-animation-frame', buffered: true });
  // Arm before the tap: t0 is the pointerdown's own timestamp, so the driver's overhead isn't counted.
  window.__arm = (conds) => {
    window.__t0 = null;
    addEventListener('pointerdown', (e) => (window.__t0 ??= e.timeStamp), { capture: true, once: true });
    addEventListener('popstate', (e) => (window.__t0 ??= e.timeStamp), { capture: true, once: true });
    addEventListener('keydown', (e) => (window.__t0 ??= e.timeStamp), { capture: true, once: true });
    const hits = {};
    window.__done = new Promise((resolve) => {
      // Seen in a frame's rAF, stamped once that frame is through (its ResizeObservers, layout and
      // paint): a task after the next frame's start.
      const seen = {};
      const tick = () => {
        // Only once the tap (or Back) happened: a condition already true counts from the next frame.
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
const OPENED = {
  page: `document.body.classList.contains('stack-page') && ${vis('#splitStage')}`,
  content: `!!document.querySelector('.item.open .it-body .turns, .item.open .it-body .tui-term') && !document.querySelector('.item.open .it-loading')`,
};
const LIST = { page: `!document.body.classList.contains('stack-page')` };
const HOME = { page: `document.body.classList.contains('stack-page') && ${vis('#splitHome')}` };

const { chromium } = playwright();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = { when: new Date().toISOString(), sessions: src ? fs.readdirSync(path.join(home, 'sessions')).length : TASKS, profiles: [] };

try {
  for (const prof of PROFILES) {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2.6 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(180_000); // a bad connection's first load
    await page.addInitScript(probe);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: prof.cpu });
    if (prof.rtt) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: prof.rtt, downloadThroughput: ((prof.down || 40) * 1024 * 1024) / 8, uploadThroughput: ((prof.up || 10) * 1024 * 1024) / 8 });

    let reqs = [];
    page.on('requestfinished', async (r) => {
      const u = new URL(r.url());
      if (!u.pathname.startsWith('/api/')) return;
      const t = r.timing();
      // What crossed the tunnel: compressed, and nothing but headers for a 304.
      const sz = await r.sizes().catch(() => null);
      reqs.push({ path: u.pathname, ms: Math.round(t.responseEnd), kb: sz ? Math.round(((sz.responseBodySize || 0) / 1024) * 10) / 10 : 0 });
    });

    const steps = [];
    const step = async (name, conds, act) => {
      reqs = [];
      await page.evaluate(() => ((__ev.length = 0), (__loaf.length = 0)));
      await page.evaluate((c) => __arm(c), conds);
      await act();
      const hits = await page.evaluate(() => Promise.race([__done, new Promise((r) => setTimeout(() => r(null), 20_000))]));
      await page.waitForTimeout(400); // the frames and requests that follow it
      const m = await page.evaluate(() => ({ t0: __t0, ev: __ev.slice(), loaf: __loaf.slice() }));
      const at = (k) => (hits && m.t0 != null && hits[k] != null ? Math.round(hits[k] - m.t0) : null);
      const loafs = m.loaf.filter((l) => l.start >= (m.t0 ?? 0) - 5 && (!hits || l.start <= Math.max(...Object.values(hits)) + 50));
      const s = {
        name,
        page: at('page'),
        content: conds.content ? at('content') : null,
        inp: Math.round(Math.max(0, ...m.ev.map((e) => e.dur))),
        busy: Math.round(loafs.reduce((a, l) => a + l.dur, 0)),
        longest: Math.round(Math.max(0, ...loafs.map((l) => l.dur))),
        reqs: reqs.map((r) => `${r.path} ${r.ms}ms ${r.kb}KB`),
        frames: loafs.map((l) => ({ dur: Math.round(l.dur), style: Math.round(l.style), scripts: l.scripts.filter((x) => x.dur >= 5) })),
      };
      steps.push(s);
      if (!hits) s.timeout = true;
      return s;
    };

    // A finger fling over a scroller (Chrome's own scroll gesture): frames slower than 50 ms on the way.
    const fling = async (sel, dy) => {
      const box = await page.evaluate((sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        window.__frames = [];
        let last = performance.now();
        window.__flinging = true;
        const tick = (t) => { __frames.push(t - last); last = t; if (__flinging) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        return { x: Math.round(r.x + r.width / 2), y: Math.round(Math.min(r.y + r.height / 2, innerHeight / 2)) };
      }, sel);
      if (!box) return null;
      await cdp.send('Input.synthesizeScrollGesture', { x: box.x, y: box.y, yDistance: -dy, speed: 3000, gestureSourceType: 'touch', repeatCount: 1 });
      await page.waitForTimeout(300);
      return page.evaluate(() => {
        __flinging = false;
        const f = __frames.slice(1);
        return { frames: f.length, slow: f.filter((x) => x > 50).length, worst: Math.round(Math.max(0, ...f)), janky: Math.round(f.filter((x) => x > 50).reduce((a, x) => a + x, 0)) };
      });
    };

    // Cold start: the list painted.
    const cold0 = Date.now();
    await page.goto(`${wisp.url}/?m=Laptop`);
    await page.waitForSelector('#feed .item[data-id]', { timeout: 30_000 });
    const coldMs = Date.now() - cold0;
    await page.waitForTimeout(1500);

    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');

    // Done unfolded, as someone going through finished tasks has it.
    if (await page.locator('#secDone.collapsed').count())
      await step('unfold Done', { page: `!document.querySelector('#secDone.collapsed') && document.querySelectorAll('#secDone .item[data-id]').length > 0` }, () => page.locator('#secDone .sec-toggle').tap());
    // The first rows, and the heaviest of the first 40 (a long transcript), so both kinds are timed.
    const shown = await page.evaluate(() => [...document.querySelectorAll('#feed .item[data-id]:not(.pending)')].filter((e) => e.getClientRects().length).slice(0, 40).map((e) => e.dataset.id));
    const size = (id) => {
      try {
        return fs.statSync(path.join(home, 'sessions', `${id}.json`)).size;
      } catch {
        return 0;
      }
    };
    const heavy = [...shown].sort((a, b) => size(b) - size(a)).slice(0, Math.ceil(TASKS / 3));
    const ids = [...new Set([...shown.slice(0, TASKS - heavy.length), ...heavy])];
    report.sizes = Object.fromEntries(ids.map((id) => [id, Math.round(size(id) / 1024)]));
    // Each task opened and left with the phone's Back; then the first two again (kept in memory).
    for (const id of [...ids, ...ids.slice(0, 2)]) {
      const again = steps.some((x) => x.name.endsWith(id));
      await step(`${again ? 're' : ''}open ${id}`, OPENED, () => page.locator(`.item[data-id="${id}"] .it-head`).first().tap());
      await step(`back from ${id}`, LIST, () => page.evaluate(() => history.back()));
    }
    // The task's own Back button, once.
    await step(`open ${ids[0]} (for its Back)`, OPENED, () => page.locator(`.item[data-id="${ids[0]}"] .it-head`).first().tap());
    await step('Back button', LIST, () => page.locator('#splitHead .sh-back').tap());
    // New task (the floating button) and back.
    for (let i = 0; i < 2; i++) {
      await step('New task', HOME, () => page.locator('#promptFab').tap());
      await step('back from New task', LIST, () => page.evaluate(() => history.back()));
    }

    if (STRESS) {
      const tapIt = (sel) => page.locator(sel).first().tap();
      const goBack = () => page.evaluate(() => history.back());
      const listShown = async () => (await page.locator('body.stack-page').count()) && (await step('back to the list', LIST, goBack));
      // The extremes, from the top of the list (Needs you).
      for (const [name, id] of [['huge task (400 turns)', HUGE], ['huge prompt and answer', WORDY]]) {
        if (!(await page.locator(`.item[data-id="${id}"] .it-head`).count())) continue;
        await step(`stress: open ${name}`, OPENED, () => tapIt(`.item[data-id="${id}"] .it-head`));
        // Read it: a fling to the top of the task and back down.
        const frames = await fling('.item.open > .it-body', -6000);
        steps.at(-1).fling = frames;
        await step(`stress: back from ${name}`, LIST, goBack);
      }
      // The list, flung down through the pages of Done (more load as it goes).
      steps.push({ name: 'stress: fling the list', reqs: [], frames: [], fling: await fling('#stage', 12000) });
      await fling('#stage', -20000);
      // Search: typed into, one key at a time.
      await step('stress: open search', { page: `!!document.querySelector('.palette input, #palInput, dialog input')` }, () => tapIt('#searchBtn'));
      await step('stress: type a search', { page: 'true' }, () => page.keyboard.type('fix the list', { delay: 80 }));
      await goBack();
      await page.waitForTimeout(400);
      // New task: a big prompt pasted, then typed after.
      await step('stress: New task', HOME, () => tapIt('#promptFab'));
      const big = 'Investigate why the list jumps. '.repeat(4000); // ~130 KB
      await step('stress: paste a 130 KB prompt', { page: 'true' }, () =>
        page.evaluate((t) => {
          const ta = document.querySelector('#prompt');
          ta.focus();
          window.__t0 ??= performance.now();
          document.execCommand('insertText', false, t);
        }, big),
      );
      await step('stress: type after it', { page: 'true' }, () => page.keyboard.type(' and fix it', { delay: 80 }));
      await page.evaluate(() => { const ta = document.querySelector('#prompt'); ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); });
      await listShown();
      // The connection drops: a task opened while it's gone, then it comes back.
      const away = ids.at(-1);
      await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await page.waitForTimeout(1500);
      const offOpen = await step('stress: open a task offline', { page: OPENED.page }, () => tapIt(`.item[data-id="${away}"] .it-head`));
      offOpen.shown = await page.evaluate(() => (document.querySelector('.item.open .it-body .turns') ? 'content (kept)' : document.querySelector('.item.open .it-loading') ? 'Loading…' : 'other'));
      await page.waitForTimeout(3000);
      await step('stress: connection back', { page: OPENED.content }, () =>
        cdp.send('Network.emulateNetworkConditions', { offline: false, latency: prof.rtt, downloadThroughput: ((prof.down || 40) * 1024 * 1024) / 8, uploadThroughput: ((prof.up || 10) * 1024 * 1024) / 8 }).then(() => page.evaluate(() => window.__t0 ??= performance.now())),
      );
      await listShown();
    }

    // Buttons: in a task, its bar's actions; in the list, the top bar's. Tap to the frame that shows it.
    const tap = (sel) => page.locator(sel).first().tap();
    const back = () => page.evaluate(() => history.back());
    const menuOpen = `[...document.querySelectorAll('.menu, .pop, [role="menu"], [role="dialog"], dialog, .overlay')].some((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).opacity > 0.01)`;
    const plain = { page: 'true' };
    await step(`open ${ids[0]} (for its buttons)`, OPENED, () => tap(`.item[data-id="${ids[0]}"] .it-head`));
    const bar = '.item.open .it-actions';
    if (await page.locator(`${bar} [data-a="transcript"]`).isVisible()) {
      await step('button: Transcript', plain, () => tap(`${bar} [data-a="transcript"]`));
      await step('button: Transcript off', plain, () => tap(`${bar} [data-a="transcript"]`));
    }
    if (await page.locator(`${bar} [data-a="more"]`).isVisible()) {
      await step('button: More', { page: menuOpen }, () => tap(`${bar} [data-a="more"]`));
      await step('close More (Back)', { page: `!(${menuOpen})` }, back);
    }
    if (await page.locator(`${bar} [data-a="changes"]`).isVisible()) {
      await step('button: Changes', plain, () => tap(`${bar} [data-a="changes"]`));
      await step('close Changes (Back)', plain, back);
    }
    await page.waitForTimeout(300);
    if (await page.locator('body.stack-page').count()) await step('back to the list', LIST, back);
    await step('button: avatar menu', { page: menuOpen }, () => tap('#meBtn'));
    await step('close avatar menu (Back)', { page: `!(${menuOpen})` }, back);
    await step('button: search', { page: menuOpen }, () => tap('#searchBtn'));
    await step('close search (Back)', { page: `!(${menuOpen})` }, back);
    if (await page.locator('#moreProjects').isVisible()) {
      await step('button: project filter', { page: menuOpen }, () => tap('#moreProjects'));
      await step('close project filter (Back)', { page: `!(${menuOpen})` }, back);
    }
    await step('fold Needs you', plain, () => tap('#secNeeds .sec-toggle'));
    await step('unfold Needs you', plain, () => tap('#secNeeds .sec-toggle'));
    await step(`open ${ids[1]} (to mark it done)`, OPENED, () => tap(`.item[data-id="${ids[1]}"] .it-head`));
    if (await page.locator(`${bar} [data-a="done"]`).isVisible()) await step('button: Mark done', LIST, () => tap(`${bar} [data-a="done"]`));
    else await step('back to the list', LIST, back);

    // Touch feedback: a finger held 120 ms on a button and on a row, as a tap is. How long until
    // what's under it looks pressed (the WebView's own :active only shows once the finger lifts).
    const press = async (sel) => {
      const at = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        const look = () => { const c = getComputedStyle(el); return `${c.transform}|${c.opacity}|${c.backgroundColor}`; };
        const rest = look();
        window.__press = null;
        let t0 = null;
        addEventListener('touchstart', (e) => (t0 = e.timeStamp), { capture: true, once: true, passive: true });
        const tick = () => { if (t0 != null && look() !== rest) return (__press = Math.round(performance.now() - t0)); requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, sel);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
      await page.waitForTimeout(120);
      const down = await page.evaluate(() => __press);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => __press);
      if (await page.locator('body.stack-page').count()) await back(), await page.waitForTimeout(400);
      if (await page.evaluate(() => !!document.querySelector('#meMenu:not([hidden])'))) await back(), await page.waitForTimeout(300);
      return { down, after };
    };
    if (await page.locator('body.stack-page').count()) await back(), await page.waitForTimeout(400); // the list, where the top bar is
    const pressed = { button: await press('#meBtn'), row: await press(`.item[data-id="${ids[2]}"] .it-head`) };

    const { profile } = await cdp.send('Profiler.stop');

    // Started again with the service worker's cache warm, as the app is after Android stopped it:
    // to the list painted, and to the list as the server has it now.
    const warm0 = Date.now();
    const list = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/sessions', { timeout: 30_000 }).then((r) => r.finished());
    await page.reload();
    await page.waitForSelector('#feed .item[data-id]', { timeout: 30_000 });
    const warmMs = Date.now() - warm0;
    await list.catch(() => {});
    const warmIdleMs = Date.now() - warm0;
    const self = new Map();
    const dt = profile.timeDeltas;
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    profile.samples.forEach((id, i) => {
      const f = byId.get(id).callFrame;
      const key = f.url ? `${f.functionName || '(anonymous)'} ${f.url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '')}:${f.lineNumber + 1}` : f.functionName || '(program)';
      self.set(key, (self.get(key) || 0) + (dt[i] || 0) / 1000);
    });
    // Native work (layout, style, DOM calls) charged to the nearest wisp function that asked for it.
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const owner = new Map();
    const ownerOf = (id) => {
      for (let x = id; x != null; x = parent.get(x)) {
        const f = byId.get(x).callFrame;
        if (f.url && !f.url.includes('/vendor/')) return `${f.functionName || '(anonymous)'} ${f.url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '')}:${f.lineNumber + 1}`;
      }
      return byId.get(id).callFrame.functionName || '(program)';
    };
    profile.samples.forEach((id, i) => {
      const k = ownerOf(id);
      owner.set(k, (owner.get(k) || 0) + (dt[i] || 0) / 1000);
    });
    const owners = [...owner].filter(([k]) => !/^\((idle|program|garbage collector)\)$/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, ms]) => ({ fn: k, ms: Math.round(ms) }));
    const top = [...self].filter(([k]) => !/^\((idle|program|garbage collector)\)$/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, ms]) => ({ fn: k, ms: Math.round(ms) }));
    const total = Math.round([...self].filter(([k]) => k !== '(idle)').reduce((a, [, v]) => a + v, 0));

    report.profiles.push({ ...prof, coldMs, warmMs, warmIdleMs, pressed, steps, top, owners, busyMs: total });
    console.log(`\n${prof.name}: CPU ÷${prof.cpu}, +${prof.rtt}ms per request · cold start to list ${coldMs}ms · warm start: list ${warmMs}ms, fresh list in ${warmIdleMs}ms`);
    console.table(steps.map((s) => ({ step: s.name, 'page ms': s.page, 'content ms': s.content, 'INP ms': s.inp, 'busy ms': s.busy, 'longest frame': s.longest, requests: s.reqs.join(' | ') + (s.fling ? ` fling: ${s.fling.slow}/${s.fling.frames} frames >50ms, worst ${s.fling.worst}ms` : '') + (s.shown ? ` shows: ${s.shown}` : '') })));
    const fb = (x) => (x.down != null ? `${x.down}ms, finger still down` : x.after != null ? `${x.after}ms, only after the finger lifted` : 'never');
    console.log(`pressed look: button ${fb(pressed.button)} · row ${fb(pressed.row)}`);
    console.log('top self time (ms):');
    for (const t of top.slice(0, 12)) console.log(`  ${String(t.ms).padStart(6)}  ${t.fn}`);
    console.log('by the wisp function that caused it (ms):');
    for (const t of owners.slice(0, 15)) console.log(`  ${String(t.ms).padStart(6)}  ${t.fn}`);
    await ctx.close();
  }
} finally {
  fs.writeFileSync(path.join(OUT, `mobile-perf${process.env.PERF_TAG ? `-${process.env.PERF_TAG}` : ''}.json`), JSON.stringify(report, null, 2));
  await browser.close();
  wisp.stop();
}
