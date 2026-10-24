// QA for wisp Grid (qa/scenarios/grid.md): a dev grid with fake agents in a temp data dir, driven
// through its pages in Chrome and through its device API.
//
//   node qa/grid.mjs            (QA_GRID_PORT=8090 by default; screenshots in qa/out/grid-*.png)

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CHROME, OUT, ROOT, ok, playwright, runner } from './lib.mjs';

const PORT = Number(process.env.QA_GRID_PORT) || 8090;
const IDLE = 6; // seconds before a quiet box is stopped
const DOMAIN = 'wisp.localhost';
const GRID = `http://${DOMAIN}:${PORT}`;
const inst = (handle) => `http://${handle}.${DOMAIN}:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-qa-grid-'));
const WISP = path.join(ROOT, 'bin/wisp.js');
const env = { ...process.env, WISP_TELEMETRY: '0', WISP_FEEDBACK: '0', DO_NOT_TRACK: '1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Node can't resolve *.localhost everywhere: talk to 127.0.0.1 with the Host header instead.
function req(url, { method = 'GET', headers = {}, body } = {}) {
  const u = new URL(url);
  const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method, headers: { host: u.host, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    r.on('error', reject);
    r.setTimeout(60_000, () => r.destroy(new Error(`timeout ${method} ${url}`)));
    if (data) r.write(data);
    r.end();
  });
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });
async function until(fn, ms = 30_000, what = '') {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
    await sleep(300);
  }
}
const cli = (...args) => execFileSync(process.execPath, [WISP, 'grid', ...args, '--data', data], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const { check, done } = runner('grid');
const log = fs.openSync(path.join(OUT, 'grid-server.log'), 'w');
const grid = spawn(process.execPath, [WISP, 'grid', 'dev', '--fake-agents', '--port', String(PORT), '--data', data, '--idle', String(IDLE), '--fake-delay', '800'], { env, stdio: ['ignore', log, log] });
const { chromium } = playwright();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = []; // page errors + console errors, per page
const page = async (ctx, label) => {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`));
  return p;
};
const shot = (p, name) => p.screenshot({ path: path.join(OUT, `grid-${name}.png`) });

async function devSignIn(p, email, name) {
  await p.goto(`${GRID}/signin`);
  await p.click('a[href^="/auth/dev/start"]');
  await p.fill('input[name=email]', email);
  if (name) await p.fill('input[name=name]', name);
  await p.click('button[type=submit]');
  await p.waitForLoadState('domcontentloaded');
}
const handleOf = (p) => p.locator('.me .who').first().textContent();
const csrfOf = (p) => p.locator('input[name=csrf]').first().getAttribute('value');

let A; // { ctx, page, handle }
let B;
let token = '';
let deviceId = '';
let taskId = '';

