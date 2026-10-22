// Shared test scaffolding: temp git repos and fake harness CLIs installed on PATH the way each
// platform really installs them (an executable launcher on Unix, an npm `.cmd` shim on Windows).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.WISP_TELEMETRY = '0'; // tests never report to PostHog
process.env.WISP_FEEDBACK = '0';

const FAKE = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
export const BINS = ['claude', 'codex', 'opencode', 'cursor-agent', 'agy', 'grok', 'copilot'];
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
  // The harnesses, plus a fake GitHub CLI (`gh`) for Ship it and the GitHub triggers.
  for (const bin of [...BINS, 'gh']) {
    fs.copyFileSync(bin === 'gh' ? FAKE_GH : FAKE, path.join(lib, `${bin}.mjs`));
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

// Poll fn until it returns something truthy. Errors count as "not yet" (a polled local HTTP
// request can be reset under load, notably on Windows CI); the last one is reported on timeout.
export async function until(fn, { timeout = 20_000, every = 50, what = '' } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`timed out waiting${what ? ` for ${what}` : ''}${last ? `: ${last.cause?.code || last.message}` : ''}`);
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

// A clean repo on `main` with a bare `origin`, as a real clone looks: worktrees branch from
// origin/main, Ship it pushes there, and merging fast-forwards the checkout.
export function makeClone() {
  const remote = tmp('origin');
  const dir = tmp('clone');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'wisp test');
  fs.writeFileSync(path.join(dir, 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  git(dir, 'remote', 'set-head', 'origin', 'main');
  return { dir, remote, git: (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim() };
}

// --- for the grid tests ----------------------------------------------------------------------

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tiny browser: *.localhost goes to 127.0.0.1, cookies per host, no redirect following.
export function browser() {
  const jar = new Map(); // host -> Map(name -> value)
  async function go(url, { method = 'GET', headers = {}, body, form } = {}) {
    const u = new URL(url);
    const c = jar.get(u.host);
    const data = form ? new URLSearchParams(form).toString() : body !== undefined ? JSON.stringify(body) : undefined;
    const h = {
      accept: 'text/html',
      ...(c && c.size && { cookie: [...c].map(([k, v]) => `${k}=${v}`).join('; ') }),
      ...(form && { 'content-type': 'application/x-www-form-urlencoded' }),
      ...(body !== undefined && { 'content-type': 'application/json', accept: 'application/json' }),
      ...headers,
    };
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method, headers: { host: u.host, ...h } }, (res) => {
        for (const sc of [].concat(res.headers['set-cookie'] || [])) {
          const [kv, ...attrs] = sc.split(';');
          const i = kv.indexOf('=');
          const name = kv.slice(0, i).trim();
          const val = kv.slice(i + 1).trim();
          if (!jar.has(u.host)) jar.set(u.host, new Map());
          if (attrs.some((a) => /max-age=0/i.test(a))) jar.get(u.host).delete(name);
          else jar.get(u.host).set(name, val);
        }
        let t = '';
        res.on('data', (d) => (t += d));
        res.on('end', () => {
          let j = null;
          try {
            j = JSON.parse(t);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text: t, json: j, location: res.headers.location });
        });
      });
      req.on('error', reject);
      req.end(data);
    });
  }
  // Follow redirects (absolute or relative), like a browser does.
  async function follow(url, opts = {}, hops = 8) {
    let r = await go(url, opts);
    let at = url;
    while (r.status >= 300 && r.status < 400 && r.location && hops--) {
      at = new URL(r.location, at).toString();
      if (!at.startsWith('http://')) return { ...r, at };
      r = await go(at);
    }
    return { ...r, at };
  }
  return { go, follow, jar };
}
