// Update check helpers: version comparison, install detection, and the relaunch hand-off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { newer, installMethod, Updater } from '../server/update.js';
import { tmp } from './helpers.js';

test('newer compares major.minor.patch numerically and ignores prerelease tags', () => {
  assert.equal(newer('0.7.0', '0.6.0'), true);
  assert.equal(newer('0.10.0', '0.9.9'), true);
  assert.equal(newer('1.0.0', '0.99.99'), true);
  assert.equal(newer('0.6.0', '0.6.0'), false);
  assert.equal(newer('0.5.9', '0.6.0'), false);
  assert.equal(newer('v0.6.1', '0.6.0'), true);
  assert.equal(newer('0.6.0-beta.1', '0.6.0'), false);
});

const KEG = (prefix) => path.join(prefix, 'Cellar/wisp-agents/0.15.0/libexec/lib/node_modules/wisp-agents');

test('installMethod tells a clone, an npx cache, a Homebrew keg and a global install apart', () => {
  const clone = tmp('upd-clone');
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  assert.equal(installMethod(clone), 'git');
  assert.equal(installMethod(path.join('/home/u/.npm/_npx/abc123/node_modules/wisp-agents')), 'npx');
  assert.equal(installMethod(KEG('/opt/homebrew')), 'brew');
  assert.equal(installMethod(KEG('/home/linuxbrew/.linuxbrew')), 'brew');
  assert.equal(installMethod(tmp('upd-global')), 'global');
});

test('a git clone never offers an update, even when npm has a newer one', async () => {
  const clone = tmp('upd-clone');
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  const fetch = async () => ({ ok: true, json: async () => ({ version: '99.0.0' }) });
  const u = new Updater({ port: 1, fetch, env: {}, root: clone });
  assert.equal(u.enabled, false);
  const v = await u.check();
  assert.equal(v.available, false);
  assert.equal(v.command, undefined);
  await assert.rejects(u.install(), { status: 400 });
});

test('maybeCheck hits the registry at most once a day, on the wall clock', async () => {
  let t = 1_000_000;
  let calls = 0;
  const seen = [];
  const fetch = async () => (calls++, { ok: true, json: async () => ({ version: '99.0.0' }) });
  const u = new Updater({ port: 1, fetch, now: () => t, env: {}, root: tmp('upd-global'), onChange: (v) => seen.push(v) });
  u.maybeCheck();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  assert.equal(seen.at(-1).available, true);
  assert.equal(seen.at(-1).latest, '99.0.0');
  t += 23 * 3600_000;
  u.maybeCheck();
  assert.equal(calls, 1);
  t += 3600_000;
  u.maybeCheck();
  assert.equal(calls, 2);
});

test('relaunchCommand keeps the port wisp is serving on', () => {
  const u = new Updater({ port: 5123, env: {}, root: tmp('upd-global') });
  for (const method of ['global', 'npx']) {
    u.method = method;
    assert.match(u.relaunchCommand(false), / --browser --no-open --port 5123$/);
    assert.match(u.relaunchCommand(true), /wisp(-agents@latest|\.js") --port 5123$/);
  }
});

test('Homebrew installs upgrade through brew and relaunch from the opt/ link, not the old keg', () => {
  const u = new Updater({ port: 5123, env: {}, root: KEG('/opt/homebrew') });
  assert.equal(u.method, 'brew');
  assert.equal(u.command(), `${JSON.stringify(path.join('/opt/homebrew', 'bin', 'brew'))} upgrade m0xoo/tap/wisp-agents`);
  const wisp = path.join('/opt/homebrew', 'opt/wisp-agents/libexec/lib/node_modules/wisp-agents', 'bin', 'wisp.js');
  assert.ok(u.relaunchCommand(false).endsWith(`${JSON.stringify(wisp)} --browser --no-open --port 5123`));
});

test('install refuses to relaunch when the install left this copy on the same version', async () => {
  const current = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const brew = tmp('upd-brew');
  const opt = path.join(brew, 'opt/wisp-agents/libexec/lib/node_modules/wisp-agents');
  fs.mkdirSync(opt, { recursive: true });
  fs.writeFileSync(path.join(opt, 'package.json'), JSON.stringify({ version: current })); // the tap hasn't caught up
  const global = tmp('upd-global');
  fs.writeFileSync(path.join(global, 'package.json'), JSON.stringify({ version: current })); // npm put it elsewhere
  for (const [root, why] of [
    [KEG(brew), /Homebrew doesn't have wisp 99\.0\.0 yet/],
    [global, /npm installed wisp somewhere else/],
  ]) {
    const u = new Updater({ port: 1, env: {}, root });
    u.state.latest = '99.0.0';
    u.command = () => 'exit 0';
    await assert.rejects(u.install(), why);
    assert.equal(u.state.status, 'idle');
    assert.match(u.state.error, why);
  }
});
