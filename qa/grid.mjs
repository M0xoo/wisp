// QA for wisp Grid (qa/scenarios/grid.md): a dev grid with fake agents in a temp data dir, driven
// through its pages in Chrome and through its device API.
//
//   node qa/grid.mjs            (QA_GRID_PORT=8090 by default; screenshots in qa/out/grid-*.png)

import { execFileSync, spawn } from 'node:child_process';
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { dkimSign, keyRecord } from '../test/fixtures/dkim-sign.mjs';
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

// Telegram, for GRID-31: answers everything, and keeps what it heard.
const tg = { calls: [], hook: null, msg: 100 };
const fakeTelegram = http.createServer(async (rq, rs) => {
  let t = '';
  for await (const c of rq) t += c;
  const method = new URL(rq.url, 'http://x').pathname.split('/').pop();
  const b = t ? JSON.parse(t) : {};
  tg.calls.push({ method, ...b });
  if (method === 'setWebhook') tg.hook = b;
  rs.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
  rs.end(JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: ++tg.msg } : method === 'getWebhookInfo' ? { url: tg.hook?.url || '' } : true }));
});
await new Promise((r) => fakeTelegram.listen(0, '127.0.0.1', r));
// Slack, for GRID-32: its Web API, which is all a box calls.
const sl = { posted: [] };
const fakeSlack = http.createServer(async (rq, rs) => {
  let t = '';
  for await (const c of rq) t += c;
  if (rq.url.endsWith('/chat.postMessage')) sl.posted.push(JSON.parse(t));
  rs.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
  rs.end(JSON.stringify({ ok: true, user_id: 'UBOT', bot_id: 'BBOT', user: 'wisp', team: 'QA' }));
});
await new Promise((r) => fakeSlack.listen(0, '127.0.0.1', r));

