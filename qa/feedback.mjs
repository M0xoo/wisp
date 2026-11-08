// The feedback gate (design/feedback.md, ADR-0017): every action answers within one frame. For each
// interactive element of a view (the views of qa/views.mjs, opened in v2 as qa/parity.mjs does), with
// the mock peer's answers slowed to 400 ms:
//   1. press it (a text field: a character typed, then Enter, which sends it) and watch the page: a DOM
//      change, a style change seen in a screenshot, focus moving, or a new page (a link) within 100 ms
//      passes;
//   2. a control that went pending (aria-busy / data-pending) is pressed again: nothing may happen;
//   3. a press that sent a command is repeated with the mock refusing that command: a toast must say why
//      within 100 ms of the refusal arriving (DELAY + BUDGET after the press), and the screen must roll
//      back: with the toast hidden, it no longer shows what the accepted press showed (the row read, the
//      new task, the toggle flipped). A navigation the press also made (opening a task) stays; only the
//      command's own optimistic change goes. A press whose command showed nothing has nothing to undo.
// Pressing what's already chosen (aria-current, a disabled control) isn't an action and is skipped.
//
//   node qa/feedback.mjs                                 starts apps/web's vite with v1's seed on 4592;
//                                                        desktop and browser modes, at 1440, 390 and 320
//   FEEDBACK_URL=http://127.0.0.1:5180 node qa/feedback.mjs
//   --views=home,task --widths=1440,390 --modes=desktop  a subset
// Results: qa/out/feedback/summary.{json,md}; a failure's before/after shots beside them.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, diffImages, encodePng, translator } from './parity.mjs';
import { launchBrowser, OUT, ROOT } from './lib.mjs';
import { views } from './views.mjs';

const DELAY = 400; // ms the mock peer's answers take (design/feedback.md)
const BUDGET = 100; // ms an action has to show something
/** Pixels a rolled-back screen may still differ by (antialiasing, a caret's blink). */
const ROLLBACK_SLACK = 64;
const SIZES = { 1440: [1440, 900], 1024: [1024, 768], 900: [900, 900], 600: [600, 900], 390: [390, 844], 320: [320, 640] };
const INTERACTIVE = 'button, a[href], [role="button"], input:not([type=hidden]), textarea, select, [tabindex]:not([tabindex="-1"])';

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) || process.env[`FEEDBACK_${k.toUpperCase()}`];

async function startV2(seedFile) {
  const port = Number(process.env.QA_FEEDBACK_PORT) || 4592;
  const url = `http://127.0.0.1:${port}/`;
  if (await fetch(url).then(() => true, () => false)) throw new Error(`port ${port} is taken: lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill`);
  const log = fs.openSync(path.join(OUT, `feedback-vite-${port}.log`), 'w');
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'], {
    cwd: path.join(ROOT, 'apps/web'),
    env: { ...process.env, PORT: String(port), MOCK_SEED: seedFile },
    stdio: ['ignore', log, log],
  });
  for (let i = 0; i < 60; i++) {
    if (await fetch(url).then((r) => r.ok, () => false)) return { url, stop: () => child.kill('SIGTERM') };
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill('SIGTERM');
  throw new Error(`apps/web did not start on ${port}`);
}

// In the page: every interactive element on screen, by a selector that finds it again after a reload.
function listTargets(sel) {
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(sel)) {
    if (seen.has(el)) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    if (el.closest('[inert], [aria-hidden="true"]')) continue;
    // a control inside another (a chip's ×) is its own target; the outer one keeps its own too
    const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.x + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.y + r.height / 2)));
    if (!hit || !(el === hit || el.contains(hit))) continue; // covered by something else
    const skip = el.getAttribute('aria-disabled') === 'true' || el.disabled ? 'disabled' : el.getAttribute('aria-current') ? 'current' : '';
    const nth = [...document.querySelectorAll(sel)].indexOf(el);
    const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.getAttribute('placeholder') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 60);
    const part = el.closest('[data-part]')?.getAttribute('data-part') ?? '';
    out.push({ nth, name, part, tag: el.tagName.toLowerCase(), skip, box: [r.x, r.y, r.width, r.height] });
    seen.add(el);
  }
  return out;
}

