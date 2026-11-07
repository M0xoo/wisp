// Desktop app (Tauri) QA on Linux: what WebKitGTK does differently. Scenarios: qa/scenarios/desktop.md
// (TAURI-L*). Run under a display, as .github/workflows/tauri.yml does on ubuntu-latest:
//
//   xvfb-run -a dbus-run-session -- node qa/desktop-tauri-linux.mjs
//
// WebKitGTK's decide-policy doesn't say which frame a navigation is for, so these are the cases that
// tell a Preview frame from the page: frames that move on their own stay in place and send nothing to
// the browser, and the page's own way out goes to the browser while wisp stays, unreloaded.
// src/qa_linux.rs answers on a local socket. Nothing here reaches the network: the "outside site"
// is a server on 127.0.0.1, another origin than wisp's localhost.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { until } from '../test/helpers.js';
import { OUT, ROOT, api, ok, qaEnv, runner } from './lib.mjs';

if (process.platform !== 'linux') {
  console.log('qa/desktop-tauri-linux.mjs drives WebKitGTK: Linux only');
  process.exit(0);
}

const { check, done } = runner('desktop-tauri-linux');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.env.QA_TAURI_PORT) || 4791;
const PREVIEW = PORT + 2;
const OUTSIDE = PORT + 3;
const MANIFEST = path.join(ROOT, 'desktop/src-tauri/Cargo.toml');
const TARGET = process.env.CARGO_TARGET_DIR || path.join(ROOT, 'desktop/src-tauri/target');
const NODE = process.env.WISP_NODE || process.execPath;
const BIN_ENV = { claude: 'CLAUDE', codex: 'CODEX', opencode: 'OPENCODE', 'cursor-agent': 'CURSOR', agy: 'ANTIGRAVITY', grok: 'GROK', copilot: 'COPILOT' };

if (!process.env.QA_TAURI_NO_BUILD) execFileSync('cargo', ['build', '--features', 'qa', '--manifest-path', MANIFEST], { stdio: 'inherit' });
const BINARY = process.env.QA_TAURI_BINARY || path.join(TARGET, 'debug', 'wisp');
let A = null;

function driver(port) {
  const ask = (q) =>
    new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1');
      let buf = '';
      s.setTimeout(30_000, () => (s.destroy(), reject(new Error(`no answer to ${q.op}`))));
      s.setEncoding('utf8');
      s.on('data', (d) => {
        buf += d;
        if (buf.includes('\n')) {
          s.destroy();
          resolve(JSON.parse(buf));
        }
      });
      s.on('error', reject);
      s.write(`${JSON.stringify(q)}\n`);
    });
  // A promise can't cross the eval: it parks its answer and we ask again.
  const js = async (code) => {
    const key = `__qa${Math.random().toString(36).slice(2)}`;
    await ask({ op: 'eval', js: `(async () => (${code}))().then((v) => (window.${key} = { v }), (e) => (window.${key} = { e: String(e) })), 0` });
    return until(async () => {
      const r = await ask({ op: 'eval', js: `JSON.stringify(window.${key} ?? null)` });
      const got = JSON.parse(JSON.parse(r.result || 'null') ?? 'null');
      if (got?.e) throw new Error(got.e);
      return got && { value: got.v };
    }, { timeout: 15_000, what: 'script in the page' }).then((r) => r.value);
  };
  return { ask, js };
}

