// Desktop app (Tauri) QA on Windows: the installed app, the way someone gets it. Scenarios:
// qa/scenarios/desktop.md (the Windows column). Run on windows-latest by .github/workflows/tauri-windows.yml:
//
//   node desktop/scripts/package.mjs --features qa
//   node qa/desktop-tauri-win.mjs [--artefacts dist/tauri]
//   node qa/desktop-tauri-win.mjs --web      # qa/web.mjs in the app's own WebView2
//
// It installs over your own wisp in %LOCALAPPDATA%\wisp and takes the display's size: CI's, not yours.
// The `qa` feature is one line of Rust (src/main.rs): WISP_QA_CDP opens WebView2's DevTools port, which
// no other way reaches once wry names its arguments. So the page is driven by Playwright, and
// everything around it by real mouse and keys and Win32 (qa/win32.ps1). What a hosted runner can't do
// goes in the table as Manual. Nothing here is marked as passed without running.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { makeRepo, until } from '../test/helpers.js';
import { OUT, ROOT, api, ok, playwright, qaEnv, runner, startWisp, win32 as win } from './lib.mjs';

if (process.platform !== 'win32') {
  console.log('qa/desktop-tauri-win.mjs drives Win32: Windows only');
  process.exit(0);
}

const { check: run, done, results } = runner('desktop-tauri-win');
// One stuck call to the page mustn't take the whole run with it.
const check = (id, title, fn) => run(id, title, () => Promise.race([fn(), sleep(150_000).then(() => { throw new Error('no answer in 150 s'); })]));
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SETUP = path.resolve(argOf('--artefacts', path.join(ROOT, 'dist/tauri')), 'wisp-windows-x64-setup.exe');
const EXE = path.join(process.env.LOCALAPPDATA, 'wisp/wisp.exe');
const PORT = Number(process.env.QA_TAURI_PORT) || 4781;
const CDP = PORT + 1;
const PREVIEW = PORT + 2;
const OTHER = PORT + 3;
const AUMID = 'dev.wisp.app';
const LOG = path.join(OUT, 'desktop-tauri-win-opened.log');
const MENU = path.join(OUT, 'desktop-tauri-win-menu.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notes = [];
const manual = (id, why) => notes.push([id, why]);

const one = (cmd, ...args) => win(cmd, ...args)[0];
const shell = (pid) => win('windows', pid).find((w) => w.cls === 'Tauri Window');
const listening = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
const shot = (name) => {
  const s = one('screen');
  one('crop', 0, 0, s.width, s.height, path.join(OUT, `desktop-tauri-win-${name}.png`));
};
const gone = (pids) => until(() => !win('alive', ...pids).length, { timeout: 20_000, what: `${pids} to go` });

let A = null;
let pw = null;

async function launch(port, { env: extra = {}, connect = true } = {}) {
  await quit();
  const { env, home, bins } = qaEnv({ WISP_PORT: String(port), WISP_UPDATE_CHECK: '0', WISP_QA_CDP: String(CDP), WISP_QA_MENU: MENU, ...extra });
  for (const [k, v] of Object.entries(env)) if (v === '') delete env[k];
  for (const k of ['ELECTRON_RUN_AS_NODE', 'WISP_DESKTOP', 'CI']) delete env[k];
  const proc = spawn(EXE, [], { env, stdio: 'ignore' });
  const exited = new Promise((r) => proc.once('exit', (c, s) => r(c ?? s)));
  const url = `http://localhost:${port}`;
  const app = { proc, exited, env, home, bins, url, pid: proc.pid, errors: [] };
  A = app;
  await until(() => shell(proc.pid)?.visible, { timeout: 60_000, what: 'the window' });
  if (connect) {
    pw ??= playwright();
    app.browser = await until(() => pw.chromium.connectOverCDP(`http://127.0.0.1:${CDP}`).catch(() => null), { timeout: 30_000, what: 'WebView2’s DevTools port' });
    app.page = await until(() => app.browser.contexts()[0]?.pages().find((p) => p.url().startsWith(url)), { timeout: 30_000, what: 'the page' });
    app.page.on('pageerror', (e) => app.errors.push(e.message));
    app.page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED/.test(m.text()) && app.errors.push(m.text()));
    await app.page.emulateMedia({ colorScheme: null }); // Playwright's light theme otherwise
    await app.page.waitForSelector('#launcher, #splitHome', { timeout: 30_000, state: 'attached' });
    await sleep(1200);
  }
  return app;
}

