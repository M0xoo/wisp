// The Tauri shell (desktop/). Its Rust is checked by .github/workflows/tauri.yml and driven by
// qa/desktop-tauri.mjs; these are the parts that must hold without a build: the Node child can't
// outlive the shell, the updater still knows the app, and IPC stays on wisp's own origin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { alive, tmp, until } from './helpers.js';
import { Telemetry } from '../server/telemetry.js';
import { Updater, installMethod } from '../server/update.js';

const ROOT = path.join(import.meta.dirname, '..');
const SHELL = path.join(ROOT, 'desktop/src-tauri');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const health = (port) => fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
const homeEnv = (home, port, extra = {}) => {
  const env = { ...process.env, WISP_HOME: home, WISP_PORT: String(port), WISP_UPDATE_CHECK: '0', WISP_TELEMETRY: '0', WISP_FEEDBACK: '0', ...extra };
  for (const k of ['WISP_DEV', 'WISP_DESKTOP', 'WISP_DESKTOP_DATA']) delete env[k];
  return { ...env, ...extra };
};
const up = (port) => until(() => health(port).catch(() => null), { timeout: 60_000, what: 'the server' });

test('entry.mjs: the server shuts down when the shell closes the pipe', async () => {
  const [home, port] = [tmp('tauri-home'), await freePort()];
  const child = spawn(process.execPath, ['desktop/entry.mjs'], { cwd: ROOT, env: homeEnv(home, port), stdio: ['pipe', 'ignore', 'inherit'] });
  const gone = new Promise((r) => child.once('exit', r));
  const { pid } = await up(port);
  assert.equal(pid, child.pid);
  assert.ok(fs.existsSync(path.join(home, 'server.json')));
  child.stdin.end();
  await gone;
  assert.ok(!fs.existsSync(path.join(home, 'server.json')), 'shutdown() ran');
});

test('entry.mjs: kill -9 of the shell leaves no orphan', { skip: process.platform === 'win32' }, async () => {
  const [home, port, dir] = [tmp('tauri-home'), await freePort(), tmp('tauri-shell')];
  // A stand-in for the Rust shell: holds the pipe, and dies without closing anything itself.
  const script = path.join(dir, 'shell.mjs');
  fs.writeFileSync(script, `import { spawn } from 'node:child_process';\nconst c = spawn(process.execPath, ['desktop/entry.mjs'], { cwd: ${JSON.stringify(ROOT)}, stdio: ['pipe', 'pipe', 'inherit'] });\nc.stdout.resume();\nsetInterval(() => {}, 1000);\n`);
  const shell = spawn(process.execPath, [script], { env: homeEnv(home, port), stdio: 'ignore' });
  const { pid } = await up(port);
  assert.notEqual(pid, shell.pid);
  shell.kill('SIGKILL');
  await until(() => !alive(pid), { timeout: 20_000, what: 'the server to go' });
  assert.ok(!fs.existsSync(path.join(home, 'server.json')), 'it shut down rather than dying');
});

test('entry.mjs: starts on the saved PATH and asks the login shell behind it', { skip: process.platform === 'win32' }, async () => {
  const [home, port, data] = [tmp('tauri-home'), await freePort(), tmp('tauri-data')];
  const shellFile = path.join(data, 'sh');
  fs.writeFileSync(shellFile, '#!/bin/sh\nprintf "__WISP__%s__WISP__" "/from/login/shell:$PATH"\n', { mode: 0o755 });
  const child = spawn(process.execPath, ['desktop/entry.mjs'], { cwd: ROOT, env: homeEnv(home, port, { WISP_DESKTOP_DATA: data, SHELL: shellFile }), stdio: ['pipe', 'ignore', 'inherit'] });
  const gone = new Promise((r) => child.once('exit', r));
  await up(port);
  assert.match(fs.readFileSync(path.join(data, 'shell-path'), 'utf8'), /^\/from\/login\/shell:/);
  child.stdin.end();
  await gone;
});

test('telemetry tells the Tauri shell from Electron and the browser', () => {
  const was = process.env.WISP_DESKTOP;
  process.env.WISP_DESKTOP = 'tauri';
  try {
    assert.equal(new Telemetry({ home: tmp('tauri-tel') }, { post: async () => {} }).common.shell, 'tauri');
  } finally {
    if (was === undefined) delete process.env.WISP_DESKTOP;
    else process.env.WISP_DESKTOP = was;
  }
});

