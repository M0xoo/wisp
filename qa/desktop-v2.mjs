// The v2 desktop app, on any OS (ADR-0013: the app ships the `wisp` binary Homebrew and npm ship): the Tauri shell
// starts `wisp serve` (desktop/src-tauri/src/server.rs), the window loads v2's page from it, and the server never
// outlives the shell, however the shell goes (WISP_EXIT_WITH_STDIN). Node built-ins only, so a bare runner runs it.
//
//   node qa/desktop-v2.mjs --app <the shell binary> [--wisp <the wisp binary>]   # a build from this checkout
//   node qa/desktop-v2.mjs --install dist/tauri/wisp-windows-x64-setup.exe        # Windows: the installer, then the app
//   node qa/desktop-v2.mjs --install <new setup.exe> --over <an older setup.exe>  # Windows: an update over an install
//   node qa/desktop-v2.mjs --zip dist/tauri/wisp-mac-arm64.zip                      # macOS: install.sh --app on it, then the app
//   add --qa on a Mac when the shell was built with `--features qa` (src/qa.rs): what needs AppKit's events (DESK2-06..08)
//
// Linux needs a display (xvfb-run). Each check prints PASS or FAIL; any FAIL exits 1. Writes qa/out/desktop-v2.md.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qa/out');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const win = process.platform === 'win32';
const PORT = Number(process.env.QA_DESKTOP_PORT) || 4791;
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'npm/wisp-agents/package.json'), 'utf8')).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function check(id, title, fn) {
  const at = Date.now();
  try {
    await fn();
    results.push([id, title, 'PASS', '', Date.now() - at]);
    console.log(`  PASS ${id} ${title}`);
  } catch (e) {
    results.push([id, title, 'FAIL', String(e?.message ?? e).split('\n')[0], Date.now() - at]);
    console.log(`  FAIL ${id} ${title}: ${e?.message ?? e}`);
  }
}
const ok = (cond, why) => {
  if (!cond) throw new Error(why);
};
async function until(fn, { timeout = 20_000, what = 'it' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`waited ${timeout / 1000} s for ${what}`);
    await sleep(250);
  }
}
const get = (p) =>
  new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c)).on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', () => resolve(null)).on('timeout', () => (r.destroy(), resolve(null)));
  });
const listening = () =>
  new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
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
const health = async () => {
  const r = await get('/api/health');
  if (r?.status !== 200) return null;
  try {
    return JSON.parse(r.body);
  } catch {
    return null;
  }
};

// Windows: the installer, silently, as the updater runs it; an older one first when asked (an update over it)
const installed = win ? path.join(process.env.LOCALAPPDATA ?? '', 'wisp/wisp.exe') : '';
const install = (setup) => execFileSync(setup, ['/S'], { stdio: 'inherit' });
let app = arg('--app');
const wisp = arg('--wisp');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-desktop-qa-'));

const qa = process.argv.includes('--qa') && process.platform === 'darwin';
const QA_PORT = PORT + 1;
function launch(extra = {}) {
  const env = { ...process.env, WISP_PORT: String(PORT), WISP_HOME: home, WISP_UPDATE_CHECK: '0', ...(wisp && { WISP_BIN: path.resolve(wisp) }), ...(qa && { WISP_QA_PORT: String(QA_PORT) }), ...extra };
  for (const k of ['WISP_DESKTOP', 'CI']) delete env[k];
  // --qa: a session of its own, as a Finder launch has (no terminal: src/shell_path.rs asks the login shell only then)
  const proc = spawn(app, [], { env, stdio: 'ignore', detached: qa });
  const exited = new Promise((r) => proc.once('exit', (c, s) => r(c ?? s)));
  return { proc, exited, at: Date.now() };
}

// The QA build's driver (desktop/src-tauri/src/qa.rs): one JSON line each way. `js` runs a script in the page (a
// promise can't cross evaluateJavaScript, so it parks its answer and is asked again).
const ask = (q) =>
  new Promise((resolve, reject) => {
    const s = net.connect(QA_PORT, '127.0.0.1');
    let buf = '';
    s.setTimeout(30_000, () => (s.destroy(), reject(new Error(`no answer to ${q.op}`))));
    s.setEncoding('utf8');
    s.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) (s.destroy(), resolve(JSON.parse(buf)));
    });
    s.on('error', reject);
    s.write(`${JSON.stringify(q)}\n`);
  });
