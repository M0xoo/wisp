// The desktop app reads PATH from the login shell before its first window (desktop/shell-path.js).
// A shell that hangs must not keep the window from opening: an interactive zsh ignores SIGTERM,
// so execFile's own timeout never ended it (DESK-14 waited forever on a Mac with a slow ~/.zshrc).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.js';

const { readShellPath } = await import('../desktop/shell-path.js');

const shell = (name, body) => {
  const f = path.join(tmp('shell-path'), name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return f;
};

test('the login shell’s PATH is read from its output', { skip: process.platform === 'win32' }, async () => {
  // Called as `sh -ilc '<printf>'`: run the command it was given, like a shell would.
  const sh = shell('ok', 'PATH="/opt/x/bin:$PATH"; shift; eval "$1"');
  assert.match(await readShellPath(sh, 5000), /^\/opt\/x\/bin:/);
});

test('a shell that ignores SIGTERM gives up on time', { skip: process.platform === 'win32' }, async () => {
  const sh = shell('deaf', "trap '' TERM; while :; do sleep 1; done");
  const t0 = Date.now();
  assert.equal(await readShellPath(sh, 300), '');
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

test('a shell that asks on stdin reads end-of-file instead of waiting', { skip: process.platform === 'win32' }, async () => {
  const sh = shell('asks', 'read answer; PATH="/asked:$PATH"; shift; eval "$1"');
  assert.match(await readShellPath(sh, 5000), /^\/asked:/);
});