// Asks nicely, then not: nothing may be left holding the single-instance lock or WebView2's folder,
// and a new browser process only takes new arguments once the old one has gone.
async function quit() {
  if (!A) return;
  const app = A;
  A = null;
  await app.browser?.close().catch(() => {});
  const w = shell(app.pid);
  if (w) one('close', w.hwnd);
  const left = await Promise.race([app.exited.then(() => false), sleep(10_000).then(() => true)]);
  if (left) app.proc.kill();
  await app.exited;
  await until(() => !JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*dev.wisp.app*' }).Count | ConvertTo-Json`], { encoding: 'utf8' })), { timeout: 15_000, what: 'WebView2 to go' }).catch(() => {});
}

const client = () => shell(A.pid);
// A real pointer on a spot in the page.
const at = (w, x, y) => [Math.round(w.clientX + x), Math.round(w.clientY + y)];
const toFront = async () => {
  one('front', client().hwnd);
  await sleep(250);
};
// Playwright makes every page it drives say it has focus, and notify.js stays quiet when it does. So
// for focus it lets go, and the page is asked over the DevTools socket with nothing pretending.
const detach = async () => {
  await A.browser?.close().catch(() => {});
  A.browser = A.page = null;
};
const attach = async () => {
  A.browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
  A.page = A.browser.contexts()[0].pages().find((p) => p.url().startsWith(A.url));
  await A.page.emulateMedia({ colorScheme: null });
};
async function bare(expression) {
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page' && t.url.startsWith(A.url)).webSocketDebuggerUrl);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  const answer = new Promise((resolve) => (ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d.result?.result?.value); }));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  const value = await answer;
  ws.close();
  return value;
}
// As a person would: the Start menu again, which is a second launch. Then its taskbar button.
const restore = async () => {
  if (!client()?.minimized) return;
  await new Promise((r) => spawn(EXE, [], { env: A.env, stdio: 'ignore' }).once('exit', r));
  const back = await until(() => !client().minimized, { timeout: 8000, what: 'a second launch to bring it back' }).then(() => true, () => false);
  if (back) return;
  console.log(`  a second launch left it ${JSON.stringify((({ minimized, visible, foreground }) => ({ minimized, visible, foreground }))(client()))}; its taskbar button`);
  const s = one('screen');
  one('click', 1184, s.height - 24);
  await until(() => !client().minimized, { timeout: 8000, what: 'the taskbar button to bring it back' });
  throw new Error('a second launch didn’t bring the minimized window back; its taskbar button did');
};
const spot = (selector) => A.page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, selector);
const taskbar = (tag) => {
  const s = one('screen');
  return one('crop', 640, s.height - 48, 640, 48, path.join(OUT, `desktop-tauri-win-bar-${tag}.png`)).sha;
};

if (!process.env.CI) {
  console.log('qa/desktop-tauri-win.mjs replaces this machine’s wisp and display size: CI only');
  process.exit(0);
}

// qa/web.mjs, its own wisp and all, with the app's WebView2 as the browser: real contexts and pages
// in the engine Windows users get, not a Chrome that happens to share its version.
if (process.argv.includes('--web')) {
  if (!fs.existsSync(EXE)) await new Promise((r) => spawn(SETUP, ['/S'], { stdio: 'ignore' }).once('exit', r));
  await until(() => fs.existsSync(EXE), { timeout: 120_000, every: 500, what: 'wisp.exe' });
  one('resolution', 1920, 1080);
  await launch(PORT);
  const v = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
  console.log(`  qa/web.mjs in ${v.Browser}`);
  await A.browser.close();
  const code = await new Promise((r) => spawn(process.execPath, [path.join(ROOT, 'qa/web.mjs')], { stdio: 'inherit', env: { ...process.env, QA_ENGINE: 'webview2', QA_CDP: `http://127.0.0.1:${CDP}` } }).once('exit', r));
  A.browser = null;
  await quit();
  process.exit(code);
}
console.log(`\n  desktop (Tauri, Windows) · ${SETUP}\n`);

// Links go out through Windows, not a stub: these two land in a file instead of a browser or an editor.
for (const scheme of ['wispqa', 'vscode']) {
  const key = `HKCU\\Software\\Classes\\${scheme}`;
  const reg = (...a) => execFileSync('reg', ['add', ...a, '/f'], { stdio: 'ignore' });
  reg(key, '/ve', '/d', 'URL:QA');
  reg(key, '/v', 'URL Protocol', '/d', '');
  reg(`${key}\\shell\\open\\command`, '/ve', '/d', `cmd /c echo %1>>"${LOG}"`);
}

await check('TAURI-W00', 'setup.exe /S installs the app', async () => {
  ok(fs.existsSync(SETUP), `no ${SETUP}: node desktop/scripts/package.mjs --features qa`);
  ok((await new Promise((r, j) => spawn(SETUP, ['/S'], { stdio: 'ignore' }).once('exit', r).once('error', j))) === 0, 'the installer failed');
  await until(() => fs.existsSync(EXE), { timeout: 120_000, every: 500, what: 'wisp.exe' });
});