test('the updater reports the app on the Tauri layout, Node beside wisp’s files', () => {
  const contents = path.join(tmp('tauri-app'), 'wisp.app', 'Contents', 'Resources');
  const root = path.join(contents, 'app');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(contents, 'node', 'bin'), { recursive: true });
  assert.equal(installMethod(root), 'app');
  assert.equal(installMethod('C:\\Users\\u\\AppData\\Local\\wisp\\resources\\app'), 'app');
  assert.equal(installMethod('/usr/lib/wisp/resources/app'), 'app');
  const u = new Updater({ port: 4477, root, platform: 'darwin', arch: 'arm64', env: {} });
  assert.equal(u.method, 'app');
  assert.equal(u.assetName(), 'wisp-mac-arm64.zip');
  u.swap = { open: '/Applications/wisp.app', remove: '/tmp/old.app' };
  assert.equal(u.relaunchCommand(false), 'rm -rf "/tmp/old.app"; open "/Applications/wisp.app"', 'no Electron needed to relaunch');
  // The shell looks for wisp's files exactly there.
  assert.match(read('desktop/src-tauri/src/main.rs'), /resources\(app\)\.map\(\|r\| r\.join\(if cfg!\(windows\) \{ "resources\/app" \} else \{ "app" \}\)\)/);
});

test('capabilities: IPC for exactly wisp’s origin and port, nothing wider', () => {
  const cap = JSON.parse(read('desktop/src-tauri/capability.json'));
  assert.deepEqual(cap.remote, { urls: ['http://localhost:__PORT__/*'] });
  assert.equal(cap.local, false);
  assert.deepEqual(cap.windows, ['main']);
  assert.equal(cap.webviews, undefined);
  assert.deepEqual([...cap.permissions].sort(), ['allow-notify-show', 'allow-pick-folder', 'allow-start-drag', 'allow-zoom-window', 'notification:allow-is-permission-granted', 'notification:allow-request-permission']);
  // Only this one, filled in at start: a capabilities/ folder would be compiled in on its own.
  assert.ok(!fs.existsSync(path.join(SHELL, 'capabilities')));
  assert.deepEqual(JSON.parse(read('desktop/src-tauri/tauri.conf.json')).app.security.capabilities, []);
  const main = read('desktop/src-tauri/src/main.rs');
  assert.match(main, /add_capability\(CAPABILITY\.replace\("__PORT__", &port\.to_string\(\)\)\)/);
  // Declared commands go through the ACL; the page never starts processes.
  const manifest = read('desktop/src-tauri/build.rs').match(/commands\(&\[(.*?)\]\)/)[1].match(/"[^"]+"/g).map((s) => s.slice(1, -1));
  assert.deepEqual(manifest.sort(), ['notify_show', 'pick_folder', 'start_drag', 'zoom_window']);
  assert.match(main, /generate_handler!\[pick_folder, start_drag, zoom_window, notify::notify_show\]/);
  const cargo = read('desktop/src-tauri/Cargo.toml');
  assert.doesNotMatch(cargo, /tauri-plugin-(shell|fs|http)/);
});

test('macOS: the version the page’s CSS needs, and Tab reaches links like Electron', () => {
  assert.equal(JSON.parse(read('desktop/src-tauri/tauri.conf.json')).bundle.macOS.minimumSystemVersion, '13.3');
  assert.match(read('desktop/src-tauri/src/macos.rs'), /setTabFocusesLinks: true/);
  assert.match(read('desktop/src-tauri/src/main.rs'), /macos::tab_reaches_links\(&window\)/);
});