// In the page: watch for the first visible change after the press.
function watch() {
  const w = (window.__fb = { first: 0, at: 0, focus: document.activeElement });
  const mo = new MutationObserver(() => {
    if (!w.first) w.first = performance.now();
  });
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  addEventListener('pointerdown', () => (w.at = performance.now()), { capture: true, once: true });
  addEventListener('keydown', () => (w.at ||= performance.now()), { capture: true, once: true });
  w.stop = () => mo.disconnect();
}

async function open(browser, url, opener, size, mode, at) {
  // every press starts from the seed: what an earlier press changed (a task read) doesn't carry over
  await fetch(new URL('/__mock/reset', url), { method: 'POST' }).catch(() => {});
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  ctx.setDefaultTimeout(2500);
  if (mode === 'desktop') await ctx.addInitScript(() => (window.__TAURI_INTERNALS__ = { invoke: async () => null }));
  const p = await ctx.newPage();
  if (at) await p.clock.setFixedTime(new Date(at));
  // the peer's answers take 400 ms; the page's own requests (the stream, the bundle) don't
  await p.route('**/api/events', async (route) => {
    if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, DELAY));
    await route.continue();
  });
  await p.goto(url);
  await p.locator('[data-part="shell.app"]').first().waitFor({ state: 'attached', timeout: 20_000 });
  await p.waitForTimeout(500);
  await opener(p).catch(() => {});
  await p.mouse.move(0, size[1] - 1);
  await p.waitForTimeout(900);
  return { ctx, p };
}

const commandOf = (req) => {
  try {
    const m = JSON.parse(req.postData() ?? '{}');
    return m.t === 'mutate' ? m.cmd : undefined;
  } catch {
    return undefined;
  }
};

/** One press: what changed within the budget, whether it sent a command, whether it went pending. */
async function press(p, target, size) {
  const loc = p.locator(INTERACTIVE).nth(target.nth);
  const [x, y, w, h] = target.box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  await p.mouse.move(cx, cy);
  await p.waitForTimeout(250);
  const before = await p.screenshot();
  const sent = [];
  const onReq = (req) => {
    const c = req.method() === 'POST' && req.url().includes('/api/events') ? commandOf(req) : undefined;
    if (c) sent.push(c);
  };
  p.on('request', onReq);
  const popup = p.context().waitForEvent('page', { timeout: BUDGET + 400 }).then(() => true, () => false);
  await p.evaluate(watch);
  const t0 = Date.now();
  if (target.tag === 'textarea' || target.tag === 'input') {
    await loc.focus();
    await p.keyboard.type('x');
    await p.keyboard.press('Enter');
  } else {
    await p.mouse.down();
    await p.mouse.up();
  }
  // the first frame after the press, then the budget's end
  const shot1 = await p.screenshot();
  const took = Date.now() - t0;
  const dom = await p.evaluate(() => {
    const w = window.__fb;
    return { ms: w.first && w.at ? w.first - w.at : w.first ? 0 : -1, focusMoved: document.activeElement !== w.focus };
  });
  let changed = diffImages(decodePng(before), decodePng(shot1)).differing > 0;
  let after = shot1;
  if (!changed && took < BUDGET) {
    await p.waitForTimeout(BUDGET - took);
    after = await p.screenshot();
    changed = diffImages(decodePng(before), decodePng(after)).differing > 0;
  }
  const navigated = await popup;
  p.off('request', onReq);
  const pending = await loc.evaluate((el) => el.getAttribute('aria-busy') === 'true' || el.hasAttribute('data-pending')).catch(() => false);
  const ok = (dom.ms >= 0 && dom.ms <= BUDGET) || (changed && took <= BUDGET + 60) || navigated || dom.focusMoved;
  return { ok, ms: dom.ms, shot: changed, navigated, focusMoved: dom.focusMoved, sent, pending, before, after };
}