await check('TAURI-W02b', 'a 1366×768 laptop: stops at the screen as Electron does', async () => {
  one('resolution', 1366, 768);
  await sleep(1500);
  await launch(PORT, { connect: false });
  const [w, s] = [client(), one('screen')];
  console.log(`  ${w.width}×${w.height} at ${w.x},${w.y}, work area ${s.workWidth}×${s.workHeight}`);
  ok(w.width === s.workWidth && w.height === s.workHeight && w.x === 0 && w.y === 0, `${w.width}×${w.height} at ${w.x},${w.y}: v0.57.0 is 1366×720 at 0,0`);
  await quit();
  one('resolution', 1920, 1080);
  await sleep(1500);
});

await check('TAURI-W01', 'boots: the page, and a server that is the shell’s Node child', async () => {
  ok(!(await listening(PORT)), `port ${PORT} already in use`);
  await launch(PORT);
  const health = await api(A.url, '/api/health');
  ok(health.status === 200, `health ${health.status}`);
  A.server = health.json.pid;
  ok(A.server !== A.pid, 'the server is the shell');
  ok(win('tree', A.pid).some((p) => p.pid === A.server && p.parent === A.pid), `server ${A.server} isn’t a child of ${A.pid}`);
  const node = one('path-of', A.server).path;
  ok(node.toLowerCase() === path.join(path.dirname(EXE), 'node/node.exe').toLowerCase(), `the server runs on ${node}`);
  ok((await api(A.url, '/api/update')).json?.method === 'app', 'the updater doesn’t call it the app');
  const cls = await A.page.evaluate(() => document.body.className);
  ok(/\belectron\b/.test(cls) && /\bother\b/.test(cls) && !/\bmac\b/.test(cls), `body classes: ${cls}`);
  shot('boot');
});

await check('TAURI-W02', 'window: titled wisp, 1380×900 as a whole, centred, as v0.57.0 measures', async () => {
  const [w, s] = [client(), one('screen')];
  console.log(`  ${w.width}×${w.height} at ${w.x},${w.y}, page ${w.clientWidth}×${w.clientHeight}`);
  ok(w.title === 'wisp', `title "${w.title}"`);
  ok(w.width === 1380 && w.height === 900, `${w.width}×${w.height}`);
  ok(w.x === Math.floor((s.workWidth - 1380) / 2) && w.y === Math.floor((s.workHeight - 900) / 2), `at ${w.x},${w.y}`);
  // By its corner with a real mouse: moving it from a script goes round the limit, here and on Electron.
  await toFront();
  one('drag', w.x + w.width - 5, w.y + w.height - 5, -1200, -800);
  await sleep(600);
  const small = client();
  console.log(`  dragged in, stopped at ${small.width}×${small.height}, page ${small.clientWidth}×${small.clientHeight}`);
  one('move', w.hwnd, w.x, w.y, w.width, w.height);
  await sleep(400);
  ok(small.clientWidth >= 720 && small.clientHeight >= 520, `shrank to ${small.clientWidth}×${small.clientHeight}`);
  ok(small.width < 1000, `the drag took no hold: ${small.width}×${small.height}`);
});

await check('TAURI-W03', 'title bar: Windows’ own, no Mac insets, a drag on the top bar moves nothing', async () => {
  ok(!(await A.page.evaluate(() => document.body.classList.contains('mac'))), 'the page took the Mac’s insets');
  ok(client().clientY - client().y > 30, 'no title bar above the page');
  await toFront();
  const before = client();
  const [x, y] = at(before, 900, 8);
  console.log(`  under the pointer: ${await A.page.evaluate(() => document.elementFromPoint(900, 8)?.className)}`);
  one('drag', x, y, 60, 40);
  await sleep(700);
  const after = client();
  ok(after.x === before.x && after.y === before.y, `moved from ${before.x},${before.y} to ${after.x},${after.y}`);
  one('dblclick', x, y);
  await sleep(700);
  ok(!client().maximized, 'a double-click on the top bar maximized it');
  one('dblclick', x, before.y + 15);
  await sleep(900);
  ok(client().maximized, 'a double-click on the real title bar didn’t maximize it');
  one('dblclick', x, 12);
  await sleep(900);
  ok(!client().maximized, 'a double-click on the real title bar didn’t restore it');
});

await check('TAURI-W04', 'no page errors while loading', async () => {
  A.errors.length = 0;
  await A.page.reload();
  await A.page.waitForSelector('#launcher, #splitHome', { state: 'attached' });
  await sleep(1500);
  ok(!A.errors.length, A.errors.slice(0, 3).join(' | '));
});

