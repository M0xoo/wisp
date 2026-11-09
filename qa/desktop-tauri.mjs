// Desktop app (Tauri) QA: drives desktop/src-tauri, built with `--features qa`, against this checkout.
// Scenarios: qa/scenarios/desktop.md (the Tauri column). macOS only for now. Run: node qa/desktop-tauri.mjs
//
// There's no WebDriver for WKWebView, so src/qa.rs answers on a local socket: it runs script in the
// page, reads the real NSWindow and sends real AppKit events. Each app gets its own WISP_HOME and
// ports (4761+). The shell's single-instance lock is per bundle id, so close a Tauri wisp first.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { makeRepo, until } from '../test/helpers.js';
import { OUT, ROOT, api, ok, qaEnv, runner, startWisp } from './lib.mjs';

const { check, done } = runner('desktop-tauri');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.env.QA_TAURI_PORT) || 4761;
const QA = PORT + 1;
const PREVIEW = PORT + 2;
const OTHER = PORT + 3;
const MANIFEST = path.join(ROOT, 'desktop/src-tauri/Cargo.toml');
const TARGET = process.env.CARGO_TARGET_DIR || path.join(ROOT, 'desktop/src-tauri/target');
const NODE = process.env.WISP_NODE || process.execPath; // a real node: nvm's, not the bundled one (PR 3)
const BIN_ENV = { claude: 'CLAUDE', codex: 'CODEX', opencode: 'OPENCODE', 'cursor-agent': 'CURSOR', agy: 'ANTIGRAVITY', grok: 'GROK', copilot: 'COPILOT' };
const CMD = 1 << 20;
const SHIFT = 1 << 17;
const CTRL = 1 << 18;

const listening = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

if (process.platform !== 'darwin') {
  console.log('qa/desktop-tauri.mjs drives AppKit: macOS only for now');
  process.exit(0);
}
if (!process.env.QA_TAURI_NO_BUILD) execFileSync('cargo', ['build', '--features', 'qa', '--manifest-path', MANIFEST], { stdio: 'inherit' });
const BINARY = path.join(TARGET, 'debug', 'wisp');
let A = null;

// One JSON line each way with src/qa.rs.
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
  // A promise can't cross evaluateJavaScript: it parks its answer and we ask again.
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