async function launch(port) {
  await quit();
  const { env, home, bins } = qaEnv({ WISP_PORT: String(port), WISP_UPDATE_CHECK: '0', WISP_QA_PORT: String(port + 1), WISP_NODE: NODE, WISP_QA_DOWNLOADS: fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-qa-dl-')) });
  for (const [bin, k] of Object.entries(BIN_ENV)) if (env[`WISP_${k}_BIN`] !== '') env[`WISP_${k}_BIN`] = path.join(bins, bin);
  for (const [k, v] of Object.entries(env)) if (v === '') delete env[k];
  for (const k of ['ELECTRON_RUN_AS_NODE', 'WISP_DESKTOP']) delete env[k];
  const log = path.join(OUT, `desktop-tauri-linux-${port}.log`);
  const out = fs.openSync(log, 'w');
  const proc = spawn(BINARY, [], { env, stdio: ['ignore', out, out], cwd: ROOT });
  const exited = new Promise((r) => proc.once('exit', (c, s) => r(c ?? s)));
  const d = driver(port + 1);
  await until(async () => (await d.ask({ op: 'window' }).catch(() => null))?.visible === true, { timeout: 60_000, what: 'the window' });
  await until(() => d.js(`!!document.querySelector('#launcher, #splitHome')`).catch(() => false), { timeout: 30_000, what: 'the page' });
  await sleep(1500);
  return { ...d, proc, exited, env, home, bins, log, url: `http://localhost:${port}` };
}

async function quit() {
  if (!A) return;
  const app = A;
  A = null;
  await app.ask({ op: 'quit' }).catch(() => {});
  const gone = await Promise.race([app.exited.then(() => true), sleep(8000).then(() => false)]);
  if (!gone) {
    app.proc.kill('SIGKILL');
    await app.exited;
  }
}

// What reached each server, by path: the frames' own moves are seen here, not guessed.
const hits = { preview: [], outside: [] };
const serve = (port, name, page) =>
  new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      hits[name].push(req.url);
      res.setHeader('content-type', 'text/html');
      res.end(page(req.url));
    });
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
const outsideUrl = (p) => `http://127.0.0.1:${OUTSIDE}${p}`;
// A preview that moves on its own: a script, then a meta refresh, then off to another site.
const previewPage = (url) => {
  if (url === '/first') return `<title>first</title><script>setTimeout(() => (location.href = '/second'), 150)</script>`;
  if (url === '/second') return `<title>second</title><meta http-equiv="refresh" content="0; url=/third">`;
  if (url === '/third') return `<title>third</title><script>setTimeout(() => (location.href = '${outsideUrl('/frame-left')}'), 150)</script>`;
  if (url === '/top') return `<title>top</title><script>setTimeout(() => { try { top.location.href = '${outsideUrl('/frame-top')}'; } catch (e) { parent.postMessage('top-refused', '*'); } }, 150)</script>`;
  return `<title>p</title><p>${url}</p>`;
};
const marker = `(window.__qaStay = (window.__qaStay || 0) + 1)`;
// WebKitGTK puts the view's address back once it has dropped the stopped load, a moment later.
const stayed = async () => {
  const back = await until(async () => (await A.ask({ op: 'window' })).url.startsWith(A.url), { timeout: 3000, what: 'the address back on wisp' }).catch(() => false);
  ok(back, `the window left wisp: ${(await A.ask({ op: 'window' })).url}`);
  ok((await A.js('window.__qaStay || 0')) > 0, 'wisp reloaded: the page lost its state');
};

const preview = await serve(PREVIEW, 'preview', previewPage);
const outside = await serve(OUTSIDE, 'outside', (url) => `<title>outside</title><p>${url}</p>`);

await check('TAURI-L01', 'boots on WebKitGTK, its server is a Node child, the page loads', async () => {
  A = await launch(PORT);
  const health = await api(A.url, '/api/health');
  ok(health.status === 200, `health ${health.status}`);
  ok(health.json?.pid && health.json.pid !== A.proc.pid, `server pid ${health.json?.pid} is the shell's`);
  const errs = (await A.js('window.__qaErrors')).filter((e) => !/favicon/i.test(e));
  ok(!errs.length, errs.slice(0, 3).join(' | '));
  console.log(`  ${await A.js('navigator.userAgent')}`);
});

