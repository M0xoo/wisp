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

test('installMethod tells a clone, an npx cache and a global install apart', () => {
  const clone = tmp('upd-clone');
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  assert.equal(installMethod(clone), 'git');
  assert.equal(installMethod(path.join('/home/u/.npm/_npx/abc123/node_modules/wisp-agents')), 'npx');
  assert.equal(installMethod(tmp('upd-global')), 'global');
});

test('maybeCheck hits the registry at most once a day, on the wall clock', async () => {
  let t = 1_000_000;
  let calls = 0;
  const seen = [];
  const fetch = async () => (calls++, { ok: true, json: async () => ({ version: '99.0.0' }) });
  const u = new Updater({ port: 1, fetch, now: () => t, env: {}, onChange: (v) => seen.push(v) });
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
  const u = new Updater({ port: 5123, env: {} });
  for (const method of ['global', 'npx']) {
    u.method = method;
    assert.match(u.relaunchCommand(false), / --browser --no-open --port 5123$/);
    assert.match(u.relaunchCommand(true), /wisp(-agents@latest|\.js") --port 5123$/);
  }
});