await check('TAURI-W05', 'bridge: pickFolder only, no Node, no Get the app; the real folder dialog', async () => {
  const r = await A.page.evaluate(() => ({ keys: Object.keys(window.wispDesktop || {}), node: typeof window.require, getApp: document.querySelector('#getAppBtn')?.hidden ?? true }));
  ok(r.keys.join() === 'pickFolder', `bridge exposes ${r.keys}`);
  ok(r.node === 'undefined', 'require leaks into the page');
  ok(r.getApp, 'Get the app pill shows');
  await toFront();
  await A.page.evaluate(() => { window.__qaPick = 'waiting'; window.wispDesktop.pickFolder().then((v) => (window.__qaPick = v)); });
  const dialog = await until(() => win('tops').find((w) => w.pid === A.pid && w.cls === '#32770'), { timeout: 10_000, what: 'the folder dialog' });
  console.log(`  dialog "${dialog.title}"`);
  ok(dialog.title === 'Add project', `dialog says ${dialog.title}`);
  shot('picker');
  one('front', dialog.hwnd);
  await sleep(300);
  one('keys', '{ESC}');
  await until(() => A.page.evaluate(() => window.__qaPick === null), { timeout: 8000, what: 'Cancel to give null' });
});

await check('TAURI-W06', 'links: out through Windows’ own handler, the window stays on wisp', async () => {
  fs.rmSync(LOG, { force: true });
  const opened = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');
  await A.page.evaluate(() => { window.open('wispqa://popup'); });
  await until(() => opened().includes('wispqa://popup'), { timeout: 8000, what: 'window.open to reach the handler' });
  await A.page.evaluate(() => { const a = Object.assign(document.createElement('a'), { href: 'wispqa://blank', target: '_blank' }); document.body.append(a); a.click(); a.remove(); });
  await until(() => opened().includes('wispqa://blank'), { timeout: 8000, what: 'a target=_blank link' });
  await A.page.evaluate(() => { location.href = 'wispqa://nav'; }).catch(() => {});
  await until(() => opened().includes('wispqa://nav'), { timeout: 8000, what: 'a navigation' });
  await A.page.evaluate(() => { window.open('vscode://file/C:/qa.js'); });
  await until(() => opened().includes('vscode://file/C:/qa.js'), { timeout: 8000, what: 'a vscode:// link, the editor’s road' });
  await A.page.evaluate(() => { location.href = 'file:///C:/Windows/notepad.exe'; }).catch(() => {});
  await sleep(1000);
  ok(!win('tops').some((w) => /notepad/i.test(w.title)), 'a file:// link opened');
  ok(!opened().includes('file:'), `a file url went out: ${opened()}`);
  ok(A.page.url().startsWith(A.url), `the window left wisp: ${A.page.url()}`);
  await A.page.evaluate(() => (location.hash = '#/'));
});

await check('TAURI-W06b', 'previews stay in their frame; frames have no IPC and no bridge', async () => {
  const preview = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<title>p</title><a id=next href="/next">next</a><p>${req.url}</p>`);
  });
  await new Promise((r) => preview.listen(PREVIEW, '127.0.0.1', r));
  await A.page.goto(`${A.url}/`).catch(() => {});
  await sleep(1000);
  fs.rmSync(LOG, { force: true });
  try {
  await A.page.evaluate((p) => new Promise((done) => { const f = document.createElement('iframe'); f.id = 'qaf'; f.src = `http://localhost:${p}/first`; f.onload = () => done(1); document.body.append(f); }), PREVIEW);
  await A.page.evaluate((p) => new Promise((done) => { qaf.onload = () => done(1); qaf.src = `http://localhost:${p}/next`; }), PREVIEW);
  const frame = A.page.frames().find((f) => f !== A.page.mainFrame() && f.url().includes(String(PREVIEW)));
  ok(frame, 'no preview frame');
  const call = `(window.__TAURI_INTERNALS__ ? window.__TAURI_INTERNALS__.invoke('zoom_window').then(() => 'ALLOWED', (e) => 'refused: ' + e) : Promise.resolve('no internals'))`;
  const inside = await frame.evaluate(`(async () => ({ bridge: !!window.wispDesktop, invoke: await ${call} }))()`);
  console.log(`  a preview frame: ${JSON.stringify(inside)}`);
  ok(!inside.bridge && inside.invoke !== 'ALLOWED', `a preview frame: ${JSON.stringify(inside)}`);
  // A frame moving to a page of another site stays a frame, as on macOS. (To another app's scheme
  // WebView2 asks first, "This site is trying to open…", which is better than Electron's silence.)
  await A.page.evaluate(() => { qaf.src = 'https://example.net/qa-frame'; });
  await sleep(1200);
  ok(!fs.existsSync(LOG), `a frame’s navigation left the app: ${fs.existsSync(LOG) && fs.readFileSync(LOG, 'utf8')}`);
  ok(A.page.url().startsWith(A.url), `the window left wisp: ${A.page.url()}`);
  await A.page.evaluate(() => qaf.remove());
  // srcdoc and sandboxed, as app blocks and panes are: an origin of null.
  const sandboxed = await A.page.evaluate((c) => new Promise((done) => { const f = document.createElement('iframe'); f.sandbox = 'allow-scripts'; f.srcdoc = `<script>${c}.then((invoke) => parent.postMessage({ bridge: !!window.wispDesktop, invoke }, "*"))<\/script>`; addEventListener('message', (e) => done(e.data), { once: true }); document.body.append(f); setTimeout(() => done('nothing'), 5000); }), call);
  console.log(`  a sandboxed frame: ${JSON.stringify(sandboxed)}`);
  ok(sandboxed !== 'nothing', 'the sandboxed frame never ran');
  ok(!sandboxed.bridge && sandboxed.invoke !== 'ALLOWED', `a sandboxed frame: ${JSON.stringify(sandboxed)}`);
  } finally {
    await new Promise((r) => (preview.closeAllConnections(), preview.close(r)));
  }
});