test('Linux can\'t be released until a frame can be told from the page', () => {
  assert.match(read('desktop/src-tauri/src/main.rs'), /#\[cfg\(all\(target_os = "linux", not\(debug_assertions\)\)\)\]\r?\ncompile_error!/);
});

// The Notification notify.js uses, in a stand-in for the page.
function notificationShim(platform = 'MacIntel', frame = false) {
  const calls = [];
  const on = {};
  const window = {
    __TAURI_INTERNALS__: { invoke: async (cmd, args) => (calls.push([cmd, args]), cmd === 'notify_show' ? null : 'granted') },
  };
  window.top = frame ? {} : window;
  const document = { hasFocus: () => true, adoptedStyleSheets: [] };
  const fired = [];
  const vm_ = { window, document, navigator: { platform }, CSSStyleSheet: class { replaceSync(css) { this.css = css; } }, addEventListener: (name, fn) => (on[name] = fn), dispatchEvent: (e) => fired.push(e.type), Event: class { constructor(type) { this.type = type; } }, Date, Math, Map, String, Object };
  vm.runInNewContext(read('desktop/src-tauri/src/init.js'), vm_);
  return { on, window, Notification: window.Notification, calls, click: (id) => on['wisp-notify-click']({ detail: id }), document, fired, focus: (detail) => on['wisp-window-focus']({ detail }) };
}

test('notifications: nothing shows before permission, and a click runs that note\'s onclick', async () => {
  const { Notification, calls, click } = notificationShim();
  assert.equal(Notification.permission, 'default', 'the shell hasn\'t answered yet');
  new Notification('too early');
  assert.ok(!calls.some(([c]) => c === 'notify_show'));
  assert.equal(await Notification.requestPermission(), 'granted');
  assert.equal(Notification.permission, 'granted');
  const [a, b] = [new Notification('one', { body: 'first' }), new Notification('two')];
  const shows = calls.filter(([c]) => c === 'notify_show').map(([, args]) => args);
  assert.deepEqual(shows.map(({ title, body }) => [title, body]), [['one', 'first'], ['two', '']]);
  assert.notEqual(shows[0].id, shows[1].id);
  assert.ok(shows.every(({ id }) => Number.isInteger(id) && id > 0 && id < 2 ** 31), 'the plugin takes an i32');
  const clicked = [];
  a.onclick = () => clicked.push('a');
  b.onclick = () => clicked.push('b');
  click(shows[1].id);
  assert.deepEqual(clicked, ['b']);
  click(shows[1].id);
  click(1); // from before a reload: nothing to run
  assert.deepEqual(clicked, ['b']);
  a.close();
});

test('another app in front: the page hears it from the shell', () => {
  const { document, fired, focus } = notificationShim();
  assert.equal(document.hasFocus(), true);
  focus(true); // the shell says so on every load
  assert.deepEqual(fired, []);
  focus(false);
  assert.equal(document.hasFocus(), false, 'WKWebView alone would still say true, and no alert would go out');
  focus(true);
  assert.equal(document.hasFocus(), true);
  assert.deepEqual(fired, ['blur', 'focus'], 'the page refreshes on these, and WKWebView doesn\'t fire them');
});

test('the bridge is the main frame’s, with pickFolder and nothing else', () => {
  const main = read('desktop/src-tauri/src/main.rs');
  assert.match(main, /\.initialization_script\(INIT\)/);
  assert.doesNotMatch(main, /initialization_script_for_all_frames/);
  assert.match(read('desktop/src-tauri/src/init.js'), /wispDesktop = Object\.freeze\(\{ pickFolder: /);
  assert.match(read('web/index.html'), /\/Electron\/\.test\(navigator\.userAgent\) \|\| window\.wispDesktop/);
});

// Measured on v0.57.0 on Windows: a real mouse on the top bar leaves the window where it was.
test('only on a Mac is the page the title bar: Windows keeps its own, and a click stays a click', () => {
  const mac = notificationShim('MacIntel');
  assert.ok(mac.on.mousedown);
  assert.equal(mac.document.adoptedStyleSheets.length, 0);
  const win = notificationShim('Win32');
  assert.equal(win.on.mousedown, undefined);
  // WebView2 honours -webkit-app-region, which Electron's framed window ignores.
  assert.match(win.document.adoptedStyleSheets[0].css, /-webkit-app-region: no-drag !important/);
});

test('WebView2 runs injected scripts in every frame: a frame gets no bridge and no shims', () => {
  const { window, on, document } = notificationShim('Win32', true);
  assert.equal(window.wispDesktop, undefined);
  assert.equal(window.Notification, undefined);
  assert.equal(on['wisp-notify-click'], undefined);
  assert.equal(document.adoptedStyleSheets.length, 0);
});

test('a Notification the plugin already called granted stays granted: Windows never asks', () => {
  const calls = [];
  const window = { Notification: { permission: 'granted' }, __TAURI_INTERNALS__: { invoke: async (cmd, args) => calls.push([cmd, args]) } };
  window.top = window;
  vm.runInNewContext(read('desktop/src-tauri/src/init.js'), { window, document: { hasFocus: () => true }, navigator: { platform: 'MacIntel' }, addEventListener: () => {}, dispatchEvent: () => {}, Event: class {}, Date, Math, Map, String, Object });
  assert.equal(window.Notification.permission, 'granted');
  new window.Notification('done', { body: 'x' });
  assert.equal(calls.length, 1);
});

test('the drag regions match every -webkit-app-region rule in the stylesheets', () => {
  const init = read('desktop/src-tauri/src/init.js');
  const table = JSON.parse(init.match(/const REGIONS = (\[[\s\S]*?\n {2}\]);/)[1].replace(/,\s*\]$/, ']'));
  const rules = [];
  for (const file of ['web/css/responsive.css', 'web/css/split.css']) {
    for (const m of read(file).matchAll(/^([^{}\n]+)\{([^}]*-webkit-app-region:\s*(drag|no-drag)[^}]*)\}/gm)) {
      for (const one of m[1].split(/,(?![^(]*\))/)) {
        const sel = one.trim();
        const is = sel.match(/^(.*):is\((.*)\)(.*)$/);
        for (const s of is ? is[2].split(',').map((x) => `${is[1]}${x.trim()}${is[3]}`) : [sel]) rules.push([s, m[3] === 'drag']);
      }
    }
  }
  assert.ok(rules.length >= 15, `found ${rules.length} rules`);
  const sorted = (l) => l.map((r) => JSON.stringify(r)).sort();
  assert.deepEqual(sorted(table), sorted(rules));
});

test('the shell is beside Electron: no dependency, nothing on npm', () => {
  const pkg = JSON.parse(read('package.json'));
  const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
  assert.ok(!Object.keys(all).some((d) => /tauri/.test(d)));
  assert.ok(!pkg.files.some((f) => f.startsWith('desktop')));
  assert.ok(all.electron, 'Electron stays until the switch');
});
