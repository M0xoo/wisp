#!/usr/bin/env node
// The `wisp` command: finds the platform binary npm installed next to this package and runs it.
// Dependency-free on purpose: this is all that runs before the Rust binary takes over.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { childEnv, locate } from '../lib/resolve.js';

const require = createRequire(import.meta.url);
const webDir = fileURLToPath(new URL('../web', import.meta.url));

const found = locate({ platform: process.platform, arch: process.arch, env: process.env, resolvePkg: (id) => require.resolve(id) });
if (found.error) {
  process.stderr.write(`${found.error}\n`);
  process.exit(1);
}

const child = spawn(found.bin, process.argv.slice(2), {
  stdio: 'inherit',
  env: childEnv(process.env, webDir, existsSync(webDir)),
});

// Handling these keeps the launcher alive until the child exits, so the shell sees the child's
// status rather than ours. Ctrl-C reaches the child from the terminal too; forwarding covers
// `kill <launcher pid>` and supervisors that signal only the pid they started.
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const forward = (sig) => {
  if (child.exitCode === null && child.signalCode === null) child.kill(sig);
};
for (const sig of SIGNALS) process.on(sig, forward);

child.on('error', (err) => {
  const hint = err.code === 'ENOENT' ? 'it does not exist' : err.code === 'EACCES' ? 'it is not executable' : err.message;
  process.stderr.write(`wisp: could not run ${found.bin}: ${hint}.\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    // Die of the same signal so callers (shells, CI) see exactly what the child saw.
    for (const sig of SIGNALS) process.off(sig, forward);
    process.exitCode = 128 + (constants.signals[signal] ?? 0); // the shell convention, if we survive it
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
