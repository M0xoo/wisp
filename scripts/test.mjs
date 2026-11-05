#!/usr/bin/env node
// `npm test`: every test/*.test.js through node --test, so a new test file needs no listing and
// two PRs that add one don't conflict. Found here because Node 20's --test has no glob and npm's
// shell on Windows doesn't expand one. Bare `node --test` won't do either: it also runs
// test/helpers.js and test/real-clis.mjs (signed-in CLIs, `npm run test:real`).
//   npm test
//   npm test -- --test-reporter=tap     # flags go before the files, as Node 20 needs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// Forward slashes on every OS: Node 22 reads these as globs, where a backslash escapes.
const files = fs.readdirSync(new URL('../test/', import.meta.url)).filter((f) => f.endsWith('.test.js')).sort().map((f) => `test/${f}`);
// With no files node --test would pick its own, helpers and real CLIs included.
if (!files.length) {
  console.error('no test/*.test.js found');
  process.exit(1);
}

const run = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' });
// Stopped from outside (a cancelled job) goes on to the runner, or it'd be left running.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    run.kill(signal);
  });
}
run.on('exit', (code, signal) => {
  process.exit(code ?? 128 + os.constants.signals[signal]);
});