await check('TAURI-W07', 'menu bar, and real keys in the prompt box', async () => {
  const { menu } = client();
  const of = (t) => menu.find((m) => m.title === t)?.items || [];
  console.log(`  ${menu.map((m) => m.title)}; View: ${of('View').map((i) => i.text + (i.grey ? ' (grey)' : '')).filter(Boolean).join(', ')}`);
  ok(menu.map((m) => m.title).join() === 'File,Edit,View,Window', `menus: ${menu.map((m) => m.title)}`);
  ok(!menu.flatMap((m) => m.items).some((i) => i.text && i.grey), `greyed out: ${menu.flatMap((m) => m.items).filter((i) => i.grey).map((i) => i.text)}`);
  ok(of('View').some((i) => /^Zoom In\tCtrl\+=/.test(i.text)), 'Zoom In has no shortcut');
  ok(of('View').some((i) => /^Toggle Full Screen\tF11/.test(i.text)), 'Toggle Full Screen has no shortcut');
  await toFront();
  await A.page.evaluate(() => { const t = document.querySelector('#prompt, #launcher textarea, textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); window.__qaT = t; });
  const box = () => A.page.evaluate(() => __qaT.value);
  const shows = (want, what) => until(async () => (await box()) === want, { timeout: 5000, what });
  one('keys', 'hello');
  await shows('hello', 'typing');
  one('keys', '^a');
  await until(() => A.page.evaluate(() => __qaT.selectionEnd - __qaT.selectionStart === 5), { timeout: 5000, what: 'Ctrl+A' });
  one('keys', '^c');
  await sleep(200);
  one('keys', '^x');
  await shows('', 'Ctrl+X');
  one('keys', '^v');
  await shows('hello', 'Ctrl+V');
  one('keys', '^z');
  await shows('', 'Ctrl+Z');
});

await check('TAURI-W07b', 'Ctrl+Tab reaches the page', async () => {
  await toFront();
  await A.page.evaluate(() => { window.__qaTab = 0; addEventListener('keydown', (e) => { if (e.key === 'Tab' && e.ctrlKey) window.__qaTab++; }, true); document.activeElement?.blur(); });
  one('keys', '^{TAB}');
  await until(() => A.page.evaluate(() => window.__qaTab > 0), { timeout: 5000, what: 'the keydown' });
  await A.page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true })));
  await sleep(300);
});

await check('TAURI-W07c', 'F11 and the zoom keys do what the menu says', async () => {
  await toFront();
  await A.page.evaluate(() => document.activeElement?.blur());
  const inner = () => A.page.evaluate(() => innerWidth);
  const wide = await inner();
  one('keys', '^=');
  await until(async () => (await inner()) < wide, { timeout: 5000, what: 'Ctrl+= to zoom in' });
  one('keys', '^-');
  await until(async () => (await inner()) === wide, { timeout: 5000, what: 'Ctrl+- to zoom back out' });
  one('keys', '^=');
  await until(async () => (await inner()) < wide, { timeout: 5000, what: 'Ctrl+= again' });
  one('keys', '^0');
  await until(async () => (await inner()) === wide, { timeout: 5000, what: 'Ctrl+0 to reset' });
  const s = one('screen');
  one('keys', '{F11}');
  await until(() => client().width >= s.width, { timeout: 5000, what: 'F11 to fill the screen' });
  one('keys', '{F11}');
  await until(() => client().width === 1380, { timeout: 5000, what: 'F11 to come back' });
  one('keys', '^m');
  await until(() => client().minimized, { timeout: 5000, what: 'Ctrl+M to minimize' });
  await restore();
});

await check('TAURI-W08', 'follows the system’s theme, live', async () => {
  const dark = () => A.page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
  one('theme', 'dark');
  await until(dark, { timeout: 8000, what: 'the page to see dark' });
  await sleep(500);
  shot('dark');
  one('theme', 'light');
  await until(async () => !(await dark()), { timeout: 8000, what: 'the page to see light' });
  await sleep(500);
});

