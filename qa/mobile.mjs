// QA for the Android app's browser side (qa/scenarios/mobile.md): the computers screen
// (mobile/www with its mock plugin) and wisp's own page as the app's WebView shows it (a phone
// viewport, touch, and `wispMobile` in the user agent). The APK, Gradle and emulator checks are
// in the scenarios file.
//
//   node qa/mobile.mjs            needs `npm install` in mobile/ (Capacitor's JS for the preview)

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { until } from '../test/helpers.js';
import { CHROME, OUT, ROOT, api, ok, playwright, runner, startWisp } from './lib.mjs';

const PHONES = [
  { name: 'pixel', width: 412, height: 915 },
  { name: 'iphone', width: 390, height: 844 },
];
const UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro XL) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 wispMobile';
const COMPUTER = 'Studio';
const PREVIEW_PORT = 4541;

const { check, done } = runner('mobile');
const { chromium } = playwright();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const phone = (vp, extra = {}) => browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: true, hasTouch: true, userAgent: UA, deviceScaleFactor: 2, ...extra });
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `mobile-${name}.png`) });

// The computers screen: www/ with the mock plugin, as `npm run preview` serves it.
execFileSync(process.execPath, ['scripts/shared.mjs'], { cwd: path.join(ROOT, 'mobile'), stdio: 'ignore' });
const preview = spawn(process.execPath, ['scripts/preview.mjs'], { cwd: path.join(ROOT, 'mobile'), env: { ...process.env, PORT: String(PREVIEW_PORT) }, stdio: 'ignore' });
const previewUrl = `http://127.0.0.1:${PREVIEW_PORT}/`;
await until(async () => (await fetch(previewUrl)).ok, { what: 'mobile preview' });

const wisp = await startWisp({ port: 4542 });
// A project with a finished task, so the page has something to show and to cache.
const first = await api(wisp.url, '/api/sessions', { prompt: 'fix the add function', cwd: wisp.repo, agent: 'claude' });
await until(async () => (await api(wisp.url, `/api/sessions/${first.json.id}`)).json?.state !== 'running', { timeout: 60_000, what: 'first task' });

