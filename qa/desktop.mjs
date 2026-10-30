// Desktop app (Electron) QA: drives `electron .` from this checkout with Playwright's _electron.
// Scenarios: qa/scenarios/desktop.md (DESK-*). Run: node qa/desktop.mjs
//
// Each app gets its own WISP_HOME, port (4520+) and --user-data-dir, so a wisp.app you have open
// (same package name, so the same single-instance lock) is never touched.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { makeRepo, until } from '../test/helpers.js';
import { OUT, ROOT, api, ok, playwright, qaEnv, runner, startWisp } from './lib.mjs';

const ELECTRON = createRequire(path.join(ROOT, 'package.json'))('electron');
const { _electron } = playwright();
const { check, done } = runner('desktop');
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `desktop-${name}.png`) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listening = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });

// The fake agents by their WISP_*_BIN: electron/main.js swaps PATH for the login shell's.
const BIN_ENV = { claude: 'CLAUDE', codex: 'CODEX', opencode: 'OPENCODE', 'cursor-agent': 'CURSOR', agy: 'ANTIGRAVITY', grok: 'GROK', copilot: 'COPILOT' };

async function launch(port, { env: extra = {}, userData } = {}) {
  const { env, home, bins } = qaEnv({ WISP_PORT: String(port), WISP_UPDATE_CHECK: '0', ...extra });
  for (const [bin, k] of Object.entries(BIN_ENV)) env[`WISP_${k}_BIN`] = path.join(bins, bin);
  // Not the dev app's switches: WISP_DEV pins --remote-debugging-port=9339, which Playwright needs.
  for (const k of ['ELECTRON_RUN_AS_NODE', 'WISP_DEV', 'WISP_DEBUG_PORT']) delete env[k];
  userData ||= fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-qa-electron-'));
  const app = await _electron.launch({ executablePath: ELECTRON, args: [ROOT, `--user-data-dir=${userData}`], cwd: ROOT, env, timeout: 60_000 });
  const errors = [];
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.waitForURL(`http://localhost:${port}/**`, { timeout: 30_000 });
  await page.waitForSelector('#launcher, #splitHome', { timeout: 30_000 });
  await page.waitForTimeout(1500);
  return { app, page, errors, home, bins, userData, env, url: `http://localhost:${port}` };
}

// Interactive elements under the macOS traffic lights (hiddenInset at x 16, y 18).
const underLights = (page) =>
  page.evaluate(() => {
    const hits = [];
    for (let x = 12; x <= 76; x += 4)
      for (let y = 10; y <= 36; y += 4) {
        const e = document.elementFromPoint(x, y)?.closest('button, a, input, textarea, select, [role=button], .p-chip');
        if (e && e.offsetParent !== null) hits.push(e.id || e.className || e.tagName);
      }
    return [...new Set(hits)];
  });

const PORT = Number(process.env.QA_DESKTOP_PORT) || 4521;
let A;

await check('DESK-01', 'electron . boots, starts its own server and loads the page', async () => {
  ok(!(await listening(PORT)), `port ${PORT} already in use`);
  A = await launch(PORT);
  ok(await listening(PORT), 'no server on the port');
  const health = await api(A.url, '/api/health');
  ok(health.status === 200, `health ${health.status}`);
  // The server lives inside the Electron main process.
  ok(health.json?.pid === (await A.app.evaluate(() => process.pid)), `server pid ${health.json?.pid} is not Electron's main process`);
  ok(await A.page.evaluate(() => document.body.classList.contains('electron')), 'body.electron missing');
  await shot(A.page, 'boot');
});

await check('DESK-02', 'window title, size and minimum size', async () => {
  const w = await A.app.evaluate(({ BrowserWindow }) => {
    const b = BrowserWindow.getAllWindows()[0];
    return { title: b.getTitle(), size: b.getSize(), min: b.getMinimumSize(), visible: b.isVisible(), count: BrowserWindow.getAllWindows().length };
  });
  ok(w.count === 1, `${w.count} windows`);
  ok(w.visible, 'window not shown');
  ok(w.title === 'wisp', `title "${w.title}"`);
  ok(w.min[0] === 720 && w.min[1] === 520, `min size ${w.min}`);
  ok(w.size[0] >= 720 && w.size[0] <= 1380 && w.size[1] >= 520 && w.size[1] <= 900, `size ${w.size}`);
});