await check('TAURI-W09', 'the count shows on the taskbar icon as on Electron, the window keeps its name', async () => {
  const set = (t) => A.page.evaluate((v) => { document.title = v; }, t);
  await set('wisp');
  await sleep(800);
  const none = taskbar('0');
  await set('(3) wisp');
  await sleep(800);
  const three = taskbar('3');
  ok(three !== none, 'the taskbar looks the same with a count');
  ok(client().title === 'wisp', `the window took the page’s title: ${client().title}`);
  await set('(127) wisp');
  await sleep(800);
  ok(taskbar('127') !== three, 'the count on the taskbar didn’t change');
  await set('wisp');
  await sleep(800);
  ok(taskbar('off') === none, 'the count stayed on the taskbar');
});

await check('TAURI-W10', 'a task runs on the fake agent and its presentation renders', async () => {
  const repo = makeRepo();
  const s = await api(A.url, '/api/sessions', { prompt: 'fix the add function in math.js', cwd: repo, agent: 'claude' });
  ok(s.status === 201, `launch ${s.status} ${s.text.slice(0, 200)}`);
  const id = s.json.id;
  const fin = await until(async () => {
    const r = await api(A.url, `/api/sessions/${id}`);
    return r.json && !['running', 'queued', 'starting'].includes(r.json.state) && r.json;
  }, { timeout: 60_000, what: 'the task to finish' });
  ok(fin.state !== 'failed', `task ${fin.state}`);
  await sleep(900);
  await toFront();
  const row = await A.page.evaluate((i) => { const e = [...document.querySelectorAll(`[data-id="${i}"]`)].find((x) => x.offsetParent); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, id);
  one('click', ...at(client(), ...row));
  await A.page.waitForSelector('.blk-hero, .hero', { timeout: 15_000 });
  await sleep(800);
  shot('presentation');
});

await check('TAURI-W10b', 'stacked under 900px', async () => {
  const w = client();
  one('move', w.hwnd, w.x, w.y, 800, 700);
  await until(() => A.page.evaluate(() => document.body.classList.contains('stack')), { timeout: 5000, what: 'the stacked layout' });
  shot('stacked');
  one('move', w.hwnd, w.x, w.y, 1380, 900);
  await sleep(500);
});

await check('TAURI-W18b', 'another app in front: the page knows, once, as WebView2 tells it', async () => {
  await toFront();
  await detach();
  try {
    await until(() => bare('document.hasFocus()'), { timeout: 8000, what: 'the page to have focus' });
    await bare(`(window.__qaF = [], ['focus', 'blur'].forEach((k) => addEventListener(k, () => __qaF.push(k))), 1)`);
    spawn('notepad.exe', [], { stdio: 'ignore', detached: true }).unref();
    const pad = await until(() => win('tops').find((w) => /Notepad/i.test(w.title)), { timeout: 15_000, what: 'Notepad' });
    one('front', pad.hwnd);
    await until(async () => !(await bare('document.hasFocus()')), { timeout: 8000, what: 'the page to lose focus' });
    await sleep(500);
    ok((await bare('__qaF.join()')) === 'blur', `events: ${await bare('__qaF.join()')}`);
  } finally {
    execFileSync('taskkill', ['/F', '/IM', 'notepad.exe'], { stdio: 'ignore' });
    await toFront();
    await attach();
  }
});

await check('TAURI-W18', 'a task that finishes in a minimized window is a toast in Action Center', async () => {
  // As Electron from the first page: no one is ever asked, and notify.js sends nothing before this.
  ok((await A.page.evaluate(() => Notification.permission)) === 'granted', `permission ${await A.page.evaluate(() => Notification.permission)}`);
  const refused = await A.page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:notification|notify', { options: { title: 'x' } }).then(() => 'allowed', () => 'refused'));
  ok(refused === 'refused', `the plugin’s own command reaches the page: ${refused}`);
  await toFront();
  await detach();
  try {
    const w = client();
    one('click', w.x + w.width - 114, w.y + 16); // the real minimize button
    await until(() => client().minimized, { timeout: 5000, what: 'the minimize button' });
    await sleep(800);
    console.log(`  minimized: hasFocus, visibility ${JSON.stringify(await bare('[document.hasFocus(), document.visibilityState]'))}`);
    await until(async () => !(await bare('document.hasFocus()')), { timeout: 5000, what: 'the page to say it has no focus' });
    const s = await api(A.url, '/api/sessions', { prompt: 'fix the add function in math.js', cwd: makeRepo(), agent: 'claude' });
    const [text] = await until(() => { const t = one('toasts', AUMID).texts; return t.length && t; }, { timeout: 30_000, what: 'Windows to hold a toast' });
    console.log(`  toast "${text}"`);
    ok(text.includes('finished') || text.includes('ready'), `the toast says ${text}`);
    await sleep(700);
    shot('toast'); // a hosted desktop shows no banner: Action Center holds it, a click on one is Manual
  } finally {
    await restore();
    await attach();
  }
});

await check('TAURI-W19', 'Reload and Force Reload, by their keys', async () => {
  await restore();
  await toFront();
  for (const keys of ['^r', '^+r']) {
    await A.page.evaluate(() => { window.__qaKept = 1; document.activeElement?.blur(); });
    one('keys', keys);
    await until(() => A.page.evaluate(() => window.__qaKept === undefined && document.readyState === 'complete').catch(() => false), { timeout: 15_000, what: `${keys} to reload` });
    await A.page.waitForSelector('#launcher, #splitHome', { state: 'attached' }); // it comes back on the task that was open
    await sleep(500);
  }
});

await check('TAURI-W20', 'the right-click menu holds what Electron’s does, no Inspect, no Back or Print', async () => {
  await restore();
  await toFront();
  await A.page.evaluate(() => { const b = document.createElement('div'); b.id = 'qaCtx'; b.style.cssText = 'position:fixed;left:300px;top:200px;z-index:99999;background:#888;padding:20px'; b.innerHTML = '<a href="https://example.com/qa">a link here</a><br><br><textarea>some text</textarea><p>plain text</p>'; document.body.append(b); });
  await sleep(300);
  const w = client();
  // WebView2 draws its menu itself and no automation reads it, so: what it offered, from the shell,
  // and a picture of what was left.
  const open = async (name, selector) => {
    fs.rmSync(MENU, { force: true });
    const r = await A.page.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return [b.left + 8, b.top + b.height / 2]; }, selector);
    one('click', ...at(w, ...r), 'right');
    await until(() => fs.existsSync(MENU), { timeout: 5000, what: `a menu on ${name}` });
    await sleep(700);
    shot(`ctx-${name}`);
    one('keys', '{ESC}');
    await sleep(500);
    const offered = fs.readFileSync(MENU, 'utf8').trim().split(/\r?\n/).map((l) => l.split(' ')[1]).reverse();
    console.log(`  ${name}: ${offered.join(' ')}`);
    return offered;
  };
  const link = await open('link', '#qaCtx a');
  const box = await open('box', '#qaCtx textarea');
  const plain = await open('plain', '#qaCtx p');
  await A.page.evaluate(() => qaCtx.remove());
  ok(link.includes('copyLinkLocation'), `no Copy Link: ${link}`);
  for (const i of ['cut', 'copy', 'paste', 'undo', 'selectAll']) ok(box.includes(i), `no ${i}: ${box}`);
  for (const offered of [link, box, plain]) ok(!offered.includes('inspectElement'), `Inspect in a release build: ${offered}`);
});