try {
  for (const vp of PHONES) {
    await check(`MOB-03`, `computers screen at ${vp.width}px: GitHub and Google first, no address to type, SSH folded, no overflow`, async () => {
      const ctx = await phone(vp);
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(previewUrl);
      await page.waitForSelector('.hello [data-p="github"]', { timeout: 10_000 });
      const order = await page.evaluate(() => {
        const gh = document.querySelector('[data-p="github"]');
        const ssh = document.querySelector('#sshBox');
        return { cloudBeforeSsh: !!(gh.compareDocumentPosition(ssh) & Node.DOCUMENT_POSITION_FOLLOWING), sshOpen: ssh.open, google: !!document.querySelector('[data-p="google"]'), input: !!document.querySelector('#intro input') };
      });
      ok(order.cloudBeforeSsh, 'GitHub sign-in is not above Connect over SSH');
      ok(order.google, 'no Continue with Google');
      ok(!order.input, 'the first screen asks for a grid address');
      ok(!order.sshOpen, 'Connect over SSH is unfolded on start');
      ok((await overflow(page)) <= 0, `page scrolls sideways by ${await overflow(page)}px`);
      ok(!errors.length, `page errors: ${errors.join('; ')}`);
      await shot(page, `computers-${vp.name}`);
      await ctx.close();
    });
  }

  await check('MOB-04', 'app start stays on the computers list (never auto-enters the last computer)', async () => {
    const ctx = await phone(PHONES[0]);
    const page = await ctx.newPage();
    // A saved SSH computer, used a moment ago: the list must still show, not open it.
    await page.addInitScript(() => {
      if (!localStorage.getItem('wisp.machines.seeded')) {
        localStorage.setItem('wisp.machines.seeded', '1');
        localStorage.setItem('wisp.machines', JSON.stringify([{ id: 'm1', name: 'Studio', target: 'me@studio', port: 4477, lastUsed: Date.now() }]));
      }
    });
    let toasts = 0;
    page.on('console', () => {});
    await page.goto(previewUrl);
    await page.waitForSelector('#machines [data-id="m1"]', { timeout: 10_000 });
    await page.waitForTimeout(1500);
    ok(new URL(page.url()).port === String(PREVIEW_PORT), `left the list for ${page.url()}`);
    toasts = await page.evaluate(() => [...document.querySelectorAll('.toast, [class*=toast]')].filter((t) => /Opens wisp/.test(t.textContent)).length);
    ok(toasts === 0, 'it tried to open a computer by itself');
    await shot(page, 'computers-start');
    await ctx.close();
  });

  for (const vp of PHONES) {
    await check('MOB-05', `wisp page in the app at ${vp.width}px: Computers button, ${COMPUTER} named, no desktop-only UI`, async () => {
      const ctx = await phone(vp);
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${wisp.url}/?m=${COMPUTER}`);
      await page.waitForSelector('body.wisp-mobile', { timeout: 10_000 });
      await page.waitForTimeout(1500);
      const ui = await page.evaluate(() => {
        const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
        return {
          machines: document.querySelector('#machinesBtn span')?.textContent,
          fab: vis(document.querySelector('#promptFab')),
          stacked: document.body.classList.contains('split') && document.body.classList.contains('stack') && !document.body.classList.contains('stack-page'),
          newRow: vis(document.querySelector('#splitNew')),
          kbd: [...document.querySelectorAll('kbd, .key-hint')].filter(vis).length,
          view: vis(document.querySelector('#viewBtn')),
          thisComputer: /This computer/.test(document.body.innerText),
          tips: /More tips/.test(document.body.innerText),
        };
      });
      ok(ui.machines === `Computers ${COMPUTER}`, `the computers row reads "${ui.machines}", expected "Computers ${COMPUTER}"`);
      ok(ui.fab, 'no floating New task button');
      ok(ui.stacked, 'not the stacked task list');
      ok(!ui.newRow, 'the list shows its New task row beside the floating button');
      ok(ui.kbd === 0, `${ui.kbd} keyboard hints visible`);
      ok(!ui.view, 'the sidebar switch shows');
      ok(!ui.thisComputer, '"This computer" shows instead of the computer name');
      ok(!ui.tips, 'tips show on the phone');
      ok((await overflow(page)) <= 0, `page scrolls sideways by ${await overflow(page)}px`);
      ok(!errors.length, `page errors: ${errors.join('; ')}`);
      await shot(page, `page-${vp.name}`);
      await ctx.close();
    });
  }

  await check('MOB-06', 'Computers button leaves for the app’s list; the card menu has no “Open project in editor”', async () => {
    const ctx = await phone(PHONES[0]);
    const page = await ctx.newPage();
    await page.goto(`${wisp.url}/?m=${COMPUTER}`);
    await page.waitForSelector('body.wisp-mobile');
    // Open the finished task and its More menu.
    await page.locator(`.item[data-id="${first.json.id}"] .it-head`).tap();
    await page.waitForTimeout(800);
    ok(await page.evaluate(() => document.body.classList.contains('stack-page')), 'the task did not open as a page');
    await shot(page, 'task-page');
    const more = page.locator('.item.open [data-a="more"], .item.open button[title*="More" i]').first();
    if (await more.count()) {
      await more.tap();
      await page.waitForSelector('.menu:not(#meMenu)', { timeout: 5000 });
      const text = await page.locator('.menu:not(#meMenu)').innerText();
      ok(!/Open project in editor/.test(text), 'More menu offers “Open project in editor”');
      ok(/Delete task/.test(text), 'More menu is missing Delete task');
      await shot(page, 'more-menu');
      await page.keyboard.press('Escape');
    } else throw new Error('no More button on the open task');
    // The phone's Back (history back in the WebView) closes the page: back on the list.
    await page.goBack();
    await page.waitForFunction(() => !document.body.classList.contains('stack-page'), null, { timeout: 5000 });
    // The Computers button goes to https://localhost/ (the app's list); in Chrome that just fails to load.
    const nav = page.waitForRequest((r) => r.url().startsWith('https://localhost/'), { timeout: 5000 });
    await page.locator('#meBtn').tap(); // the computer is a row in the avatar's menu
    await page.locator('#machinesBtn').tap();
    const req = await nav;
    ok(new URL(req.url()).searchParams.get('from') === COMPUTER, `went to ${req.url()}`);
    await ctx.close();
  });

  await check('MOB-07', 'launch from home (New task) with a fake agent; the presentation renders', async () => {
    const ctx = await phone(PHONES[1]);
    const page = await ctx.newPage();
    const before = new Set((await api(wisp.url, '/api/sessions')).json.map((s) => s.id));
    await page.goto(`${wisp.url}/?m=${COMPUTER}`);
    await page.waitForSelector('#promptFab');
    await page.locator('#promptFab').tap();
    ok(await page.evaluate(() => document.body.classList.contains('stack-page') && document.activeElement?.id === 'prompt'), 'home did not open with the prompt focused');
    await page.locator('#prompt').fill('add a subtract function');
    await page.waitForTimeout(400); // the page slides in (stack-in): shoot it settled
    await shot(page, 'home');
    ok((await overflow(page)) <= 0, 'home scrolls sideways');
    await page.locator('#launch').tap();
    await page.waitForFunction(() => !document.body.classList.contains('stack-page'), null, { timeout: 5000 });
    // Its card shows up and finishes with the fake agent's report.
    const id = await until(async () => (await api(wisp.url, '/api/sessions')).json?.find((s) => !before.has(s.id))?.id, { what: 'the launched task' });
    await until(async () => (await api(wisp.url, `/api/sessions/${id}`)).json?.state !== 'running', { timeout: 60_000, what: 'the launched task to finish' });
    const card = page.locator(`.item[data-id="${id}"]`);
    await card.waitFor({ timeout: 10_000 });
    if (!(await card.evaluate((n) => n.classList.contains('open')))) await card.locator('.it-head').tap();
    await page.waitForSelector('.item.open .block, .item.open [class*="hero"]', { timeout: 15_000 });
    ok((await overflow(page)) <= 0, `the open task scrolls sideways by ${await overflow(page)}px`);
    await shot(page, 'presentation');
    await ctx.close();
  });

  await check('MOB-08', 'a long URL in a prompt wraps instead of widening the page', async () => {
    const url = `https://example.com/${'very-long-path-segment-'.repeat(12)}?q=${'x'.repeat(80)}`;
    const s = await api(wisp.url, '/api/sessions', { prompt: `look at ${url}`, cwd: wisp.repo, agent: 'claude' });
    await until(async () => (await api(wisp.url, `/api/sessions/${s.json.id}`)).json?.state !== 'running', { timeout: 60_000, what: 'url task' });
    const ctx = await phone(PHONES[1]);
    const page = await ctx.newPage();
    await page.goto(`${wisp.url}/?m=${COMPUTER}#/s/${s.json.id}`);
    // The task's page (the list under it is laid out but hidden).
    await page.waitForSelector('.item.open > .it-body', { timeout: 10_000 });
    await page.waitForTimeout(1000);
    ok((await overflow(page)) <= 0, `page scrolls sideways by ${await overflow(page)}px`);
    await shot(page, 'long-url');
    await ctx.close();
  });

  await check('MOB-09', 'a task finishing in the background posts an Android notification through window.wispAndroid', async () => {
    const ctx = await phone(PHONES[0]);
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.__notes = [];
      window.wispAndroid = {
        permission: () => 'granted',
        requestPermission: () => {},
        foreground: () => false, // the app sits in the background
        notify: (id, title, body) => window.__notes.push({ id, title, body }),
        tunnel: () => 'null',
      };
    });
    await page.goto(`${wisp.url}/?m=${COMPUTER}`);
    await page.waitForSelector('body.wisp-mobile');
    await page.waitForTimeout(1000);
    const s = await api(wisp.url, '/api/sessions', { prompt: 'write a haiku about tunnels', cwd: wisp.repo, agent: 'claude' });
    await page.waitForFunction((id) => window.__notes.some((n) => n.id === id), s.json.id, { timeout: 60_000 });
    const note = await page.evaluate((id) => window.__notes.find((n) => n.id === id), s.json.id);
    ok(note.title && note.title.includes(':'), `notification title "${note.title}"`);
    // A tap on it opens the task (MainActivity calls window.wispOpen).
    await page.evaluate((id) => window.wispOpen(id), s.json.id);
    await page.waitForSelector(`.item.open[data-id="${s.json.id}"] > .it-body`, { timeout: 5000 });
    await ctx.close();
  });

  await check('MOB-10', 'service worker caches the page; offline reopen paints the last tasks', async () => {
    const ctx = await phone(PHONES[0], { serviceWorkers: 'allow' });
    const page = await ctx.newPage();
    await page.goto(`${wisp.url}/?m=${COMPUTER}`);
    await page.waitForSelector('.item');
    await page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.getRegistration().then((r) => !!r?.active), null, { timeout: 15_000 });
    await page.reload();
    await page.waitForSelector('.item');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10_000 });
    // Leave the page so the snapshot is written (the app does on going to the background).
    await page.evaluate(() => dispatchEvent(new Event('pagehide')));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await ctx.setOffline(true);
    const t0 = Date.now();
    await page.reload();
    await page.waitForSelector('.item', { timeout: 10_000 });
    const ms = Date.now() - t0;
    const titles = await page.locator('.item').count();
    ok(titles > 0, 'nothing painted offline');
    await shot(page, 'offline');
    await ctx.setOffline(false);
    await ctx.close();
    console.log(`      offline first paint: ${titles} tasks in ${ms}ms`);
  });
} finally {
  await browser.close();
  wisp.stop();
  preview.kill();
}
process.exit(done());