async function checkView(browser, url, name, opener, size, mode, at, outDir) {
  const res = { view: name, width: size[0], mode, targets: [], pass: 0, fail: 0, skipped: 0 };
  let first = await open(browser, url, opener, size, mode, at);
  const targets = await first.p.evaluate(listTargets, INTERACTIVE);
  await first.ctx.close();
  for (const target of targets) {
    if (target.skip) {
      res.skipped++;
      res.targets.push({ ...target, result: `skipped: ${target.skip}` });
      continue;
    }
    const { ctx, p } = await open(browser, url, opener, size, mode, at);
    let line;
    try {
      const r = await press(p, target, size);
      const notes = [];
      if (!r.ok) {
        const file = path.join(outDir, `${name}-${mode}-${size[0]}-${target.nth}`);
        fs.writeFileSync(`${file}.before.png`, r.before);
        fs.writeFileSync(`${file}.after.png`, r.after);
      }
      // 2. pending: a second press does nothing (no second command)
      if (r.pending) {
        const again = [];
        const on = (req) => {
          const c = req.method() === 'POST' && req.url().includes('/api/events') ? commandOf(req) : undefined;
          if (c) again.push(c);
        };
        p.on('request', on);
        await p.mouse.down();
        await p.mouse.up();
        await p.waitForTimeout(150);
        p.off('request', on);
        if (again.length) notes.push(`pressed again while pending: sent ${again.join(', ')}`);
      }
      // 3. refused: roll back and say why
      let refusal = '';
      if (r.sent.length) {
        const cmd = r.sent[0];
        const { ctx: c2, p: p2 } = await open(browser, url, opener, size, mode, at);
        try {
          await fetch(new URL(`/__mock/fail?cmd=${encodeURIComponent(cmd)}`, url), { method: 'POST' });
          const target2 = (await p2.evaluate(listTargets, INTERACTIVE)).find((t) => t.nth === target.nth) ?? target;
          await p2.mouse.move(target2.box[0] + target2.box[2] / 2, target2.box[1] + target2.box[3] / 2);
          await p2.waitForTimeout(250);
          const text = target.tag === 'textarea' || target.tag === 'input';
          if (text) {
            await p2.locator(INTERACTIVE).nth(target.nth).focus();
            await p2.keyboard.type('x');
          }
          const t0 = Date.now();
          if (text) await p2.keyboard.press('Enter');
          else {
            await p2.mouse.down();
            await p2.mouse.up();
          }
          // the refusal arrives after DELAY: a toast within BUDGET of it
          const TOASTS = '[data-kit="toast"], [role="status"][data-part*="toast"], [data-part="ui.toast"]';
          const toast = await p2
            .locator(TOASTS)
            .first()
            .waitFor({ state: 'visible', timeout: Math.max(1, DELAY + BUDGET - (Date.now() - t0)) })
            .then(() => true, () => false);
          refusal = toast ? `refused ${cmd}: toast` : `refused ${cmd}: no toast within ${DELAY + BUDGET} ms`;
          if (!toast) notes.push(`${cmd} refused: no toast within ${BUDGET} ms of the refusal`);
          // rolled back: the toast hidden, the accepted press's optimistic change is gone
          await p2.waitForTimeout(BUDGET);
          await p2.evaluate((sel) => document.querySelectorAll(sel).forEach((n) => (n.style.visibility = 'hidden')), TOASTS);
          const now = await p2.screenshot();
          const showed = diffImages(decodePng(r.before), decodePng(r.after)).differing > ROLLBACK_SLACK;
          const still = diffImages(decodePng(r.after), decodePng(now)).differing <= ROLLBACK_SLACK;
          if (showed && still) {
            notes.push(`${cmd} refused: the screen still shows the accepted change (no rollback)`);
            const file = path.join(outDir, `${name}-${mode}-${size[0]}-${target.nth}-rollback`);
            fs.writeFileSync(`${file}.accepted.png`, r.after);
            fs.writeFileSync(`${file}.refused.png`, now);
          }
        } finally {
          await c2.close();
        }
      }
      const ok = r.ok && notes.length === 0;
      line = { ...target, result: ok ? 'pass' : 'fail', how: r.navigated ? 'opened a page' : r.ms >= 0 ? `DOM changed in ${Math.round(r.ms)} ms` : r.shot ? 'repainted' : r.focusMoved ? 'focus moved' : 'nothing changed', sent: r.sent, pending: r.pending, refusal, notes };
      if (ok) res.pass++;
      else res.fail++;
    } catch (err) {
      res.fail++;
      line = { ...target, result: 'fail', how: String(err?.message || err).split('\n')[0].slice(0, 120) };
    } finally {
      await ctx.close();
    }
    res.targets.push(line);
  }
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ref = path.join(ROOT, 'design', 'v1-reference');
  const outDir = path.join(OUT, 'feedback');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const seedFile = path.join(ref, 'seed.json');
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const tr = translator(seed);
  const openers = views({ tasks: seed.seeded.tasks.map((id) => ({ id })), goal: { id: seed.seeded.goal } });
  const v2Page = (p) => new Proxy(p, { get: (t, k) => (k === 'locator' ? (s, o) => t.locator(tr(s), o) : k === 'isVisible' ? (s, o) => t.isVisible(tr(s), o) : k === 'fill' ? (s, v, o) => t.fill(tr(s), v, o) : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  const names = (arg('views') ?? 'home,task,task.composer').split(',');
  const widths = (arg('widths') ?? '1440,390,320').split(',').map(Number);
  const modes = (arg('modes') ?? 'desktop,browser').split(',');
  const v2 = process.env.FEEDBACK_URL ? { url: process.env.FEEDBACK_URL, stop: () => {} } : await startV2(seedFile);
  const browser = await launchBrowser();
  const results = [];
  for (const name of names)
    for (const w of widths)
      for (const mode of modes) {
        const at = ((m) => m.clock ?? m.captured)(JSON.parse(fs.readFileSync(path.join(ref, name, 'metrics.json'), 'utf8')));
        const r = await checkView(browser, v2.url, name, (p) => openers[name](v2Page(p)), SIZES[w], mode, at, outDir);
        results.push(r);
        console.log(`  ${r.fail ? '✗' : '✔'} ${name} ${mode} ${w}: ${r.pass} pass, ${r.fail} fail, ${r.skipped} skipped`);
        for (const t of r.targets.filter((x) => x.result === 'fail')) console.log(`      ✗ ${t.part || t.tag} “${t.name}”: ${t.how}${t.notes?.length ? ` · ${t.notes.join('; ')}` : ''}`);
      }
  await browser.close();
  v2.stop();
  const total = results.reduce((a, r) => ({ pass: a.pass + r.pass, fail: a.fail + r.fail, skipped: a.skipped + r.skipped }), { pass: 0, fail: 0, skipped: 0 });
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ total, results }, null, 2));
  const md = [
    `# Feedback: every action answers within ${BUDGET} ms (${new Date().toISOString()})`,
    '',
    `${total.pass} pass · ${total.fail} fail · ${total.skipped} skipped (already chosen or disabled) · answers delayed ${DELAY} ms`,
    '',
    '| View | Mode | Width | Pass | Fail | Skipped |',
    '|---|---|---:|---:|---:|---:|',
    ...results.map((r) => `| ${r.view} | ${r.mode} | ${r.width} | ${r.pass} | ${r.fail} | ${r.skipped} |`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'summary.md'), md);
  console.log(`\n${md}`);
  process.exit(total.fail ? 1 : 0);
}