await check('TAURI-W12', 'a second launch focuses the first and exits', async () => {
  const again = () => new Promise((r) => {
    const c = spawn(EXE, [], { env: A.env, stdio: 'ignore' });
    const t = setTimeout(() => (c.kill(), r('timeout')), 15_000);
    c.once('exit', (code) => (clearTimeout(t), r(code ?? 0)));
  });
  ok((await again()) !== 'timeout', 'the second instance kept running');
  ok(client()?.visible, 'first window gone');
  one('minimize', client().hwnd);
  await until(() => client().minimized, { timeout: 5000, what: 'the minimize' });
  await again();
  await until(() => !client().minimized, { timeout: 5000, what: 'the window to come back' });
});

const hung = async () => {
  const s = await api(A.url, '/api/sessions', { prompt: 'wait here', cwd: makeRepo(), agent: 'claude' });
  await until(async () => (await api(A.url, `/api/sessions/${s.json.id}`)).json?.state === 'running', { timeout: 20_000, what: 'a running task' });
  return until(() => { const t = win('tree', A.server).filter((p) => /fake|claude/i.test(p.cmd)); return t.length && t; }, { timeout: 15_000, what: 'the agent’s process' });
};

await check('TAURI-W13', 'the X closes the window, quits, stops the agent and the server cleanly', async () => {
  await quit();
  await launch(PORT, { env: { FAKE_HANG: '1' } });
  A.server = (await api(A.url, '/api/health')).json.pid;
  const agents = await hung();
  console.log(`  agent ${agents.map((p) => p.pid)}`);
  const app = A;
  await toFront();
  const w = client();
  const at0 = Date.now();
  one('click', w.x + w.width - 26, w.y + 16); // the real X
  const code = await Promise.race([app.exited, sleep(12_000).then(() => 'timeout')]);
  console.log(`  quit took ${Date.now() - at0} ms, exit ${code}`);
  ok(code !== 'timeout', 'the shell did not exit');
  await gone([app.server, ...agents.map((p) => p.pid)]);
  await until(async () => !(await listening(PORT)), { timeout: 10_000, what: 'the port to close' });
  ok(!fs.existsSync(path.join(app.home, 'server.json')), 'no clean shutdown: server.json is still there');
  await app.browser?.close().catch(() => {});
  A = null;
});