// SES, for GRID-33: takes what's sent, and keeps it. The webhook is signed with a key the grid pins.
const sent = [];
const fakeSes = http.createServer(async (rq, rs) => {
  let t = '';
  for await (const c of rq) t += c;
  sent.push(JSON.parse(t));
  rs.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
  rs.end(`{"MessageId":"qa-${sent.length}"}`);
});
await new Promise((r) => fakeSes.listen(0, '127.0.0.1', r));
const TOPIC = 'arn:aws:sns:eu-west-1:111122223333:qa-mail';
const sns = generateKeyPairSync('rsa', { modulusLength: 2048 });
const dkim = generateKeyPairSync('ed25519'); // sender.example's key, pinned for the dev grid: no DNS here
const signedMail = (to, { from, id, dmarc = 'GRAY', subject, signed = true }) => {
  const plain = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: ${id}\r\nDate: ${new Date().toUTCString()}\r\n\r\nplease\r\n`;
  const raw = signed ? dkimSign(plain, { d: from.split('@')[1], key: dkim.privateKey }) : plain;
  const Message = JSON.stringify({ notificationType: 'Received', mail: { source: from }, receipt: { recipients: [to], dmarcVerdict: { status: dmarc }, dkimVerdict: { status: dmarc }, action: { type: 'SNS', topicArn: TOPIC, encoding: 'BASE64' } }, content: Buffer.from(raw).toString('base64') });
  const j = { Type: 'Notification', MessageId: id, TopicArn: TOPIC, Message, Timestamp: new Date().toISOString(), SignatureVersion: '2', SigningCertURL: 'https://sns.eu-west-1.amazonaws.com/qa.pem' };
  j.Signature = createSign('RSA-SHA256').update(['Message', 'MessageId', 'Timestamp', 'TopicArn', 'Type'].map((k) => `${k}\n${j[k]}\n`).join('')).sign(sns.privateKey, 'base64');
  return j;
};
fs.writeFileSync(path.join(data, 'grid.json'), JSON.stringify({ channels: { enabled: true }, mail: { domain: `mail.${DOMAIN}`, inbound: { provider: 'ses', topicArn: TOPIC, keys: [sns.publicKey.export({ type: 'spki', format: 'pem' })], dkimKeys: { 'sel._domainkey.sender.example': keyRecord(dkim.publicKey)[0].join('') } }, outbound: { provider: 'ses', region: 'eu-west-1', accessKeyId: 'AKIAQA', secretAccessKey: 'qa-not-a-secret', endpoint: `http://127.0.0.1:${fakeSes.address().port}` } }, hostd: { env: { WISP_TELEGRAM_API: `http://127.0.0.1:${fakeTelegram.address().port}`, WISP_SLACK_API: `http://127.0.0.1:${fakeSlack.address().port}` } } }));

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

  await check('GRID-04', 'Home shows Open and what to try, Account has devices and delete; both fit a phone', async () => {
    const p = A.page;
    ok(await p.locator('a.primary[href="/go"]').count(), 'no Open link to /go');
    ok(await p.locator('.can .t').count() >= 6, 'no tiles on Home');
    await shot(p, 'home-desktop');
    await p.click('.t-go[data-add]');
    ok(await p.locator('details#add[open]').count(), 'the tile did not open Add a computer');
    ok(await p.locator('.cards > .cards-live + details#add + #addHow:visible').count(), 'Add a computer is not the last card, with its panel after it');
    await p.setViewportSize({ width: 390, height: 844 });
    const sideways = () => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const home = await sideways();
    await shot(p, 'home-phone');
    await p.click('.navt a[href="/account"]');
    await p.waitForSelector('form[action="/account/delete"]');
    ok(await p.locator('form[action="/signout?all=1"]').count(), 'no Sign out everywhere');
    const account = await sideways();
    await shot(p, 'account-phone');
    await p.setViewportSize({ width: 1440, height: 900 });
    await shot(p, 'account-desktop');
    await p.goto(`${GRID}/`);
    ok(home <= 1 && account <= 1, `scrolls sideways on a phone: Home ${home}px, Account ${account}px`);
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

  await check('GRID-31', 'a Telegram message reaches a sleeping box: 200 first, woken, handled once, asleep again', async () => {
    const state = async () => (await req(`${inst(A.handle)}/_grid/state`, { headers: bearer(token) })).json?.state;
    const put = await req(`${inst(A.handle)}/api/remote`, { method: 'PUT', headers: bearer(token), body: { telegram: { enabled: true, token: '123:qa' } } });
    ok(put.status === 200, `PUT /api/remote → ${put.status} ${put.text.slice(0, 120)}`);
    await until(() => tg.hook, 10_000, 'setWebhook');
    ok(tg.hook.url.startsWith(`${inst(A.handle)}/_in/`), `webhook set to ${tg.hook.url}`);
    await until(async () => (await state()) === 'stopped', (IDLE + 30) * 1000, 'the box to stop');
    const hook = (body, secret = tg.hook.secret_token, url = tg.hook.url) => req(url, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, body });
    const t = Date.now();
    const r = await hook({ update_id: 1, message: { message_id: 1, text: `/link ${put.json.telegram.linkCode}`, chat: { id: 42, first_name: 'QA' }, date: Math.floor(t / 1000) } });
    const took = Date.now() - t;
    ok(r.status === 200, `the webhook → ${r.status}`);
    ok(took < 1000, `the 200 took ${took} ms: it waited for the box`);
    await until(() => tg.calls.some((c) => c.method === 'sendMessage' && /Linked to wisp/.test(c.text)), 30_000, 'the reply');
    await hook({ update_id: 1, message: { message_id: 1, text: 'a retry', chat: { id: 42 } } });
    await sleep(1000);
    ok(tg.calls.filter((c) => c.method === 'sendMessage').length === 1, 'handled more than once');
    ok(tg.calls.filter((c) => c.method === 'setWebhook').length === 1, 'a wake set the webhook again');
    ok(!tg.calls.some((c) => c.method === 'getUpdates'), 'a box with a webhook polled');
    ok((await hook({}, 's', tg.hook.url.replace(/[^/]+$/, 'x'.repeat(43)))).status === 404, 'a wrong token wasn’t a 404');
    await until(async () => (await state()) === 'stopped', (IDLE + 30) * 1000, 'the box to sleep again by itself');
  });

  await check('GRID-32', 'a Slack message reaches a sleeping box: URL checked, 200 first, woken, handled once, asleep again', async () => {
    const state = async () => (await req(`${inst(A.handle)}/_grid/state`, { headers: bearer(token) })).json?.state;
    const SIGNING = 'qa-signing-secret-0123456789abcdef';
    const call = (payload, { ts = Math.floor(Date.now() / 1000), secret = SIGNING } = {}) => {
      const body = JSON.stringify(payload);
      return req(url, { method: 'POST', headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}` }, body });
    };
    const m = await req(`${inst(A.handle)}/api/remote/slack/manifest`, { headers: bearer(token) });
    ok(m.status === 200, `the manifest → ${m.status} ${m.text.slice(0, 120)}`);
    const url = m.json.settings.event_subscriptions.request_url;
    ok(url?.startsWith(`${inst(A.handle)}/_in/`), `request_url ${url}`);
    ok(m.json.settings.socket_mode_enabled === false, 'the manifest still asks for a socket');
    const put = await req(`${inst(A.handle)}/api/remote`, { method: 'PUT', headers: bearer(token), body: { slack: { enabled: true, signingSecret: SIGNING, botToken: 'xoxb-qa' } } });
    ok(put.status === 200, `PUT /api/remote → ${put.status} ${put.text.slice(0, 120)}`);
    const urlCheck = { type: 'url_verification', challenge: 'qa-challenge', token: 'x' };
    const up = await call(urlCheck);
    ok(up.status === 200 && up.json.challenge === 'qa-challenge', `the URL check, box up → ${up.status} ${up.text}`);
    await until(async () => (await state()) === 'stopped', (IDLE + 30) * 1000, 'the box to stop');
    ok((await call(urlCheck)).status === 503, 'the URL check of a sleeping box wasn’t a 503');
    await sleep(1000);
    ok((await state()) === 'stopped', 'the URL check woke the box');
    const t = Date.now();
    const s = Math.floor(t / 1000);
    const dm = { type: 'event_callback', event_id: 'EvQA1', event_time: s, event: { type: 'message', channel_type: 'im', user: 'U0QA', text: `link ${put.json.slack.linkCode}`, channel: 'D1', ts: `${s}.000100`, client_msg_id: 'qa-1' } };
    const r = await call(dm);
    const took = Date.now() - t;
    ok(r.status === 200, `the event → ${r.status}`);
    ok(took < 1000, `the 200 took ${took} ms: it waited for the box`);
    await until(() => sl.posted.some((p) => /Linked to wisp/.test(p.text)), 30_000, 'the reply');
    const bad = await call({ ...dm, event_id: 'EvQA2' }, { secret: 'not-the-signing-secret' });
    ok(bad.status === 200, 'the grid can’t tell a bad signature, and answers the same');
    await call(dm, { ts: s + 1 }); // a retry, signed anew
    await sleep(1000);
    ok(sl.posted.length === 1, `handled more than once: ${sl.posted.length} posts`);
    await until(async () => (await state()) === 'stopped', (IDLE + 30) * 1000, 'the box to sleep again by itself');
  });

  await check('GRID-33', 'mail to the secret address wakes a sleeping box, and the reply goes back once, threaded', async () => {
    const state = async () => (await req(`${inst(A.handle)}/_grid/state`, { headers: bearer(token) })).json?.state;
    const me = 'qa@sender.example';
    const put = await req(`${inst(A.handle)}/api/remote`, { method: 'PUT', headers: bearer(token), body: { email: { enabled: true, sender: me } } });
    ok(put.status === 200, `PUT /api/remote → ${put.status} ${put.text.slice(0, 120)}`);
    const to = await until(async () => (await req(`${inst(A.handle)}/api/remote`, { headers: bearer(token) })).json?.email?.address, 15_000, 'the address');
    ok(to.endsWith(`@mail.${DOMAIN}`), `the address is ${to}`);
    await until(async () => (await state()) === 'stopped', (IDLE + 30) * 1000, 'the box to stop');
    const hook = (body) => req(`${GRID}/_mail/ses`, { method: 'POST', body });
    ok((await hook({ ...signedMail(to, { from: me, id: '<qa0@sender.example>', subject: 'x' }), Signature: 'AAAA' })).status === 403, 'a bad signature wasn’t refused');
    ok((await state()) === 'stopped', 'a bad signature woke the box');
    const t = Date.now();
    const r = await hook(signedMail(to, { from: me, id: '<qa1@sender.example>', subject: 'status' }));
    ok(r.status === 200 && Date.now() - t < 1000, `the webhook → ${r.status} in ${Date.now() - t} ms`);
    await until(() => sent.length, 30_000, 'the reply');
    const out = Buffer.from(sent[0].Content.Raw.Data, 'base64').toString('utf8');
    ok(sent[0].Destination.ToAddresses.join() === me, `sent to ${sent[0].Destination.ToAddresses}`);
    ok(/^In-Reply-To: <qa1@sender\.example>\r?$/m.test(out), 'not threaded');
    ok((await hook(signedMail(to, { from: 'evil@evil.example', id: '<qa2@evil.example>', subject: 'status' }))).status === 200, 'a stranger’s mail wasn’t taken quietly');
    const refusal = async () => (await req(`${inst(A.handle)}/api/remote`, { headers: bearer(token) })).json.status.email?.refused;
    ok((await hook(signedMail(to, { from: me, id: '<qa3@sender.example>', subject: 'status', dmarc: 'FAIL' }))).status === 200, 'a forged mail wasn’t taken quietly');
    await sleep(1500);
    ok((await refusal()) === 'dmarc', `the box’s refusal of a failed verdict: ${await refusal()}`);
    ok((await hook(signedMail(to, { from: me, id: '<qa4@sender.example>', subject: 'status', signed: false }))).status === 200, 'an unsigned mail wasn’t taken quietly');
    await sleep(1500);
    ok((await refusal()) === 'dkim', `the box’s refusal of an unsigned mail: ${await refusal()}`);
    ok(sent.length === 1, `${sent.length} replies: a stranger or a forgery was answered`);
    await until(async () => (await state()) === 'stopped', (IDLE + 30) * 1000, 'the box to sleep again by itself');
  });

  await check('GRID-11', 'Account lists the device; Remove revokes its token', async () => {
    const p = A.page;
    await p.goto(`${GRID}/account`);
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
    await p.goto(`${GRID}/account#delete`);
    const f = p.locator('form[action="/account/delete"]');
    await f.locator('input[name=confirm]').fill(B.handle);
    // Its answer, not the load state: the page we're on already counts as loaded until it comes.
    const answer = p.waitForResponse((r) => r.url().endsWith('/account/delete'), { timeout: 30_000 });
    await f.locator('button').click();
    ok((await answer).status() === 200, 'delete refused');
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
  fakeTelegram.close();
  fakeSlack.close();
  fakeSes.close();
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
