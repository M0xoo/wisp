// Update check helpers: version comparison, install detection, and the relaunch hand-off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { newer, installMethod } from '../server/update.js';
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