await check('TAURI-W14', 'attaches to a running wisp; quitting leaves it running', async () => {
  const cli = await startWisp({ port: OTHER });
  try {
    const pid = (await api(cli.url, '/api/health')).json.pid;
    await launch(OTHER);
    ok((await api(cli.url, '/api/health')).json.pid === pid, 'a second server appeared');
    await quit();
    ok(await listening(OTHER), 'quitting stopped the CLI wisp');
  } finally {
    await cli.stop?.();
  }
});

await check('TAURI-W15', 'killing the shell leaves no server, agent or port behind', async () => {
  await launch(PORT, { env: { FAKE_HANG: '1' } });
  A.server = (await api(A.url, '/api/health')).json.pid;
  const agents = await hung();
  const app = A;
  execFileSync('taskkill', ['/F', '/PID', String(app.pid)], { stdio: 'ignore' }); // no /T: only the shell, as a crash
  await app.exited;
  await gone([app.server, ...agents.map((p) => p.pid)]);
  await until(async () => !(await listening(PORT)), { timeout: 10_000, what: 'the port to close' });
  ok(!fs.existsSync(path.join(app.home, 'server.json')), 'the server was not shut down cleanly');
  await app.browser?.close().catch(() => {});
  A = null;
});

await check('TAURI-W21', 'a server that ignores the quit is killed at the 5 s limit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-qa-stuck-'));
  fs.mkdirSync(path.join(root, 'desktop'));
  fs.writeFileSync(path.join(root, 'desktop/entry.mjs'), `import http from 'node:http';
process.stdin.on('data', () => {}).on('error', () => {});
http.createServer((q, r) => { r.setHeader('content-type', q.url.startsWith('/api') ? 'application/json' : 'text/html'); r.end(q.url.startsWith('/api') ? JSON.stringify({ pid: process.pid }) : '<!doctype html><title>wisp</title><div id=launcher></div>'); }).listen(Number(process.env.WISP_PORT));
`);
  await launch(PORT, { env: { WISP_ROOT: root } });
  const pid = (await api(A.url, '/api/health')).json.pid;
  const app = A;
  const at0 = Date.now();
  one('close', client().hwnd);
  const code = await Promise.race([app.exited, sleep(12_000).then(() => 'timeout')]);
  const took = Date.now() - at0;
  console.log(`  quit took ${took} ms, exit ${code}`);
  ok(code !== 'timeout', 'the shell never exited');
  ok(took >= 4500 && took < 8000, `took ${took} ms`);
  await gone([pid]);
  ok(!(await listening(PORT)), 'the port stayed open');
  await app.browser?.close().catch(() => {});
  A = null;
});

await check('TAURI-W17', 'capability: IPC only for this exact origin and port', async () => {
  const other = http.createServer((_, res) => (res.setHeader('content-type', 'text/html'), res.end('<title>other</title>x')));
  await new Promise((r) => other.listen(PREVIEW, '127.0.0.1', r));
  await launch(PORT, { env: { WISP_QA_ANY_NAV: '1' } });
  const call = () => A.page.evaluate(() => window.__TAURI_INTERNALS__.invoke('zoom_window').then(() => 'allowed', (e) => `refused: ${e}`));
  ok((await call()) === 'allowed', 'wisp itself was refused');
  await A.page.evaluate(() => 0);
  await call();
  for (const url of [`http://localhost:${PREVIEW}/`, `http://127.0.0.1:${PORT}/`]) {
    await A.page.goto(url);
    await sleep(500);
    const said = await call();
    console.log(`  ${url}: ${said}`);
    ok(said.startsWith('refused'), `${url}: ${said}`);
  }
  await new Promise((r) => (other.closeAllConnections(), other.close(r)));
  await quit();
});

await quit();

manual('A toast’s banner, and a click on it opening the task', 'a hosted desktop shows no banner (Action Center holds the toast, TAURI-W18). From Action Center the plugin hears no click: it starts the app, which shows itself. By hand');
manual('A file dropped from Explorer', 'no way to start a real OLE drag from a script; the shell turns Tauri’s handler off as on macOS. By hand');
manual('Spelling suggestions in the right-click menu', 'needs a dictionary, which the runner’s language pack may not hold. By hand');
manual('Download in a browser, SmartScreen’s Run anyway', 'needs a real download and a person. By hand');
manual('High DPI', 'a hosted runner has one 100% display');
manual('Windows on arm64', 'windows-latest is x64; it builds in tauri-package.yml and runs nowhere');
manual('Electron→Tauri self-update, seen', 'needs a Tauri build on a release; the installer half is INST-23 to 28');

const lines = ['| Scenario | Result |', '|---|---|', ...results.map((r) => `| ${r.id} ${r.title} | ${r.ok ? 'ran: pass' : `ran: FAIL, ${r.error}`} |`), ...notes.map(([p, why]) => `| ${p} | Manual: ${why} |`)];
fs.writeFileSync(path.join(OUT, 'desktop-tauri-win.md'), `${lines.join('\n')}\n`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Desktop (Tauri, Windows)\n\n${lines.join('\n')}\n`);
process.exit(done());