const js = async (code) => {
  const key = `__qa${Math.random().toString(36).slice(2)}`;
  await ask({ op: 'eval', js: `(async () => (${code}))().then((v) => (window.${key} = { v }), (e) => (window.${key} = { e: String(e) })), 0` });
  const got = await until(
    async () => {
      const r = await ask({ op: 'eval', js: `JSON.stringify(window.${key} ?? null)` });
      return JSON.parse(JSON.parse(r.result || 'null') ?? 'null');
    },
    { timeout: 15_000, what: 'a script in the page' },
  );
  if (got.e) throw new Error(got.e);
  return got.v;
};
const shown = async () => (await ask({ op: 'window' }).catch(() => null))?.visible === true;
// a process that's already gone is done: taskkill says "not found" (exit 128), process.kill throws ESRCH; anything
// else, with the process still there, is a real failure
const signal = (pid, f) => {
  try {
    f();
  } catch (e) {
    if (alive(pid)) throw e;
  }
};
const hardKill = (pid) => signal(pid, () => (win ? execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' }) : process.kill(pid, 'SIGKILL')));
// Windows: what the title bar's close does (WM_CLOSE to the app's own window, once it's shown); v1 quits there.
// `taskkill /PID` without /F posts WM_CLOSE to every top-level window the process has, tao's hidden one included,
// and the app's window may never hear it: the QA's quit never reached the shell (#756 CI, DESK2-05).
const CLOSE_WINDOW = (pid) =>
  `$p = Get-Process -Id ${pid}; for ($i = 0; $i -lt 150 -and $p.MainWindowHandle -eq 0; $i++) { Start-Sleep -Milliseconds 200; $p.Refresh() }; if ($p.MainWindowHandle -eq 0) { Write-Error 'no window to close'; exit 2 }; if (-not $p.CloseMainWindow()) { exit 3 }`;
const closeWindow = (pid) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', CLOSE_WINDOW(pid)], { stdio: 'inherit', timeout: 60_000 });
// asks the shell to quit as a user does: its window's close on Windows, a TERM (the menu's Quit path) elsewhere
const askQuit = (pid) => signal(pid, () => (win ? closeWindow(pid) : process.kill(pid, 'SIGTERM')));

console.log(`\n  desktop v2 · ${process.platform} · port ${PORT}\n`);
ok(!(await listening()), `port ${PORT} is taken: set QA_DESKTOP_PORT`);

if (arg('--over')) await check('DESK2-00', 'an older install is there first (the update case)', async () => install(arg('--over')));
// over an older install, ~/.wisp holds the user's data: a file put there now must outlive the update (DESK2-01)
const keep = arg('--over') ? path.join(os.homedir(), '.wisp', `qa-keep-${process.pid}`) : '';
if (keep) (fs.mkdirSync(path.dirname(keep), { recursive: true }), fs.writeFileSync(keep, 'kept'));
if (arg('--install')) {
  await check('DESK2-01', 'setup.exe /S installs the app', async () => {
    install(arg('--install'));
    ok(fs.existsSync(installed), `no ${installed}`);
    ok(fs.existsSync(path.join(path.dirname(installed), 'resources/app/wisp.exe')), 'no wisp.exe in resources/app: the app would have no server');
    ok(fs.existsSync(path.join(path.dirname(installed), 'resources/app/web/index.html')), 'no web build beside it');
    ok(!fs.existsSync(path.join(path.dirname(installed), 'node')), 'a bundled Node is still there: v1 packaging');
    // v1's Node app beside it (an update over v1 must clear it: installer-hooks.nsh NSIS_HOOK_PREINSTALL)
    for (const left of ['server', 'bin', 'grid', 'skills', 'desktop', 'CHANGELOG.md'])
      ok(!fs.existsSync(path.join(path.dirname(installed), 'resources/app', left)), `v1's resources/app/${left} is still there`);
    // the update keeps the user's data: a file in ~/.wisp from before the install is still there
    if (keep) {
      ok(fs.existsSync(keep), `the update removed ${keep}: ~/.wisp must stay`);
      fs.rmSync(keep, { force: true });
    }
  });
  app = installed;
}
// macOS: the release's zip through install.sh --app, as `curl … install.sh | bash -s -- --app` runs it (F-desk-3), from
// a folder standing in for the release (WISP_DOWNLOADS), into a folder of its own (WISP_APP_DIR)
if (arg('--zip')) {
  await check('DESK2-10', 'install.sh --app installs the release zip: checked, unquarantined, signed', async () => {
    const zip = path.resolve(arg('--zip'));
    const rel = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-release-'));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-apps-'));
    const name = `wisp-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`;
    fs.copyFileSync(zip, path.join(rel, name));
    const sum = execFileSync('shasum', ['-a', '256', path.join(rel, name)], { encoding: 'utf8' }).split(' ')[0];
    fs.writeFileSync(path.join(rel, 'SHA256SUMS.txt'), `${sum}  ${name}\n`);
    execFileSync('bash', [path.join(ROOT, 'docs/install.sh'), '--app'], { stdio: 'inherit', env: { ...process.env, WISP_DOWNLOADS: `file://${rel}`, WISP_APP_DIR: dest, WISP_NO_OPEN: '1' } });
    const bundle = path.join(dest, 'wisp.app');
    ok(fs.existsSync(path.join(bundle, 'Contents/Resources/app/wisp')), 'no wisp binary in the installed app');
    ok(fs.existsSync(path.join(bundle, 'Contents/Resources/app/web/index.html')), 'no web build in the installed app');
    const attrs = execFileSync('xattr', ['-r', bundle], { encoding: 'utf8' });
    ok(!attrs.includes('com.apple.quarantine'), 'quarantined: macOS would warn');
    execFileSync('codesign', ['--verify', '--strict', bundle], { stdio: 'inherit' });
    // a zip that doesn't match the release's sums is refused
    fs.writeFileSync(path.join(rel, 'SHA256SUMS.txt'), `${'0'.repeat(64)}  ${name}\n`);
    let refused = false;
    try {
      execFileSync('bash', [path.join(ROOT, 'docs/install.sh'), '--app'], { stdio: 'ignore', env: { ...process.env, WISP_DOWNLOADS: `file://${rel}`, WISP_APP_DIR: dest, WISP_NO_OPEN: '1' } });
    } catch {
      refused = true;
    }
    ok(refused, 'a zip that fails its checksum was installed');
    app = path.join(bundle, 'Contents/MacOS/wisp');
  });
}
ok(app && fs.existsSync(app), `no app at ${app}: --app <shell binary>, --zip <mac zip> or --install <setup.exe>`);