await check('DESK-03', 'nothing clickable under the traffic lights (split view, list hidden, feed)', async () => {
  if (process.platform !== 'darwin') return;
  ok(await A.page.evaluate(() => document.body.classList.contains('mac')), 'body.mac missing');
  const bad = {};
  const view = async (name) => {
    await A.page.waitForTimeout(500);
    const hits = await underLights(A.page);
    if (hits.length) bad[name] = hits;
    await A.page.screenshot({ path: path.join(OUT, `desktop-lights-${name}.png`), clip: { x: 0, y: 0, width: 420, height: 90 } });
  };
  // Shortcuts only work outside the prompt box, which has focus on the home screen.
  const key = async (k) => {
    await A.page.evaluate(() => document.activeElement?.blur());
    await A.page.keyboard.press(k);
  };
  const cls = () => A.page.evaluate(() => ({ split: document.body.classList.contains('split'), hidden: document.body.classList.contains('side-hidden') }));
  await view('split');
  ok((await cls()).split, 'not in split view at 1380px');
  await key('[');
  ok((await cls()).hidden, '[ did not hide the list');
  await view('split-list-hidden');
  await key('[');
  ok(!Object.keys(bad).length, `under the lights: ${JSON.stringify(bad)}`);
});

await check('DESK-04', 'no console errors while loading', async () => {
  const errs = A.errors.filter((e) => !/favicon/i.test(e));
  ok(!errs.length, errs.slice(0, 3).join(' | '));
});

await check('DESK-05', 'preload bridge: window.wispDesktop.pickFolder, and no Get the app pill', async () => {
  const r = await A.page.evaluate(() => ({
    keys: Object.keys(window.wispDesktop || {}),
    pick: typeof window.wispDesktop?.pickFolder,
    node: typeof window.require,
    getApp: document.querySelector('#getAppBtn')?.hidden ?? true,
  }));
  ok(r.pick === 'function', `pickFolder is ${r.pick}`);
  ok(r.keys.join() === 'pickFolder', `bridge exposes ${r.keys}`);
  ok(r.node === 'undefined', 'Node require leaks into the page');
  ok(r.getApp, 'Get the app pill shows inside the app');
  // The IPC handler answers (the dialog is stubbed: a real one needs a person).
  await A.app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['/tmp/qa-picked'] });
  });
  const picked = await A.page.evaluate(() => window.wispDesktop.pickFolder());
  ok(picked === '/tmp/qa-picked', `pickFolder returned ${picked}`);
});

await check('DESK-06', 'external links open outside the app; wisp links stay inside', async () => {
  await A.app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = async (u) => void globalThis.__opened.push(u);
  });
  await A.page.evaluate(() => window.open('https://example.com/qa-popup'));
  await A.page.evaluate(() => {
    const a = Object.assign(document.createElement('a'), { href: 'vscode://file/tmp/qa.js', target: '_blank' });
    document.body.append(a);
    a.click();
    a.remove();
  });
  await A.page.evaluate(() => {
    location.href = 'https://example.org/qa-navigate';
  });
  await sleep(800);
  const opened = await A.app.evaluate(() => globalThis.__opened);
  const r = await A.app.evaluate(({ BrowserWindow }) => ({ n: BrowserWindow.getAllWindows().length, url: BrowserWindow.getAllWindows()[0].webContents.getURL() }));
  ok(opened.includes('https://example.com/qa-popup'), `window.open not sent out: ${opened}`);
  ok(opened.some((u) => u.startsWith('vscode://')), `editor link not sent out: ${opened}`);
  ok(opened.includes('https://example.org/qa-navigate'), `navigation not sent out: ${opened}`);
  ok(r.n === 1, `${r.n} windows after external links`);
  ok(r.url.startsWith(A.url), `the window left wisp: ${r.url}`);
  // Playwright still waits on the navigation the app cancelled: reload to settle it.
  await A.page.reload();
  await A.page.waitForSelector('#launcher, #splitHome');
});

await check('DESK-07', 'application menu: app, File, Edit, View, Window', async () => {
  const labels = await A.app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((i) => i.role || i.label));
  const want = [...(process.platform === 'darwin' ? ['appmenu'] : []), 'filemenu', 'editmenu', 'viewmenu', 'windowmenu'];
  ok(JSON.stringify(labels.map((l) => String(l).toLowerCase())) === JSON.stringify(want), `menu ${labels}`);
});

await check('DESK-08', 'follows the system theme (light ⇄ dark)', async () => {
  const bg = () => A.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await A.page.emulateMedia({ colorScheme: null }); // Playwright pins light by default
  await A.app.evaluate(({ nativeTheme }) => (nativeTheme.themeSource = 'light'));
  await A.page.waitForTimeout(600);
  const light = await bg();
  await shot(A.page, 'light');
  await A.app.evaluate(({ nativeTheme }) => (nativeTheme.themeSource = 'dark'));
  await A.page.waitForTimeout(600);
  const dark = await bg();
  await shot(A.page, 'dark');
  const isDark = await A.page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
  await A.app.evaluate(({ nativeTheme }) => (nativeTheme.themeSource = 'system'));
  ok(isDark, 'page did not see prefers-color-scheme: dark');
  ok(light !== dark, `same background in light and dark: ${light}`);
});