try {
  await check('GRID-01', 'grid dev --fake-agents boots and answers /healthz', async () => {
    const r = await until(() => req(`${GRID}/healthz`).then((r) => r.status === 200 && r), 30_000, 'the grid');
    ok(r.json?.ok === true, `/healthz said ${r.text}`);
    ok(fs.existsSync(path.join(data, 'fake-bin', 'claude')), 'fake agents were not installed in the data dir');
  });

  await check('GRID-02', 'sign-in page renders at desktop and phone width', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await page(ctx, 'signin');
    const r = await p.goto(`${GRID}/`);
    ok(r.status() === 200, `GET / → ${r.status()}`);
    ok(await p.locator('a[href^="/auth/dev/start"]').count(), 'no dev sign-in button');
    await shot(p, 'signin-desktop');
    await p.setViewportSize({ width: 390, height: 844 });
    await p.reload();
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(overflow <= 1, `page scrolls sideways by ${overflow}px on a phone`);
    await shot(p, 'signin-phone');
    await ctx.close();
  });

  await check('GRID-03', 'dev sign-in with an email lands on the account page', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await page(ctx, 'account-a');
    await devSignIn(p, 'ada@example.com', 'Ada');
    const handle = (await handleOf(p))?.trim();
    ok(handle === 'ada', `handle is ${handle}, wanted ada`);
    A = { ctx, page: p, handle };
  });

  await check('GRID-04', 'account page shows Open, devices, delete; fits a phone', async () => {
    const p = A.page;
    ok(await p.locator('a.primary[href="/go"]').count(), 'no Open link to /go');
    ok(await p.locator('form[action="/account/delete"]').count(), 'no Delete your account form');
    ok(await p.locator('form[action="/signout?all=1"]').count(), 'no Sign out everywhere');
    await shot(p, 'account-desktop');
    await p.setViewportSize({ width: 390, height: 844 });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await shot(p, 'account-phone');
    await p.setViewportSize({ width: 1440, height: 900 });
    ok(overflow <= 1, `account page scrolls sideways by ${overflow}px on a phone`);
  });

  let wispPage;
  await check('GRID-05', 'Open → <handle>.wisp.localhost loads the user’s wisp with no console errors', async () => {
    const before = errors.length;
    wispPage = await page(A.ctx, 'cloud-wisp');
    await wispPage.goto(`${GRID}/go`);
    // A slow start shows the waking page first, which reloads itself into wisp.
    await wispPage.waitForSelector('#prompt', { timeout: 60_000 });
    ok(new URL(wispPage.url()).host === `${A.handle}.${DOMAIN}:${PORT}`, `ended at ${wispPage.url()}`);
    await wispPage.waitForTimeout(1500);
    await shot(wispPage, 'cloud-wisp-desktop');
    const errs = errors.slice(before);
    ok(!errs.length, `console errors: ${errs.join(' | ')}`);
  });

  await check('GRID-06', 'a task launched in the cloud wisp runs on a fake agent and ends with a presentation', async () => {
    const p = wispPage;
    await p.fill('#prompt', 'QA: say hello from the grid');
    await p.keyboard.press('Enter');
    const s = await until(
      () => p.evaluate(async () => (await (await fetch('/api/sessions')).json()).find((x) => /hello from the grid/.test(x.prompt || x.title || ''))),
      20_000,
      'the session to appear',
    );
    const fin = await until(
      () => p.evaluate(async (id) => {
        const r = await (await fetch(`/api/sessions/${id}`)).json();
        return r.state !== 'running' && r;
      }, s.id),
      60_000,
      'the run to finish',
    );
    taskId = s.id;
    const pres = JSON.stringify(fin.turns?.at(-1) || fin).includes('"blocks"');
    ok(pres, `finished as ${fin.state} without a presentation`);
    await p.waitForTimeout(1500);
    await shot(p, 'cloud-wisp-task');
    await p.setViewportSize({ width: 390, height: 844 });
    await p.waitForTimeout(800);
    await shot(p, 'cloud-wisp-phone');
    await p.setViewportSize({ width: 1440, height: 900 });
  });

  await check('GRID-07', 'cookie isolation: one user can’t reach another’s wisp', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await page(ctx, 'account-b');
    await devSignIn(p, 'bob@example.com', 'Bob');
    B = { ctx, page: p, handle: (await handleOf(p))?.trim() };
    ok(B.handle === 'bob', `second handle is ${B.handle}`);
    // A's browser at B's address: no cookie there, so /go sends it to A's own wisp.
    const q = await A.ctx.newPage();
    await q.goto(`${inst(B.handle)}/`);
    await q.waitForLoadState('domcontentloaded');
    const host = new URL(q.url()).host;
    await q.close();
    ok(host !== `${B.handle}.${DOMAIN}:${PORT}`, `A's browser stayed on B's wisp (${q.url()})`);
    // B's API without a cookie or with A's wisp cookie: 401.
    const aCookie = (await A.ctx.cookies(inst(A.handle))).find((c) => c.name === 'wisp_grid');
    ok(aCookie, 'A has no wisp_grid cookie for its own address');
    ok(aCookie.domain.replace(/^\./, '') === `${A.handle}.${DOMAIN}`, `A's wisp cookie is scoped to ${aCookie.domain}`);
    const r = await req(`${inst(B.handle)}/api/sessions`, { headers: { cookie: `wisp_grid=${aCookie.value}` } });
    ok(r.status === 401, `A's cookie on B's API → ${r.status}`);
    // A's own cookie, posted from another origin: 403.
    const x = await req(`${inst(A.handle)}/api/sessions`, { method: 'POST', headers: { cookie: `wisp_grid=${aCookie.value}`, origin: 'http://evil.example' }, body: { prompt: 'x', scratch: true } });
    ok(x.status === 403, `cross-origin POST with A's cookie → ${x.status}`);
  });

  await check('GRID-08', '/api/seats is public and /api/status answers inside the box', async () => {
    const s = await req(`${GRID}/api/seats`);
    ok(s.status === 200 && 'open' in (s.json || {}), `/api/seats → ${s.status} ${s.text}`);
    ok(s.headers['access-control-allow-origin'] === '*', '/api/seats has no CORS header');
    const st = await wispPage.evaluate(async () => (await fetch('/api/status')).json());
    ok(typeof st.live === 'number' && typeof st.clients === 'number', `/api/status → ${JSON.stringify(st)}`);
  });

  await check('GRID-09', 'device flow: code → /activate Allow → token → /api/me and the edge', async () => {
    const c = await req(`${GRID}/api/device/code`, { method: 'POST', body: { name: 'QA phone' } });
    ok(c.status === 200 && c.json?.user_code && c.json?.device_code, `code → ${c.status} ${c.text}`);
    const pending = await req(`${GRID}/api/device/token`, { method: 'POST', body: { device_code: c.json.device_code } });
    ok(pending.status === 400, `token before Allow → ${pending.status}`);
    const p = A.page;
    await p.goto(c.json.verification_uri_complete.replace(`http://${DOMAIN}:${PORT}`, GRID));
    await shot(p, 'activate');
    await p.click('button[name=answer][value=allow]');
    ok(/Device connected/.test(await p.textContent('body')), 'no "Device connected" message');
    const t = await until(async () => {
      const r = await req(`${GRID}/api/device/token`, { method: 'POST', body: { device_code: c.json.device_code } });
      return r.status === 200 && r.json?.token;
    }, 15_000, 'the token');
    token = t;
    const me = await req(`${GRID}/api/me`, { headers: bearer(token) });
    ok(me.status === 200 && me.json?.user?.handle === A.handle, `/api/me → ${me.status} ${me.text}`);
    deviceId = me.json.device.id;
    const h = await req(`${inst(A.handle)}/api/sessions`, { headers: bearer(token) });
    ok(h.status === 200 && Array.isArray(h.json), `edge with the token → ${h.status}`);
    const other = await req(`${inst(B.handle)}/api/sessions`, { headers: bearer(token) });
    ok(other.status === 401, `A's token on B's wisp → ${other.status}`);
    const link = await req(`${GRID}/api/device/link`, { method: 'POST', headers: bearer(token), body: {} });
    ok(link.status === 200 && /\/_grid\/auth\?t=/.test(link.json?.url || ''), `device/link → ${link.text}`);
  });

  await check('GRID-10', 'idle: a quiet box stops after --idle and wakes on the next request', async () => {
    await wispPage.close(); // an open page keeps it awake
    await sleep(1000);
    const state = async () => (await req(`${inst(A.handle)}/_grid/state`, { headers: bearer(token) })).json?.state;
    await until(async () => (await state()) === 'stopped', (IDLE + 30) * 1000, 'the box to stop');
    const r = await req(`${inst(A.handle)}/api/sessions`, { headers: bearer(token) });
    ok(r.status === 200 && Array.isArray(r.json), `request after idle → ${r.status} ${r.text.slice(0, 120)}`);
    ok(r.json.some((s) => s.id === taskId), `the earlier task is gone after waking: ${JSON.stringify(r.json.map((s) => [s.title, s.state]))}`);
    ok((await state()) === 'running', 'not running after the wake');
  });

  await check('GRID-11', 'account page lists the device; Remove revokes its token', async () => {
    const p = A.page;
    await p.goto(`${GRID}/`);
    const form = p.locator(`form[action="/devices/${deviceId}/revoke"]`);
    ok(await form.count(), 'device not listed on the account page');
    await form.locator('button').click();
    await p.waitForLoadState('domcontentloaded');
    ok(/Device removed/.test(await p.textContent('body')), 'no "Device removed." flash');
    const me = await req(`${GRID}/api/me`, { headers: bearer(token) });
    ok(me.status === 401, `/api/me after Remove → ${me.status}`);
    const e = await req(`${inst(A.handle)}/api/sessions`, { headers: bearer(token) });
    ok(e.status === 401, `edge after Remove → ${e.status}`);
  });

  await check('GRID-12', 'grid doctor / users / backup on the dev data dir', async () => {
    // A dev data dir has no provider in grid.json (dev sign-in is a `grid dev` flag), so doctor's
    // one expected ✗ is the sign-in line; anything else failing is a finding.
    let doc;
    try {
      doc = cli('doctor');
    } catch (e) {
      doc = String(e.stdout || '') + String(e.stderr || '');
    }
    const bad = doc.split('\n').filter((l) => l.includes('✗') && !/no provider enabled/.test(l));
    ok(/✓ Node\.js/.test(doc) && /master key readable/.test(doc) && !bad.length, `doctor: ${bad.join(' / ') || doc}`);
    const users = cli('users');
    ok(/^ada\b/m.test(users) && /^bob\b/m.test(users), `users: ${users}`);
    const file = path.join(data, 'qa-backup.db');
    cli('backup', file);
    ok(fs.statSync(file).size > 0, 'backup file is empty');
  });

  await check('GRID-13', 'Delete your account: typed handle, its box, files and address go', async () => {
    const p = B.page;
    // Start B's box first so there is a home to delete.
    const go = await B.ctx.newPage();
    await go.goto(`${GRID}/go`);
    await go.waitForSelector('#prompt', { timeout: 60_000 });
    await go.close();
    const homes = () => (fs.existsSync(path.join(data, 'users')) ? fs.readdirSync(path.join(data, 'users')) : []);
    const before = homes();
    await p.goto(`${GRID}/`);
    const f = p.locator('form[action="/account/delete"]');
    await f.locator('input[name=confirm]').fill(B.handle);
    await f.locator('button').click();
    await p.waitForLoadState('domcontentloaded');
    await shot(p, 'deleted');
    ok(/Account deleted/.test(await p.textContent('body')), 'no "Account deleted" page');
    ok(!/^bob\b/m.test(cli('users')), 'bob still listed by grid users');
    const r = await req(`${inst(B.handle)}/`, { headers: { accept: 'text/html' } });
    ok(r.status === 404 && /No such wisp/.test(r.text), `B's address after deletion → ${r.status}`);
    ok(homes().length === before.length - 1, `user folders ${before.length} → ${homes().length}: B's files left behind`);
  });

  await check('GRID-14', 'no console errors on any grid page during the run', async () => {
    ok(!errors.length, errors.slice(0, 5).join(' | '));
  });
} finally {
  await browser.close().catch(() => {});
  grid.kill('SIGTERM');
  await new Promise((r) => {
    grid.once('exit', r);
    setTimeout(() => {
      grid.kill('SIGKILL');
      r();
    }, 10_000);
  });
  if (!process.env.QA_KEEP) fs.rmSync(data, { recursive: true, force: true });
}
process.exit(done());