let run = launch();
let server = 0;
await check('DESK2-02', 'the shell starts wisp serve, which answers as v2 on the port', async () => {
  const h = await until(health, { timeout: 90_000, what: 'GET /api/health' });
  ok(h.name === 'wisp' && h.ok === true, `health: ${JSON.stringify(h)}`);
  ok(typeof h.apiVersion === 'number' || typeof h.apiVersion === 'string', `no apiVersion: ${JSON.stringify(h)}`);
  if (arg('--install')) ok(h.version === version, `version ${h.version}, this build is ${version}`);
  server = h.pid;
  ok(server && server !== run.proc.pid, 'the server is its own process');
});
await check('DESK2-03', 'the page is v2’s web build, from the server beside the binary', async () => {
  const r = await get('/');
  ok(r?.status === 200, `GET / ${r?.status}`);
  ok(r.body.includes('<div id="app"></div>') && r.body.includes('PREPAINT_THEME'), 'not v2’s index.html');
});
if (qa) {
  await check('DESK2-0q', 'the QA build answers: the window is up with v2’s page in it', async () => {
    await until(shown, { timeout: 30_000, what: 'the window (a shell built with --features qa?)' });
    await until(() => js(`!!document.querySelector('[data-kit="stage"] [data-kit="topbar"]')`).catch(() => false), { timeout: 30_000, what: 'the page' });
  });
  // F-desk-6: no task open, a press on the top bar asks the shell to drag the window (WebKit has no app regions:
  // the page's [data-drag], packages/shell/src/platform/desktop.ts); a press on a button is the button's
  await check('DESK2-06', 'no task open: the top bar drags the window, its buttons stay buttons', async () => {
    const spots = await js(`(() => {
      const bar = document.querySelector('[data-kit="topbar"]');
      const mid = (e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
      const btn = bar.querySelector('button');
      const r = bar.getBoundingClientRect();
      for (let x = r.left + r.width / 2; x < r.right; x += 8) for (const y of [r.top + 6, r.top + r.height / 2]) {
        const e = document.elementFromPoint(x, y);
        if (e && bar.contains(e) && !e.closest('button, a, input, textarea, select, [role="button"], [data-no-drag]')) return { bar: [x, y], button: btn && mid(btn) };
      }
      return { bar: null, button: btn && mid(btn) };
    })()`);
    ok(spots.bar, 'no bare spot on the top bar');
    const presses = async ([x, y]) => {
      const before = (await ask({ op: 'drags' })).drags;
      await js(`(document.elementFromPoint(${x}, ${y}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, detail: 1 })), 1)`);
      await sleep(500);
      return (await ask({ op: 'drags' })).drags - before;
    };
    const bar = await presses(spots.bar);
    ok(bar === 1, `the top bar: ${bar} drags, want 1`);
    if (spots.button) {
      const button = await presses(spots.button);
      ok(button === 0, `a top bar button: ${button} drags, want 0`);
    }
    // a real press through AppKit, moved: the window's own drag takes it from there
    const [x, y] = spots.bar;
    await ask({ op: 'mouse', x, y, dx: 30, dy: 0 });
    await sleep(400);
  });
  // F-desk-4: WebKit's own menu: Copy Link on a link; Cut, Copy and Paste (and spelling) in a text box
  await check('DESK2-07', 'the right-click menu: Copy Link on a link, Cut Copy Paste and spelling in a text box', async () => {
    await ask({ op: 'activate' });
    await js(`(() => { document.querySelector('#qaCtx')?.remove(); const b = document.createElement('div'); b.id = 'qaCtx'; b.style.cssText = 'position:fixed;left:400px;top:300px;z-index:99999;background:#888;padding:20px'; b.innerHTML = '<a href="https://example.com/qa">a link</a><br><br><textarea spellcheck="true">some txet</textarea>'; document.body.append(b); return 1; })()`);
    const open = async (x, y) => {
      await ask({ op: 'right-click', x, y });
      const { items } = await until(async () => { const r = await ask({ op: 'context-menu' }); return r.items && r; }, { timeout: 8000, what: 'AppKit to open a menu' });
      await ask({ op: 'key', chars: '\u001b', code: 53, mods: 0 });
      await until(async () => (await ask({ op: 'mode' })).mode !== 'NSEventTrackingRunLoopMode', { timeout: 5000, what: 'Escape to close the menu' });
      await sleep(300);
      return items;
    };
    const place = await js(`(() => { const r = (e) => { const b = e.getBoundingClientRect(); return [b.left + 8, b.top + b.height / 2]; }; return { link: r(qaCtx.querySelector('a')), box: r(qaCtx.querySelector('textarea')) }; })()`);
    const link = await open(...place.link);
    ok(link.some((i) => /Copy Link/.test(i)), `no Copy Link: ${link}`);
    await js(`(() => { const t = qaCtx.querySelector('textarea'); t.focus(); t.select(); return 1; })()`);
    await sleep(300);
    const box = await open(...place.box);
    for (const i of ['Cut', 'Copy', 'Paste']) ok(box.includes(i), `no ${i}: ${box}`);
    ok(box.some((i) => /Spelling/.test(i)), `no spelling: ${box}`);
    await js(`(qaCtx.remove(), 1)`);
  });
}
await check('DESK2-04', 'killed hard, the shell takes the server with it (its stdin pipe)', async () => {
  hardKill(run.proc.pid);
  await run.exited;
  await until(async () => !alive(server) && !(await listening()), { timeout: 15_000, what: 'the server to stop' });
});
run = launch();
await check('DESK2-05', win ? 'the window closed, the app quits: the server stops and the port closes' : 'quit, it stops the server and the port closes', async () => {
  const h = await until(health, { timeout: 90_000, what: 'the second start' });
  server = h.pid;
  askQuit(run.proc.pid);
  // which side failed, if it does: a shell that never quit (it never reached its exit path) or a server that outlived it
  const quit = await Promise.race([run.exited.then(() => true), sleep(15_000).then(() => false)]);
  await until(async () => !alive(server) && !(await listening()), { timeout: 15_000, what: quit ? 'the server to stop (the shell quit)' : 'the server to stop (the shell never quit)' });
});
// nothing left behind for the next job on this runner
for (const pid of [run.proc.pid, server]) if (pid && alive(pid)) hardKill(pid);

