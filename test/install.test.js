// No harness yet: POST /agents/install puts opencode into ~/.wisp/tools with npm, and the
// opencode adapter finds it there although it isn't on PATH.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { npmCmdShim, tmp, win } from './helpers.js';

// A clean slate: no wisp home, no ~/.opencode, and a PATH without any harness CLI.
process.env.WISP_HOME = tmp('install-home');
process.env.HOME = process.env.USERPROFILE = tmp('install-user');
process.env.PATH = path.dirname(process.execPath) + (win ? `${path.delimiter}${process.env.SystemRoot}\\System32` : `${path.delimiter}/usr/bin${path.delimiter}/bin`);
delete process.env.WISP_OPENCODE_BIN;

const { createInstaller, npmInstall } = await import('../server/services/install.js');
const { listAgents } = await import('../server/adapters/index.js');
const { toolsDir } = await import('../server/util.js');

const FAKE = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

// What `npm install --prefix <dir> opencode-ai` leaves behind: node_modules/.bin/opencode.
function fakeNpmInstall(calls) {
  return async (pkg, dir) => {
    calls.push({ pkg, dir });
    const lib = path.join(dir, 'node_modules', 'opencode-ai');
    const bin = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(lib, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.copyFileSync(FAKE, path.join(lib, 'opencode.mjs'));
    if (win) return fs.writeFileSync(path.join(bin, 'opencode.cmd'), npmCmdShim('../opencode-ai/opencode.mjs'));
    const exe = path.join(bin, 'opencode');
    fs.writeFileSync(exe, `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(path.join(lib, 'opencode.mjs')).href)});\n`);
    fs.chmodSync(exe, 0o755);
  };
}

const fakeApp = () => {
  const events = [];
  const tracked = [];
  return {
    events,
    tracked,
    broadcast: (type) => events.push(type),
    telemetry: { track: (e, p) => tracked.push({ e, ...p }) },
    auto: { detect: (opts) => listAgents(opts) },
  };
};

test('with nothing installed, opencode is not found', async () => {
  const oc = (await listAgents({ fresh: true })).find((a) => a.id === 'opencode');
  assert.equal(oc.available, false);
});

test('installing opencode puts it in ~/.wisp/tools, and it is detected from there with its models', async () => {
  const calls = [];
  const app = fakeApp();
  const installer = createInstaller(app, { install: fakeNpmInstall(calls) });
  // Two clicks (or two tabs) share one install.
  const [a, b] = await Promise.all([installer.run('opencode'), installer.run('opencode')]);
  assert.equal(a, b);
  assert.deepEqual(calls, [{ pkg: 'opencode-ai', dir: toolsDir() }]);
  assert.equal(toolsDir(), path.join(process.env.WISP_HOME, 'tools'));
  const oc = a.find((x) => x.id === 'opencode');
  assert.equal(oc.available, true);
  assert.ok(oc.models.some((m) => m.id.includes('/')), 'models come from the installed CLI');
  assert.deepEqual(app.events, ['agents'], 'open pages are told to reload the harness list');
  assert.equal(app.tracked[0].e, 'harness_install');
  assert.equal(app.tracked[0].ok, true);
  assert.equal(installer.installing('opencode'), false);
});

test('only opencode can be installed', async () => {
  const installer = createInstaller(fakeApp(), { install: () => assert.fail('must not install') });
  await assert.rejects(installer.run('claude'), (err) => err.status === 400 && /can’t install claude/.test(err.message));
});

test('an npm failure is reported with npm’s own words, and the next click tries again', async () => {
  const app = fakeApp();
  let n = 0;
  const installer = createInstaller(app, {
    install: async () => {
      n++;
      throw Object.assign(new Error('npm install opencode-ai failed: EACCES'), { status: 424 });
    },
  });
  await assert.rejects(installer.run('opencode'), /EACCES/);
  await assert.rejects(installer.run('opencode'), /EACCES/);
  assert.equal(n, 2);
  assert.equal(app.tracked.at(-1).ok, false);
  assert.deepEqual(app.events, []);
});

test('npmInstall runs npm install --prefix and passes on its error output', async () => {
  const dir = tmp('fake-npm');
  const script = path.join(dir, 'npm.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(path.join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));\nconsole.error('npm error code E404\\nnpm error 404 Not Found');\nprocess.exit(1);\n`);
  let npm = path.join(dir, win ? 'npm.cmd' : 'npm');
  if (win) fs.writeFileSync(npm, npmCmdShim('npm.mjs'));
  else (fs.writeFileSync(npm, `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(script).href)});\n`), fs.chmodSync(npm, 0o755));
  const prefix = path.join(dir, 'tools');
  await assert.rejects(npmInstall('opencode-ai', prefix, { npm }), (err) => err.status === 424 && /failed: .*404 Not Found/.test(err.message));
  const argv = JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8'));
  assert.deepEqual(argv.slice(0, 3), ['install', '--prefix', prefix]);
  assert.equal(argv.at(-1), 'opencode-ai@latest');
  // No npm at all: say what to install.
  npm = path.join(dir, 'no-such-npm');
  await assert.rejects(npmInstall('opencode-ai', prefix, { npm }), (err) => err.status === 424 && /npm isn’t on PATH/.test(err.message));
});