await check('DESK-09', 'dock badge follows the Needs you count in the page title', async () => {
  const r = await A.page.evaluate(() => document.title);
  const n = Number(r.match(/^\((\d+)\)/)?.[1] || 0);
  const badge = await A.app.evaluate(({ app }) => app.getBadgeCount());
  ok(badge === n, `title "${r}" but badge ${badge}`);
});

await check('DESK-10', 'launch a task on the fake agent; its presentation renders in the window', async () => {
  const repo = makeRepo();
  const s = await api(A.url, '/api/sessions', { prompt: 'fix the add function in math.js', cwd: repo, agent: 'claude' });
  ok(s.status === 201, `launch ${s.status} ${s.text.slice(0, 200)}`);
  const id = s.json.id;
  const fin = await until(async () => {
    const r = await api(A.url, `/api/sessions/${id}`);
    return r.json && !['running', 'queued', 'starting'].includes(r.json.state) && r.json;
  }, { timeout: 60_000, what: 'the task to finish' });
  ok(fin.state !== 'failed', `task ${fin.state}: ${JSON.stringify(fin.error || '').slice(0, 200)}`);
  await shot(A.page, 'finished');
  const dbg = await A.page.evaluate((id) => [...document.querySelectorAll(`[data-id="${id}"]`)].map((e) => `${e.tagName}.${e.className} ${e.getBoundingClientRect().width}x${e.getBoundingClientRect().height}`), id);
  ok(dbg.length, `no node for the task in the page (state ${fin.state})`);
  await A.page.locator(`[data-id="${id}"]:visible`).first().click({ timeout: 10_000 }).catch((e) => {
    throw new Error(`can't click the task (${dbg.join(', ')}): ${e.message.replace(/\s+/g, ' ').slice(0, 900)}`);
  });
  await A.page.waitForSelector('.blk-hero, .hero', { timeout: 15_000 });
  await A.page.waitForTimeout(1200);
  await shot(A.page, 'presentation');
  const fixed = fs.readFileSync(path.join(fin.worktree?.cwd || fin.cwd || repo, 'math.js'), 'utf8');
  ok(/a \+ b/.test(fixed), 'math.js was not fixed in the task folder');
});

await check('DESK-11', 'updater in a git checkout: method git, no Update button', async () => {
  const u = await api(A.url, '/api/update');
  ok(u.json?.method === 'git', `method ${u.json?.method}`);
  ok(!u.json?.available, 'an update is offered to a git clone');
  ok(await A.page.evaluate(() => document.querySelector('#updateBtn').hidden), '#updateBtn visible');
  const post = await api(A.url, '/api/update', { force: false });
  ok(post.status >= 400 && /git clone/.test(post.text), `POST /api/update ${post.status} ${post.text.slice(0, 120)}`);
});

await check('DESK-12', 'a second launch focuses the running app instead of opening another', async () => {
  const env = { ...A.env };
  const second = spawn(ELECTRON, [ROOT, `--user-data-dir=${A.userData}`], { env, stdio: 'ignore' });
  const code = await Promise.race([new Promise((r) => second.on('exit', (c) => r(c ?? 0))), sleep(20_000).then(() => 'timeout')]);
  if (code === 'timeout') second.kill('SIGKILL');
  ok(code !== 'timeout', 'the second instance kept running');
  const n = await A.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  ok(n === 1, `${n} windows after a second launch`);
});

await check('DESK-13', 'quitting stops the server it started', async () => {
  await A.app.close();
  await until(async () => !(await listening(PORT)), { timeout: 15_000, what: 'the port to close' });
  A = null;
});

await check('DESK-14', 'attaches to a wisp already running on the port, and leaves it running on quit', async () => {
  const W = await startWisp({ port: 4522 });
  let B;
  try {
    const pid = (await api(W.url, '/api/health')).json.pid;
    B = await launch(4522);
    ok((await api(W.url, '/api/health')).json.pid === pid, 'the server changed');
    ok((await B.app.evaluate(() => process.pid)) !== pid, 'Electron started its own server');
    await shot(B.page, 'attached');
    await B.app.close();
    B = null;
    await sleep(800);
    ok((await api(W.url, '/api/health')).status === 200, 'quitting the app stopped the CLI\'s server');
  } finally {
    await B?.app.close().catch(() => {});
    W.stop();
  }
});

await A?.app.close().catch(() => {});
process.exit(done());
