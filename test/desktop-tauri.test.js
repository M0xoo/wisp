// The Tauri shell (desktop/). Its Rust is checked by .github/workflows/tauri.yml and driven by
// qa/desktop-tauri.mjs; these are the parts that must hold without a build: the Node child can't
// outlive the shell, the updater still knows the app, and IPC stays on wisp's own origin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
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
  assert.match(read('desktop/src-tauri/src/main.rs'), /resource_dir\(\)\.ok\(\)\.map\(\|r\| r\.join\("app"\)\)/);
});

test('capabilities: IPC for exactly wisp’s origin and port, nothing wider', () => {
  const cap = JSON.parse(read('desktop/src-tauri/capability.json'));
  assert.deepEqual(cap.remote, { urls: ['http://localhost:__PORT__/*'] });
  assert.equal(cap.local, false);
  assert.deepEqual(cap.windows, ['main']);
  assert.equal(cap.webviews, undefined);
  assert.deepEqual([...cap.permissions].sort(), ['allow-pick-folder', 'allow-start-drag', 'allow-zoom-window']);
  // Only this one, filled in at start: a capabilities/ folder would be compiled in on its own.
  assert.ok(!fs.existsSync(path.join(SHELL, 'capabilities')));
  assert.deepEqual(JSON.parse(read('desktop/src-tauri/tauri.conf.json')).app.security.capabilities, []);
  const main = read('desktop/src-tauri/src/main.rs');
  assert.match(main, /add_capability\(CAPABILITY\.replace\("__PORT__", &port\.to_string\(\)\)\)/);
  // Declared commands go through the ACL; the page never starts processes.
  const manifest = read('desktop/src-tauri/build.rs').match(/commands\(&\[(.*?)\]\)/)[1].match(/"[^"]+"/g).map((s) => s.slice(1, -1));
  assert.deepEqual(manifest.sort(), ['pick_folder', 'start_drag', 'zoom_window']);
  assert.match(main, /generate_handler!\[pick_folder, start_drag, zoom_window\]/);
  const cargo = read('desktop/src-tauri/Cargo.toml');
  assert.doesNotMatch(cargo, /tauri-plugin-(shell|fs|http)/);
});

test('the bridge is the main frame’s, with pickFolder and nothing else', () => {
  const main = read('desktop/src-tauri/src/main.rs');
  assert.match(main, /\.initialization_script\(INIT\)/);
  assert.doesNotMatch(main, /initialization_script_for_all_frames/);
  assert.match(read('desktop/src-tauri/src/init.js'), /wispDesktop = Object\.freeze\(\{ pickFolder: /);
  assert.match(read('web/index.html'), /\/Electron\/\.test\(navigator\.userAgent\) \|\| window\.wispDesktop/);
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