async function launch(port, { env: extra = {} } = {}) {
  await quit(); // what a failed check left behind
  const { env, home, bins } = qaEnv({ WISP_PORT: String(port), WISP_UPDATE_CHECK: '0', WISP_QA_PORT: String(port + 1), WISP_NODE: NODE, WISP_QA_PICK: '/tmp/qa-picked', WISP_QA_DOWNLOADS: fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-qa-dl-')), ...extra });
  for (const [bin, k] of Object.entries(BIN_ENV)) if (env[`WISP_${k}_BIN`] !== '') env[`WISP_${k}_BIN`] = path.join(bins, bin);
  for (const [k, v] of Object.entries(env)) if (v === '') delete env[k];
  for (const k of ['ELECTRON_RUN_AS_NODE', 'WISP_DESKTOP']) delete env[k];
  const log = path.join(OUT, `desktop-tauri-${port}.log`);
  const out = fs.openSync(log, 'w');
  const proc = spawn(BINARY, [], { env, stdio: ['ignore', out, out], cwd: ROOT });
  const exited = new Promise((r) => proc.once('exit', (c, s) => r(c ?? s)));
  const d = driver(port + 1);
  await until(async () => (await d.ask({ op: 'window' }).catch(() => null))?.visible === true, { timeout: 30_000, what: 'the window' });
  await until(() => d.js(`!!document.querySelector('#launcher, #splitHome')`).catch(() => false), { timeout: 30_000, what: 'the page' });
  await sleep(1500);
  return { ...d, proc, exited, env, home, bins, log, url: `http://localhost:${port}` };
}

// Asks nicely, then not: a stuck shell mustn't hang the run or hold the single-instance lock.
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

const shot = async (name) => {
  const tiff = path.join(OUT, `desktop-tauri-${name}.tiff`);
  ok((await A.ask({ op: 'shot', path: tiff })).ok, `no snapshot ${name}`);
  execFileSync('sips', ['-s', 'format', 'png', tiff, '--out', tiff.replace(/tiff$/, 'png')], { stdio: 'ignore' });
  fs.rmSync(tiff);
};

// A real click on what `find` returns (script for an element).
const clickAt = async (find) => {
  const r = await A.js(`(() => { const e = ${find}; if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  ok(r, `nothing to click: ${find}`);
  await A.ask({ op: 'mouse', x: r[0], y: r[1] });
};

// Interactive elements under the macOS traffic lights.
const UNDER_LIGHTS = `(() => {
  const hits = [];
  for (let x = 12; x <= 76; x += 4)
    for (let y = 10; y <= 36; y += 4) {
      const e = document.elementFromPoint(x, y)?.closest('button, a, input, textarea, select, [role=button], .p-chip');
      if (e && e.offsetParent !== null) hits.push(e.id || e.className || e.tagName);
    }
  return [...new Set(hits)];
})()`;

await check('TAURI-01', 'boots, its server is a Node child, the page loads', async () => {
  ok(!(await listening(PORT)), `port ${PORT} already in use`);
  A = await launch(PORT);
  const health = await api(A.url, '/api/health');
  ok(health.status === 200, `health ${health.status}`);
  ok(health.json?.pid && health.json.pid !== A.proc.pid, `server pid ${health.json?.pid} is the shell's`);
  A.serverPid = health.json.pid;
  const parent = execFileSync('ps', ['-o', 'ppid=', '-p', String(A.serverPid)], { encoding: 'utf8' }).trim();
  ok(Number(parent) === A.proc.pid, `server's parent ${parent}, shell ${A.proc.pid}`);
  const b = await A.js(`({ desktop: document.body.classList.contains('desktop'), mac: document.body.classList.contains('mac') })`);
  ok(b.desktop && b.mac, `body classes ${JSON.stringify(b)}`);
  await shot('boot');
});

await check('TAURI-02', 'window title, size and minimum size', async () => {
  const w = await A.ask({ op: 'window' });
  ok(w.visible, 'not shown');
  ok(w.title === 'wisp', `title "${w.title}"`);
  ok(w.minWidth === 720 && w.minHeight === 520, `min ${w.minWidth}x${w.minHeight}`);
  ok(w.width >= 720 && w.width <= 1380 && w.height >= 520 && w.height <= 900, `size ${w.width}x${w.height}`);
});

await check('TAURI-03', 'traffic lights at x 16, y 18 and nothing clickable under them', async () => {
  const l = await A.ask({ op: 'lights' });
  console.log(`  lights ${JSON.stringify(l)}`);
  ok(l.close.x === 16 && l.close.y === 18, `close button at ${l.close.x},${l.close.y}`);
  const hits = await A.js(UNDER_LIGHTS);
  ok(!hits.length, `under the lights: ${hits}`);
});

await check('TAURI-04', 'no page errors while loading', async () => {
  const errs = (await A.js('window.__qaErrors')).filter((e) => !/favicon/i.test(e));
  ok(!errs.length, errs.slice(0, 3).join(' | '));
});

await check('TAURI-05', 'bridge: wispDesktop.pickFolder only, no Node, no Get the app pill', async () => {
  const r = await A.js(`({ keys: Object.keys(window.wispDesktop || {}), node: typeof window.require, getApp: document.querySelector('#getAppBtn')?.hidden ?? true, picked: await window.wispDesktop.pickFolder() })`);
  ok(r.keys.join() === 'pickFolder', `bridge exposes ${r.keys}`);
  ok(r.node === 'undefined', 'require leaks into the page');
  ok(r.getApp, 'Get the app pill shows');
  ok(r.picked === '/tmp/qa-picked', `pickFolder gave ${r.picked}`);
  // The real panel, as a sheet on the window: its button says Add project, and Cancel gives null.
  await A.ask({ op: 'real-picker' });
  await A.ask({ op: 'eval', js: `window.__qaPick = 'waiting'; window.wispDesktop.pickFolder().then((v) => (window.__qaPick = v)); 0` });
  const sheet = await until(async () => (await A.ask({ op: 'sheet' })).prompt, { timeout: 8000, what: 'the open panel' });
  ok(sheet === 'Add project', `the panel's button says ${sheet}`);
  await until(async () => (await A.js('window.__qaPick')) === null, { timeout: 5000, what: 'Cancel to give null' });
  console.log(`  inspector ${JSON.stringify(await A.ask({ op: 'inspectable' }))} (debug build: on)`);
});

await check('TAURI-06', 'external links leave the app; wisp stays', async () => {
  await A.js(`(window.open('https://example.com/qa-popup'), 1)`);
  await A.js(`(() => { const a = Object.assign(document.createElement('a'), { href: 'vscode://file/tmp/qa.js', target: '_blank' }); document.body.append(a); a.click(); a.remove(); return 1; })()`);
  await A.ask({ op: 'eval', js: `location.href = 'vscode://file/tmp/qa-nav.js'; 0` });
  await A.ask({ op: 'eval', js: `location.href = 'https://example.org/qa-navigate'; 0` });
  await A.ask({ op: 'eval', js: `location.href = 'file:///Applications/Calculator.app'; 0` });
  await sleep(800);
  // A real click on an http(s) target=_blank link, as a preview block's Open in a new tab: the
  // opener plugin's own click script used to take it to an IPC call the page may not make.
  await A.ask({ op: 'activate' });
  await A.js(`(() => { const a = Object.assign(document.createElement('a'), { id: 'qaOut', href: 'http://127.0.0.1:${OTHER}/qa-click', target: '_blank', rel: 'noopener noreferrer', textContent: 'out' }); a.style.cssText = 'position:fixed;left:300px;top:200px;z-index:99999;padding:20px;background:#fff'; document.body.append(a); return 1; })()`);
  await clickAt(`document.getElementById('qaOut')`);
  await until(async () => (await A.ask({ op: 'opened' })).opened.includes(`http://127.0.0.1:${OTHER}/qa-click`), { timeout: 5000, what: 'a clicked target=_blank link to go out' }).catch(() => {});
  await A.js(`(qaOut.remove(), 1)`);
  const { opened } = await A.ask({ op: 'opened' });
  const w = await A.ask({ op: 'window' });
  for (const u of ['https://example.com/qa-popup', 'vscode://file/tmp/qa.js', 'vscode://file/tmp/qa-nav.js', 'https://example.org/qa-navigate', `http://127.0.0.1:${OTHER}/qa-click`]) ok(opened.includes(u), `${u} not sent out: ${opened}`);
  ok(!opened.some((u) => u.startsWith('file:')), `a file url went out: ${opened}`);
  ok(opened.filter((u) => u.endsWith('/qa-click')).length === 1, `the click went out more than once: ${opened}`);
  ok(!(await A.js('JSON.stringify(window.__qaErrors)')).includes('open_url'), 'a link click reached the opener plugin over IPC');
  ok(w.url.startsWith(A.url), `the window left wisp: ${w.url}`);
});

await check('TAURI-06b', 'previews stay in their frame and never reach IPC', async () => {
  const preview = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<title>p</title><a id=out href="https://example.net/qa-frame">out</a><a id=next href="/next">next</a><p>${req.url}</p>`);
  });
  await new Promise((r) => preview.listen(PREVIEW, '127.0.0.1', r));
  const before = (await A.ask({ op: 'opened' })).opened.length;
  const frame = (sandbox) => `new Promise((done) => { const f = document.createElement('iframe'); ${sandbox ? `f.sandbox = 'allow-scripts allow-same-origin';` : ''} f.id = 'qaf'; f.src = 'http://localhost:${PREVIEW}/first'; f.onload = () => done(1); document.body.append(f); })`;
  await A.js(frame(false));
  // Cross-origin: message it. Nothing in the preview page itself can tell the shell anything.
  await A.js(`(() => { qaf.src = 'http://localhost:${PREVIEW}/next'; return new Promise((d) => (qaf.onload = () => d(1))); })()`);
  await A.js(`(() => { qaf.src = 'https://example.net/qa-frame-direct'; return 1; })()`);
  await sleep(1200);
  const { opened } = await A.ask({ op: 'opened' });
  ok(opened.length === before, `a frame's navigation went to the browser: ${opened.slice(before)}`);
  ok((await A.ask({ op: 'window' })).url.startsWith(A.url), 'the window left wisp');
  await A.js(`(qaf.remove(), 1)`);
  // srcdoc and blob frames (app blocks, panes) load at all.
  const inner = await A.js(`new Promise((done) => { const f = document.createElement('iframe'); f.sandbox = 'allow-scripts'; f.srcdoc = '<script>parent.postMessage("srcdoc-ran", "*")<\\/script>'; addEventListener('message', (e) => done(e.data), { once: true }); document.body.append(f); setTimeout(() => done('nothing'), 3000); })`);
  ok(inner === 'srcdoc-ran', `sandboxed srcdoc frame: ${inner}`);
  // A frame posting to the IPC handler itself gets nowhere: it has no invoke key.
  const raw = await A.js(`new Promise((done) => { const f = document.createElement('iframe'); f.sandbox = 'allow-scripts'; f.srcdoc = '<script>let r = "no-internals"; if (window.__TAURI_INTERNALS__) r = "HAS-INTERNALS"; if (window.wispDesktop) r = "HAS-BRIDGE"; parent.postMessage(r, "*")<\\/script>'; addEventListener('message', (e) => done(e.data), { once: true }); document.body.append(f); setTimeout(() => done('nothing'), 3000); })`);
  ok(raw === 'no-internals', `a sandboxed frame sees ${raw}`);
  await new Promise((r) => preview.close(r));
});

await check('TAURI-07', 'application menu, Edit keys in the prompt box', async () => {
  await A.ask({ op: 'activate' });
  await sleep(300);
  const { menu } = await A.ask({ op: 'menu' });
  const titles = menu.map((m) => m.title).filter((t) => t !== 'Apple');
  console.log(`  ${titles}`);
  for (const t of ['File', 'Edit', 'View', 'Window']) ok(titles.includes(t), `no ${t} menu: ${titles}`);
  const items = (t) => menu.find((m) => m.title === t).items;
  for (const i of ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All']) ok(items('Edit').includes(i), `Edit has no ${i}: ${items('Edit')}`);
  ok(items('View').includes('Reload'), `View: ${items('View')}`);
  await A.js(`(() => { const t = document.querySelector('#launcher textarea, #prompt, textarea'); t.focus(); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); window.__qaT = t; return 1; })()`);
  const key = (chars, code, mods) => A.ask({ op: 'key', chars, code, mods });
  for (const c of 'hello') await A.ask({ op: 'key', chars: c, code: 0, mods: 0 });
  await sleep(200);
  ok((await A.js(`__qaT.value`)) === 'hello', `typing gave "${await A.js(`__qaT.value`)}"`);
  // The keys cross to the web process and back: on a busy machine that's seconds, not a sleep.
  const shows = (want, what) => until(async () => (await A.js(`__qaT.value`)) === want, { timeout: 5000, what });
  await key('a', 0, CMD);
  await until(async () => (await A.js(`__qaT.selectionEnd - __qaT.selectionStart`)) === 5, { timeout: 5000, what: '⌘A' });
  await key('c', 8, CMD);
  await sleep(300);
  // Cut is only enabled once WebKit has told AppKit about the selection, which comes a moment later.
  for (let i = 0; i < 4 && (await A.js(`__qaT.value`)) !== ''; i++) {
    if (i) console.log(`  ⌘X again (${i})`);
    await key('x', 7, CMD);
    await shows('', '⌘X').catch(() => {});
  }
  await shows('', '⌘X');
  await key('v', 9, CMD);
  await shows('hello', '⌘V');
  await key('z', 6, CMD);
  await shows('', '⌘Z');
  await A.js(`(__qaT.value = '', __qaT.dispatchEvent(new Event('input', { bubbles: true })), 1)`);
});

await check('TAURI-07c', 'Tab reaches buttons and links', async () => {
  await A.ask({ op: 'activate' });
  await A.js(`(() => { document.activeElement?.blur(); const b = document.createElement('div'); b.id = 'qaTab'; b.style.cssText = 'position:fixed;left:300px;top:300px;z-index:99999'; b.innerHTML = '<input id=qaTabFrom><a id=qaTabLink href="#x">link</a><button id=qaTabButton>button</button>'; document.body.append(b); document.querySelector('#qaTabFrom').focus(); return 1; })()`);
  const tab = (id) => A.ask({ op: 'key', chars: '\t', code: 48, mods: 0 }).then(() => until(() => A.js(`document.activeElement?.id === '${id}'`), { timeout: 5000, what: `Tab to reach #${id}` }));
  await tab('qaTabLink');
  await tab('qaTabButton');
  await A.js(`(qaTab.remove(), 1)`);
});

await check('TAURI-08', 'follows the theme (light ⇄ dark)', async () => {
  const bg = () => A.js(`getComputedStyle(document.body).backgroundColor`);
  await A.ask({ op: 'theme', dark: false });
  await sleep(700);
  const light = await bg();
  await shot('light');
  await A.ask({ op: 'theme', dark: true });
  await sleep(700);
  const dark = await bg();
  await shot('dark');
  ok(await A.js(`matchMedia('(prefers-color-scheme: dark)').matches`), 'page did not see dark');
  ok(light !== dark, `same background: ${light}`);
  await A.ask({ op: 'theme' });
});

await check('TAURI-09', 'dock badge follows the page title; the window keeps its name', async () => {
  await A.js(`(document.title = '(3) wisp', 1)`);
  await sleep(300);
  ok((await A.ask({ op: 'badge' })).badge === '3', `badge ${JSON.stringify(await A.ask({ op: 'badge' }))}`);
  ok((await A.ask({ op: 'window' })).title === 'wisp', 'window title changed');
  await A.js(`(document.title = 'wisp', 1)`);
  await sleep(300);
  ok(!(await A.ask({ op: 'badge' })).badge, 'badge did not clear');
});

await check('TAURI-10', 'a task runs on the fake agent and its presentation renders', async () => {
  const repo = makeRepo();
  const s = await api(A.url, '/api/sessions', { prompt: 'fix the add function in math.js', cwd: repo, agent: 'claude' });
  ok(s.status === 201, `launch ${s.status} ${s.text.slice(0, 200)}`);
  const id = s.json.id;
  A.task = id;
  const fin = await until(async () => {
    const r = await api(A.url, `/api/sessions/${id}`);
    return r.json && !['running', 'queued', 'starting'].includes(r.json.state) && r.json;
  }, { timeout: 60_000, what: 'the task to finish' });
  ok(fin.state !== 'failed', `task ${fin.state}`);
  await sleep(900); // the row settles into its section
  await A.ask({ op: 'activate' });
  await sleep(300);
  await clickAt(`[...document.querySelectorAll('[data-id="${id}"]')].find((e) => e.offsetParent)`);
  await until(() => A.js(`!!document.querySelector('.blk-hero, .hero')`), { timeout: 15_000, what: 'the presentation' });
  await sleep(1200);
  await shot('presentation');
  ok(/a \+ b/.test(fs.readFileSync(path.join(fin.worktree?.cwd || fin.cwd || repo, 'math.js'), 'utf8')), 'math.js not fixed');
});

await check('TAURI-10b', 'stacked under 900px', async () => {
  await A.ask({ op: 'resize', width: 800, height: 700 });
  await sleep(900);
  ok(await A.js(`document.body.classList.contains('stack')`), 'not stacked at 800px');
  await shot('stacked');
  await A.ask({ op: 'resize', width: 1380, height: 900 });
  await sleep(500);
});

await check('TAURI-10c', '<a download> saves a file', async () => {
  await A.js(`(() => { const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(['qa'])), download: 'qa-saved.txt' }); document.body.append(a); a.click(); a.remove(); return 1; })()`);
  const file = path.join(A.env.WISP_QA_DOWNLOADS, 'qa-saved.txt');
  await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8') === 'qa', { timeout: 8000, what: 'the download' });
});

// WebKit's own default stops only at text boxes: 4 Tabs landed on the card's input, past both answers.
await check('TAURI-07d', 'Tab from the top of a task reaches a question’s first answer', async () => {
  const s = await api(A.url, '/api/sessions', { prompt: 'ASK before you fix it', cwd: makeRepo(), agent: 'claude' });
  ok(s.status === 201, `launch ${s.status}`);
  await until(async () => (await api(A.url, `/api/sessions/${s.json.id}`)).json?.state === 'waiting', { timeout: 30_000, what: 'the question' });
  await sleep(900);
  await A.ask({ op: 'activate' });
  await clickAt(`[...document.querySelectorAll('[data-id="${s.json.id}"]')].find((e) => e.offsetParent)`);
  await until(() => A.js(`!!document.querySelector('.ask-card .opt[data-i="0"]')?.offsetParent`), { timeout: 15_000, what: 'the question card' });
  await sleep(600);
  await A.js(`(document.activeElement?.blur(), 1)`);
  const at = `(() => { const e = document.activeElement; const c = e?.closest('.ask-card'); return c ? (e.matches('.opt') ? 'opt' + e.dataset.i : e.tagName.toLowerCase()) : ''; })()`;
  let stops = 0;
  let landed = '';
  while (!landed && stops < 80) {
    await A.ask({ op: 'key', chars: '\t', code: 48, mods: 0 });
    stops++;
    await sleep(60);
    landed = await A.js(at);
  }
  ok(landed === 'opt0', `after ${stops} Tabs the card's focus is ${landed || 'nowhere'}, not answer 1`);
  await shot('tab-answer');
  await A.ask({ op: 'key', chars: '\t', code: 48, mods: 0 });
  await until(() => A.js(`${at} === 'opt1'`), { timeout: 3000, what: 'Tab to answer 2' });
  console.log(`      ${stops} Tabs to answer 1`);
  await A.ask({ op: 'key', chars: '\u0019', code: 48, mods: SHIFT }); // AppKit's ⇧Tab is a backtab
  await until(() => A.js(`${at} === 'opt0'`), { timeout: 3000, what: '⇧Tab back to answer 1' });
  await A.ask({ op: 'key', chars: '\r', code: 36, mods: 0 });
  await until(async () => ['review', 'done'].includes((await api(A.url, `/api/sessions/${s.json.id}`)).json?.state), { timeout: 30_000, what: 'Return on answer 1 to answer' });
});

await check('TAURI-11', 'updater in a git checkout: method git', async () => {
  const u = await api(A.url, '/api/update');
  ok(u.json?.method === 'git', `method ${u.json?.method}`);
  ok(await A.js(`document.querySelector('#updateBtn').hidden`), '#updateBtn visible');
});

await check('TAURI-07b', '⌃Tab reaches the page', async () => {
  await A.js(`(window.__qaTab = 0, addEventListener('keydown', (e) => { if (e.key === 'Tab' && e.ctrlKey) window.__qaTab++; }, true), document.activeElement?.blur(), 1)`);
  await A.ask({ op: 'key', chars: '\t', code: 48, mods: CTRL });
  await sleep(300);
  ok((await A.js('window.__qaTab')) === 1, 'the keydown never got there');
  await A.js(`(document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true })), 1)`);
  await sleep(300);
});

await check('TAURI-16', 'drag regions move the window, a double-click zooms it, buttons still click', async () => {
  await A.ask({ op: 'activate' });
  await A.js(`(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 1)`);
  await sleep(400);
  // A drag follows the real pointer, which posted events don't move and nothing here may (no
  // Accessibility): so this proves which spots ask the shell to drag, and that the title bar moves.
  const spots = await A.js(`(() => {
    const mid = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    const head = document.querySelector('.split-head').getBoundingClientRect();
    return { top: [300, 12], head: [head.left + head.width / 2, 8], rail: [6, 300], title: mid('.split-head .sh-title'), button: mid('.split-head button'), row: mid('.item') };
  })()`);
  const asks = async (name, want) => {
    const [x, y] = spots[name];
    const before = (await A.ask({ op: 'drags' })).drags;
    // In the page, not posted through AppKit: the mouse-up of a drag with no hand on it can eat the next click.
    await A.js(`(document.elementFromPoint(${x}, ${y}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, detail: 1 })), 1)`);
    await sleep(500);
    const n = (await A.ask({ op: 'drags' })).drags - before;
    console.log(`  ${name} (${Math.round(x)}, ${Math.round(y)}) ${await A.js(`String(document.elementFromPoint(${x}, ${y})?.className).slice(0, 30)`)}: ${n} drag`);
    ok(n === (want ? 1 : 0), `${name}: ${n} drags, want ${want ? 1 : 0}`);
  };
  await asks('top', true);
  await asks('head', true);
  await asks('rail', true);
  await asks('title', false);
  await asks('button', false);
  await asks('row', false);
  await A.ask({ op: 'mouse', x: 6, y: 8, dx: 30, dy: 0 });
  await sleep(500);
  // The second click of a double-click (a posted pair doesn't count as one in WebKit).
  const second = `(document.querySelector('.split-head').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 2 })), 1)`;
  const zoomed = async () => (await A.ask({ op: 'window' })).maximized;
  const was = await zoomed();
  await A.js(second);
  await sleep(1200);
  ok((await zoomed()) !== was, 'a double-click did not zoom');
  await A.js(second);
  await sleep(1200);
  ok((await zoomed()) === was, 'a second double-click did not zoom back');
  await A.ask({ op: 'resize', width: 1380, height: 900 });
  await sleep(400);
});

await check('TAURI-18', 'a task that finishes behind the window notifies, and a click opens it', async () => {
  ok((await A.js('Notification.permission')) === 'granted', `permission ${await A.js('Notification.permission')}`);
  const refused = await A.js(`window.__TAURI_INTERNALS__.invoke('plugin:notification|notify', { options: { title: 'x' } }).then(() => 'allowed', () => 'refused')`);
  ok(refused === 'refused', `the plugin's own commands reach the page: ${refused}`);
  await A.ask({ op: 'clear-delivered' });
  await A.ask({ op: 'close' });
  await until(async () => !(await A.js('document.hasFocus()')), { timeout: 5000, what: 'the page to lose focus' });
  const s = await api(A.url, '/api/sessions', { prompt: 'fix the add function in math.js', cwd: makeRepo(), agent: 'claude' });
  const [title] = await until(async () => { const d = (await A.ask({ op: 'delivered' })).delivered; return d?.length && d; }, { timeout: 30_000, what: 'macOS to hold a notification' });
  console.log(`  delivered "${title}"`);
  await sleep(600); // the plugin's own wait has to be on it
  ok((await A.ask({ op: 'notify-click', title })).ok, 'no click delegate');
  await until(async () => (await A.ask({ op: 'window' })).visible, { timeout: 5000, what: 'the window to come back' });
  await until(() => A.js(`document.querySelector('.item.open')?.dataset.id === ${JSON.stringify(s.json.id)}`), { timeout: 8000, what: 'the task to open' });
  ok(!(await A.ask({ op: 'delivered' })).delivered.length, 'the click left it in Notification Center');
  await A.js(`(() => { const n = new Notification('off', { body: 'x' }); n.close(); return 1; })()`); // what notify.js may call
});

await check('TAURI-19', "View's items: Reload, Force Reload, Toggle Developer Tools", async () => {
  const reloads = async (item) => {
    await A.js(`(window.__qaKept = 1)`);
    const r = await A.ask({ op: 'menu-click', top: 'View', item });
    ok(r.ok, `${item}: ${JSON.stringify(r)}`);
    await until(() => A.js(`window.__qaKept === undefined && document.readyState === 'complete' && !!document.querySelector('#launcher, #splitHome')`).catch(() => false), { timeout: 15_000, what: `${item} to reload the page` });
    await sleep(600);
  };
  await reloads('Reload');
  await reloads('Force Reload');
  const open = async () => (await A.ask({ op: 'devtools' })).open;
  ok(!(await open()), 'open before asked');
  ok((await A.ask({ op: 'menu-click', top: 'View', item: 'Toggle Developer Tools' })).ok, 'no such item');
  await until(open, { timeout: 8000, what: 'the inspector to open' });
  await sleep(800);
  ok((await A.ask({ op: 'menu-click', top: 'View', item: 'Toggle Developer Tools' })).ok, 'no such item');
  await until(async () => !(await open()), { timeout: 8000, what: 'the inspector to close' });
});

await check('TAURI-20', 'the right-click menu: Copy Link on a link, Cut Copy Paste in a text box', async () => {
  await A.ask({ op: 'activate' });
  const spot = `(() => { const old = document.querySelector('#qaCtx'); old?.remove(); const b = document.createElement('div'); b.id = 'qaCtx'; b.style.cssText = 'position:fixed;left:400px;top:300px;z-index:99999;background:#888;padding:20px'; b.innerHTML = '<a href="https://example.com/qa">a link</a><br><br><textarea>some text</textarea>'; document.body.append(b); return 1; })()`;
  await A.js(spot);
  const open = async (x, y) => {
    await A.ask({ op: 'right-click', x, y });
    const { items } = await until(async () => { const r = await A.ask({ op: 'context-menu' }); return r.items && r; }, { timeout: 8000, what: 'AppKit to open a menu' });
    return items;
  };
  const close = async () => {
    await A.ask({ op: 'key', chars: '\u001b', code: 53, mods: 0 });
    await until(async () => (await A.ask({ op: 'mode' })).mode !== 'NSEventTrackingRunLoopMode', { timeout: 5000, what: 'Escape to close the menu' });
    await sleep(300);
  };
  const place = await A.js(`(() => { const r = (e) => { const b = e.getBoundingClientRect(); return [b.left + 8, b.top + b.height / 2]; }; return { link: r(qaCtx.querySelector('a')), box: r(qaCtx.querySelector('textarea')) }; })()`);
  const link = await open(...place.link);
  console.log(`  link: ${link}`);
  await close();
  ok(link.some((i) => /Copy Link/.test(i)), `no Copy Link: ${link}`);
  await A.js(`(() => { const t = qaCtx.querySelector('textarea'); t.focus(); t.select(); return 1; })()`);
  await sleep(300);
  const box = await open(...place.box);
  console.log(`  text box: ${box}`);
  await close();
  for (const i of ['Cut', 'Copy', 'Paste']) ok(box.includes(i), `no ${i}: ${box}`);
  await A.js(`(qaCtx.remove(), 1)`);
});

await check('TAURI-23', 'a file dropped from Finder lands in the prompt box', async () => {
  await A.ask({ op: 'activate' });
  await A.js(`(location.hash = '#/', document.querySelector('#splitNew')?.click(), 1)`);
  await sleep(600);
  const file = path.join(os.tmpdir(), `wisp-qa-drop-${process.pid}.txt`);
  fs.writeFileSync(file, 'dropped');
  await A.js(`(window.__qaDrop = null, addEventListener('dragover', (e) => (window.__qaOver = (window.__qaOver || 0) + 1), true), addEventListener('drop', (e) => (window.__qaDrop = [...e.dataTransfer.files].map((f) => f.name + ':' + f.size)), true), 1)`);
  const [x, y] = await A.js(`(() => { const r = document.querySelector('#prompt').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  console.log(`  ${JSON.stringify(await A.ask({ op: 'drop-file', path: file, x, y }))}`);
  const got = await until(() => A.js('window.__qaDrop'), { timeout: 8000, what: 'the drop event' });
  ok(got[0] === `${path.basename(file)}:7`, `the page got ${got}`);
  await until(() => A.js(`document.querySelector('#launcher')?.textContent.includes(${JSON.stringify(path.basename(file))})`), { timeout: 8000, what: 'the attachment to show' });
  fs.rmSync(file);
});

await check('TAURI-12', 'a second launch focuses the first and exits', async () => {
  const second = spawn(BINARY, [], { env: A.env, stdio: 'ignore' });
  const code = await Promise.race([new Promise((r) => second.on('exit', (c) => r(c ?? 0))), sleep(15_000).then(() => 'timeout')]);
  if (code === 'timeout') second.kill('SIGKILL');
  ok(code !== 'timeout', 'the second instance kept running');
  ok((await A.ask({ op: 'window' })).visible, 'first window gone');
  await A.ask({ op: 'minimize' });
  await until(async () => (await A.ask({ op: 'window' })).minimized, { timeout: 5000, what: 'the minimize' });
  const again = spawn(BINARY, [], { env: A.env, stdio: 'ignore' });
  await new Promise((r) => again.on('exit', r));
  await until(async () => !(await A.ask({ op: 'window' })).minimized, { timeout: 5000, what: 'the window to come back' });
});

await check('TAURI-13', 'closing keeps it running, a launch brings it back, quitting stops server and agents', async () => {
  await A.ask({ op: 'close' });
  await sleep(600);
  ok(!(await A.ask({ op: 'window' })).visible, 'still visible after close');
  ok(await listening(PORT), 'the server stopped with the window');
  // The page keeps working out of sight: the badge is how you hear from it.
  await A.ask({ op: 'eval', js: `setTimeout(() => (document.title = '(7) wisp'), 300); 0` });
  await until(async () => (await A.ask({ op: 'badge' })).badge === '7', { timeout: 5000, what: 'the badge from a hidden window' });
  await A.ask({ op: 'eval', js: `document.title = 'wisp'; 0` });
  const second = spawn(BINARY, [], { env: A.env, stdio: 'ignore' });
  await new Promise((r) => second.on('exit', r));
  await sleep(600);
  ok((await A.ask({ op: 'window' })).visible, 'not back after a launch');
  const repo = makeRepo();
  const s = await api(A.url, '/api/sessions', { prompt: 'wait', cwd: repo, agent: 'claude' });
  await until(async () => (await api(A.url, `/api/sessions/${s.json.id}`)).json?.state === 'running', { timeout: 15_000, what: 'a running task' });
  const quitAt = Date.now();
  await A.ask({ op: 'key', chars: 'q', code: 12, mods: CMD }); // ⌘Q: the app menu's Quit
  const code = await Promise.race([A.exited, sleep(10_000).then(() => 'timeout')]);
  ok(code !== 'timeout', 'the shell did not exit');
  console.log(`  quit took ${Date.now() - quitAt} ms, exit ${code}`);
  ok(!alive(A.serverPid), 'the server outlived the quit');
  ok(!(await listening(PORT)), 'the port stayed open');
  ok(!fs.existsSync(path.join(A.home, 'server.json')), 'no clean shutdown: server.json is still there');
  A = null;
});

await check('TAURI-14', 'attaches to a running wisp; quitting leaves it running', async () => {
  const cli = await startWisp({ port: OTHER });
  try {
    const pid = (await api(cli.url, '/api/health')).json.pid;
    A = await launch(OTHER, { env: { WISP_QA_PORT: String(OTHER + 1) } });
    ok((await api(cli.url, '/api/health')).json.pid === pid, 'a second server appeared');
    await quit();
    ok(await listening(OTHER), 'quitting stopped the CLI wisp');
  } finally {
    await cli.stop?.();
  }
});

await check('TAURI-15', 'kill -9 of the shell leaves no orphan', async () => {
  A = await launch(PORT);
  const pid = (await api(A.url, '/api/health')).json.pid;
  A.proc.kill('SIGKILL');
  await until(() => !alive(pid), { timeout: 20_000, what: 'the server to go' });
  await until(async () => !(await listening(PORT)), { timeout: 10_000, what: 'the port to close' });
  ok(!fs.existsSync(path.join(A.home, 'server.json')), 'the server was not shut down cleanly');
  A = null;
});

await check('TAURI-21', 'a server that ignores the quit is killed at the 5 s limit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-qa-stuck-'));
  fs.mkdirSync(path.join(root, 'desktop'));
  // Stands in for a shutdown that hangs: it answers like wisp and never reacts to stdin closing.
  fs.writeFileSync(path.join(root, 'desktop/entry.mjs'), `import http from 'node:http';
process.on('SIGTERM', () => {});
process.stdin.on('data', () => {}).on('error', () => {});
http.createServer((q, r) => { r.setHeader('content-type', q.url.startsWith('/api') ? 'application/json' : 'text/html'); r.end(q.url.startsWith('/api') ? JSON.stringify({ pid: process.pid }) : '<!doctype html><title>wisp</title><div id=launcher></div>'); }).listen(Number(process.env.WISP_PORT));
`);
  A = await launch(PORT, { env: { WISP_ROOT: root } });
  const pid = (await api(A.url, '/api/health')).json.pid;
  await A.ask({ op: 'activate' });
  await sleep(300);
  const at = Date.now();
  await A.ask({ op: 'key', chars: 'q', code: 12, mods: CMD });
  const code = await Promise.race([A.exited, sleep(12_000).then(() => 'timeout')]);
  const took = Date.now() - at;
  console.log(`  quit took ${took} ms, exit ${code}, child alive ${alive(pid)}`);
  ok(code !== 'timeout', 'the shell never exited');
  ok(took >= 4800 && took < 7000, `took ${took} ms`);
  ok(!alive(pid), 'the stuck server survived');
  ok(!(await listening(PORT)), 'the port stayed open');
  A = null;
});

await check('TAURI-22', 'a CLI added to the login shell is found behind the first window', async () => {
  // A home whose saved PATH has no grok, and a login shell that adds it, a little later.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-qa-path-'));
  const tools = path.join(home, 'tools');
  fs.mkdirSync(tools);
  fs.copyFileSync(path.join(qaEnv().bins, 'grok'), path.join(tools, 'grok'));
  fs.chmodSync(path.join(tools, 'grok'), 0o755);
  const data = path.join(home, 'Library/Application Support/dev.wisp.app');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'shell-path'), '/usr/bin:/bin');
  fs.writeFileSync(path.join(home, '.zshrc'), `sleep 4\nexport PATH="${tools}:$PATH"\n`);
  // Asked all along, from before the window: what it said first, then what it says once it's found.
  const seen = [];
  const watch = setInterval(() => {
    fetch(`http://localhost:${PORT}/api/agents`).then((r) => r.json()).then((list) => seen.push([Date.now(), !!list.find?.((a) => a.id === 'grok')?.available]), () => {});
  }, 200);
  A = await launch(PORT, { env: { HOME: home, SHELL: '/bin/zsh', ZDOTDIR: home, WISP_GROK_BIN: '' } });
  await until(() => seen.at(-1)?.[1], { timeout: 12_000, what: 'grok to be found' }).finally(() => clearInterval(watch));
  const missing = seen.filter(([, on]) => !on);
  console.log(`  grok missing for ${missing.length} answers, then found ${seen.find(([, on]) => on)[0] - seen[0][0]} ms after the first, no restart`);
  ok(missing.length, 'found before the login shell answered');
  ok(fs.readFileSync(path.join(data, 'shell-path'), 'utf8').startsWith(tools), 'the new PATH was not saved');
  await quit();
});

await check('TAURI-18b', 'another app in front: the page knows, and the task still notifies', async () => {
  // WKWebView alone keeps saying it has focus and fires no blur, and notify.js decides on this. Its
  // own run: a bare binary can't take the front back from whatever is there.
  A = await launch(PORT);
  await A.js(`(window.__qaBlur = 0, addEventListener('blur', () => window.__qaBlur++), 1)`);
  await A.ask({ op: 'deactivate' });
  await until(async () => !(await A.js('document.hasFocus()')), { timeout: 5000, what: 'the page to lose focus' });
  ok((await A.js('window.__qaBlur')) === 1, 'no blur on the window');
  ok((await A.ask({ op: 'window' })).visible, 'the window should stay on screen');
  await api(A.url, '/api/sessions', { prompt: 'fix the add function in math.js', cwd: makeRepo(), agent: 'claude' });
  await until(async () => (await A.ask({ op: 'delivered' })).delivered?.length, { timeout: 30_000, what: 'a notification with the window on screen' });
  await A.ask({ op: 'clear-delivered' });
  await quit();
});

await check('TAURI-17', 'capability: IPC only for this exact origin and port', async () => {
  const other = http.createServer((_, res) => (res.setHeader('content-type', 'text/html'), res.end('<title>other</title>x')));
  await new Promise((r) => other.listen(PREVIEW, '127.0.0.1', r));
  A = await launch(PORT, { env: { WISP_QA_ANY_NAV: '1' } });
  const call = `window.__TAURI_INTERNALS__.invoke('pick_folder').then((v) => 'allowed: ' + v, (e) => 'refused: ' + e)`;
  const go = async (url) => {
    await A.ask({ op: 'eval', js: `location.href = '${url}'; 0` });
    await until(async () => (await A.ask({ op: 'window' })).url.startsWith(url), { timeout: 8000, what: url });
    await sleep(500);
    return A.js(call);
  };
  ok((await A.js(call)).startsWith('allowed'), 'wisp itself was refused');
  const otherPort = await go(`http://localhost:${PREVIEW}/`);
  ok(otherPort.startsWith('refused'), `another port: ${otherPort}`);
  const otherHost = await go(`http://127.0.0.1:${PORT}/`);
  ok(otherHost.startsWith('refused'), `127.0.0.1, same port: ${otherHost}`);
  console.log(`  ${otherPort}`);
  await new Promise((r) => (other.closeAllConnections(), other.close(r)));
  await quit();
});

await quit();
process.exit(done());
