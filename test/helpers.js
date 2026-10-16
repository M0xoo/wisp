// Shared test scaffolding: temp git repos and fake harness CLIs installed on PATH the way each
// platform really installs them (an executable launcher on Unix, an npm `.cmd` shim on Windows).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FAKE = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
export const BINS = ['claude', 'codex', 'opencode', 'cursor-agent'];
export const win = process.platform === 'win32';

export const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `wisp-${prefix}-`));

// The exact template npm's cmd-shim writes for a node script (npm 10).
export const npmCmdShim = (rel) => `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel.replace(/\//g, '\\')}" %*\r
`;

// Install the fake CLIs into a fresh dir and put it first on PATH. Returns the dir.
export function installFakeBins() {
  const dir = tmp('bin');
  const lib = path.join(dir, 'node_modules', 'fake');
  fs.mkdirSync(lib, { recursive: true });
  for (const bin of BINS) {
    fs.copyFileSync(FAKE, path.join(lib, `${bin}.mjs`));
    if (win) {
      fs.writeFileSync(path.join(dir, `${bin}.cmd`), npmCmdShim(`node_modules/fake/${bin}.mjs`));
    } else {
      // A node launcher, not /bin/sh: sh rewrites $PWD, which would hide PWD bugs.
      const exe = path.join(dir, bin);
      const shebang = /\s/.test(process.execPath) ? '/usr/bin/env node' : process.execPath;
      fs.writeFileSync(exe, `#!${shebang}\nimport(${JSON.stringify(pathToFileURL(path.join(lib, `${bin}.mjs`)).href)});\n`);
      fs.chmodSync(exe, 0o755);
    }
  }
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
  return dir;
}

// A git repo with a committed buggy math.js plus one uncommitted line, so diffs must come from
// the working tree as it was when the turn started, not from HEAD.
export function makeRepo() {
  const dir = tmp('repo');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'wisp test');
  fs.writeFileSync(path.join(dir, 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  fs.appendFileSync(path.join(dir, 'math.js'), '// uncommitted\n');
  return dir;
}

export function records(dir, bin) {
  const f = path.join(dir, `${bin}.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

export const same = (a, b) => fs.realpathSync.native(a).toLowerCase() === fs.realpathSync.native(b).toLowerCase();

export async function until(fn, { timeout = 20_000, every = 50 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, every));
  }
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