await check('TAURI-L06b', 'a Preview frame that moves on its own stays in its frame; nothing goes to the browser', async () => {
  await A.js(marker);
  const before = (await A.ask({ op: 'opened' })).opened.length;
  await A.js(`(() => { const f = document.createElement('iframe'); f.id = 'qaf'; f.src = 'http://localhost:${PREVIEW}/first'; document.body.append(f); return 1; })()`);
  await until(() => hits.outside.includes('/frame-left'), { timeout: 15_000, what: `the frame to reach the outside site on its own (preview saw ${hits.preview}, outside ${hits.outside})` });
  // The parent moving the frame, to wisp's own origin's neighbour and to the outside site.
  await A.js(`(() => { qaf.src = 'http://localhost:${PREVIEW}/next'; return new Promise((d) => (qaf.onload = () => d(1))); })()`);
  await A.js(`(() => { qaf.src = '${outsideUrl('/frame-direct')}'; return new Promise((d) => (qaf.onload = () => d(1))); })()`);
  // A sandboxed one, as Preview makes them.
  await A.js(`new Promise((done) => { const f = document.createElement('iframe'); f.sandbox = 'allow-scripts allow-same-origin allow-forms'; f.id = 'qas'; f.src = 'http://localhost:${PREVIEW}/first'; document.body.append(f); setTimeout(() => done(1), 1500); })`);
  await sleep(800);
  const { opened } = await A.ask({ op: 'opened' });
  ok(opened.length === before, `a frame's navigation went to the browser: ${opened.slice(before)}`);
  await stayed();
  const frames = await A.js(`[...document.querySelectorAll('iframe')].length`);
  ok(frames === 2, `frames left in the page: ${frames}`);
  await A.js(`(qaf.remove(), qas.remove(), 1)`);
  // srcdoc frames (app blocks, panes) still run.
  const inner = await A.js(`new Promise((done) => { const f = document.createElement('iframe'); f.sandbox = 'allow-scripts'; f.srcdoc = '<script>parent.postMessage("srcdoc-ran", "*")<\\/script>'; addEventListener('message', (e) => (done(e.data), f.remove()), { once: true }); document.body.append(f); setTimeout(() => done('nothing'), 3000); })`);
  ok(inner === 'srcdoc-ran', `sandboxed srcdoc frame: ${inner}`);
  // A sandboxed frame can't move the page; one allowed to (allow-top-navigation) is the page's way out.
  const top = await A.js(`new Promise((done) => { const f = document.createElement('iframe'); f.sandbox = 'allow-scripts'; f.src = 'http://localhost:${PREVIEW}/top'; addEventListener('message', (e) => (done(e.data), f.remove()), { once: true }); document.body.append(f); setTimeout(() => (done('moved?'), f.remove()), 3000); })`);
  ok(!hits.outside.includes('/frame-top'), `a sandboxed frame moved the page: ${top}`);
  await stayed();
});

await check('TAURI-L06', 'the page’s own links and moves to another site open in the browser; wisp stays, unreloaded', async () => {
  await A.js(marker);
  const before = (await A.ask({ op: 'opened' })).opened.length;
  // A real link in the page, clicked.
  await A.js(`(() => { const a = Object.assign(document.createElement('a'), { href: '${outsideUrl('/clicked')}', textContent: 'out' }); document.body.append(a); a.click(); a.remove(); return 1; })()`);
  await until(async () => (await A.ask({ op: 'opened' })).opened.includes(outsideUrl('/clicked')), { timeout: 8000, what: 'the clicked link in the browser' });
  await stayed();
  // The page moving itself, to another site and to an editor link; never a local file.
  await A.ask({ op: 'eval', js: `location.href = '${outsideUrl('/moved')}'; 0` });
  await until(async () => (await A.ask({ op: 'opened' })).opened.includes(outsideUrl('/moved')), { timeout: 8000, what: 'the move in the browser' });
  await stayed();
  await A.ask({ op: 'eval', js: `location.href = 'vscode://file/tmp/qa-nav.js'; 0` });
  await until(async () => (await A.ask({ op: 'opened' })).opened.includes('vscode://file/tmp/qa-nav.js'), { timeout: 8000, what: 'the editor link outside' });
  await stayed();
  await A.ask({ op: 'eval', js: `location.href = 'file:///etc/hostname'; 0` });
  await sleep(1000);
  await stayed();
  // A popup, as everywhere.
  await A.js(`(window.open('${outsideUrl('/popup')}'), 1)`);
  await until(async () => (await A.ask({ op: 'opened' })).opened.includes(outsideUrl('/popup')), { timeout: 8000, what: 'the popup in the browser' });
  const { opened } = await A.ask({ op: 'opened' });
  ok(!opened.some((u) => u.startsWith('file:')), `a file url went out: ${opened}`);
  ok(opened.length - before === 4, `opened ${opened.slice(before)}`);
  await stayed();
  // Seen, not assumed: did the outside site hear from the window itself before it was sent out?
  console.log(`  the outside site saw ${JSON.stringify(hits.outside)}`);
});

await quit();
preview.close();
outside.close();
process.exit(done());