// F-desk-5: the first open (nothing saved) with a ~/.zshrc that takes 6 s: the window shows within 5 s, and the
// next start runs the server on the PATH the login shell gave (desktop/src-tauri/src/shell_path.rs)
if (qa) {
  await check('DESK2-08', 'a slow ~/.zshrc: the first window shows within 5 s; the login shell’s PATH is saved for the next', async () => {
    await until(async () => !(await listening()), { timeout: 15_000, what: 'the port to close' });
    const zhome = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-qa-zsh-'));
    const marker = path.join(zhome, 'tools');
    fs.mkdirSync(marker);
    fs.writeFileSync(path.join(zhome, '.zshrc'), `export PATH="${marker}:$PATH"\nsleep 6\n`);
    const env = { HOME: zhome, SHELL: '/bin/zsh', ZDOTDIR: zhome };
    // quits as a user does (a TERM, the menu's Quit path), then makes sure: nothing outlives a failed check
    const done = async () => {
      askQuit(run.proc.pid);
      await Promise.race([run.exited, sleep(10_000)]);
      if (alive(run.proc.pid)) hardKill(run.proc.pid);
      await until(async () => !(await listening()), { timeout: 15_000, what: 'the port to close' });
    };
    run = launch(env);
    try {
      await until(shown, { timeout: 10_000, what: 'the window' });
      const took = Date.now() - run.at;
      console.log(`  first window after ${took} ms (the shell takes 6 s)`);
      ok(took <= 5000, `the window took ${took} ms`);
      // the app's data folder is named by its identifier (dev.wisp.app; a local build may carry another)
      const support = path.join(zhome, 'Library/Application Support');
      const saved = () => (fs.existsSync(support) ? fs.readdirSync(support) : []).map((d) => path.join(support, d, 'shell-path')).find((f) => fs.existsSync(f));
      await until(() => saved() && fs.readFileSync(saved(), 'utf8').startsWith(marker), { timeout: 20_000, what: 'the login shell’s PATH to be saved' });
    } finally {
      await done();
    }
    // the next start: the saved PATH at once, so the window doesn't wait on the 6 s shell either
    run = launch(env);
    try {
      await until(shown, { timeout: 10_000, what: 'the second window' });
      const again = Date.now() - run.at;
      console.log(`  second window after ${again} ms (the saved PATH)`);
      ok(again <= 5000, `the second window took ${again} ms`);
    } finally {
      await done();
    }
  });
}

fs.mkdirSync(OUT, { recursive: true });
const md = [`# Desktop v2 (${process.platform})`, '', '| Check | What | Result | Note | ms |', '|---|---|---|---|---:|', ...results.map((r) => `| ${r.join(' | ')} |`)].join('\n');
fs.writeFileSync(path.join(OUT, 'desktop-v2.md'), `${md}\n`);
const failed = results.filter((r) => r[2] === 'FAIL').length;
console.log(`\n  ${results.length - failed}/${results.length} passed · qa/out/desktop-v2.md\n`);
process.exit(failed ? 1 : 0);
