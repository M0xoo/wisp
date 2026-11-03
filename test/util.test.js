// server/util.js: small helpers shared across the server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.js';
import { writeJsonAtomic } from '../server/util.js';

// On Windows a rename over a file that something else holds open (a reader, antivirus, the search
// indexer) fails with EPERM for a moment; the write waits it out instead of failing the request.
test('writeJsonAtomic waits out a file held open for a moment, and still fails on a lasting error', () => {
  const file = path.join(tmp('util-atomic'), 'config.json');
  const real = fs.renameSync;
  let calls = 0;
  fs.renameSync = (...a) => {
    if (++calls <= 2) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    return real(...a);
  };
  try {
    writeJsonAtomic(file, { a: 1 });
  } finally {
    fs.renameSync = real;
  }
  assert.equal(calls, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });

  fs.renameSync = () => {
    throw Object.assign(new Error('ENOENT: no such file or directory, rename'), { code: 'ENOENT' });
  };
  try {
    assert.throws(() => writeJsonAtomic(file, { a: 2 }), /ENOENT/);
  } finally {
    fs.renameSync = real;
  }
});
