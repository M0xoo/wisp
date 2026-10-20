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

test('with nothing installed, opencode is not found, and each harness says how to get it', async () => {
  const agents = await listAgents({ fresh: true });
  const oc = agents.find((a) => a.id === 'opencode');
  assert.equal(oc.available, false);
  // Settings → Agents and the picker show these: a tip for this OS, a docs link, maybe a command.
  for (const a of agents.filter((x) => !x.available)) {
    assert.ok(a.setup?.tip, `${a.id} has a setup tip`);
    assert.match(a.setup.url, /^https:\/\//, `${a.id} links its install guide`);
  }
  const { adapters } = await import('../server/adapters/index.js');
  assert.match(adapters.codex.setup('win32').tip, /can’t be run from outside the app/, 'no ChatGPT-app promise on Windows');
  assert.match(adapters.codex.setup('linux').tip, /ChatGPT desktop app/);
  assert.equal(adapters.claude.setup('win32').command, 'irm https://claude.ai/install.ps1 | iex');
  assert.doesNotMatch(adapters.claude.setup('linux').tip, /Claude app/, 'no Claude desktop app on Linux');
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

// No codex or claude on PATH, but a desktop app brought one: the ChatGPT app ships codex inside
// its bundle, the Claude app downloads claude for its Code tab. wisp finds and runs those copies.
const fakeCli = (exe, name) => {
  const lib = path.join(path.dirname(exe), 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(FAKE, path.join(lib, `${name}.mjs`)); // the fake plays the harness its file is named after
  fs.writeFileSync(exe, `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(path.join(lib, `${name}.mjs`)).href)});\n`);
  fs.chmodSync(exe, 0o755);
};

test('codex and claude are found off PATH where their installers and desktop apps keep them', { skip: win }, async () => {
  const { adapters } = await import('../server/adapters/index.js');
  const { fallbackBins: codexBins } = await import('../server/adapters/codex.js');
  const { fallbackBins: claudeBins } = await import('../server/adapters/claude.js');
  const home = process.env.HOME;
  const mac = process.platform === 'darwin';
  if (mac) {
    assert.ok(codexBins().includes(path.join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex')));
    assert.ok(codexBins().includes('/Applications/Codex.app/Contents/Resources/codex'));
  }
  // The standalone installer's copy comes first: /Applications may hold a real ChatGPT app.
  fakeCli(path.join(home, '.codex', 'packages', 'standalone', 'current', 'bin', 'codex'), 'codex');
  const desktop = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  // Today's layout is <version>/<first 12 of the sha256>/claude; older builds left <version>/claude.
  const claudeExe = mac ? path.join(desktop, '2.1.10', '0a1b2c3d4e5f', 'claude') : path.join(home, '.local', 'bin', 'claude');
  fakeCli(claudeExe, 'claude');
  if (mac) {
    fakeCli(path.join(desktop, '2.1.9', 'claude'), 'claude');
    const order = claudeBins();
    assert.ok(order.includes(claudeExe));
    assert.ok(order.indexOf(claudeExe) < order.indexOf(path.join(desktop, '2.1.9', 'claude')), 'newest version first');
  }

  const agents = await listAgents({ fresh: true });
  for (const id of ['codex', 'claude']) {
    const a = agents.find((x) => x.id === id);
    assert.equal(a.available, true, a.error);
    assert.match(a.version, /9\.9\.9/);
    assert.equal(a.bin, undefined, 'the path stays server-side');
    assert.equal(a.setup, undefined, 'found: no setup tip');
  }
  const events = [];
  const cwd = tmp('install-cwd');
  await adapters.codex.run({ prompt: 'say hi', systemPrompt: '', cwd, mode: 'plan', attachments: [], mcpServers: {}, onEvent: (e) => events.push(e) }).done;
  const result = events.find((e) => e.type === 'result');
  assert.equal(result?.isError, false, result?.text);
  assert.equal(adapters.codex.resumeCommand({ resumeId: 'r1' })[0], path.join(home, '.codex', 'packages', 'standalone', 'current', 'bin', 'codex'));
});
