// A new worktree is a fresh checkout: what git ignores (.env, local config, a built cache) isn't in
// it, and some repos need a step before an agent can work there. So, as Claude Code, Cursor and
// Conductor do, wisp brings both along:
//
//   .worktreeinclude          gitignore-style lines: the ignored files and folders to copy over
//                             (without one: the repo root's .env files)
//   .wisp/worktree.json       { "setup": "npm ci" | ["npm ci", "…"] } run in the new worktree, and
//                             { "run": "npm run dev", "port": 5173 } the app, for the panel's Preview
//   .cursor/worktrees.json    { "setup-worktree": [...] } the same, for a repo set up for Cursor
//   .conductor/settings.toml  scripts.setup and scripts.run (or conductor.json), for one set up for
//                             Conductor (server/conductor.js), with Conductor's env vars
//
// The first of those files with a setup is the setup; own run, then Conductor's, is the app.
// Setup runs with ROOT_WORKTREE_PATH set to the checkout it came from (Cursor's name for it).

import fs from 'node:fs';
import path from 'node:path';
import { conductorEnv, conductorScripts, isConductorFile } from './conductor.js';
import { gitBin } from './git.js';
import { execFile } from './proc.js';
import { taskPort } from './runs.js';

const SETUP_TIMEOUT = 10 * 60_000;
const DEFAULT_INCLUDE = ['.env', '.env.*'];

const run = (bin, args, opts) =>
  new Promise((resolve, reject) => execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr || '') })) : resolve(String(stdout)))));

// A gitignore-style pattern as a test on a path relative to the root ("a/b.txt", "dir/").
export function matcher(line) {
  let p = line.trim();
  if (!p || p.startsWith('#') || p.startsWith('!')) return null;
  const dirOnly = p.endsWith('/');
  p = p.replace(/\/+$/, '');
  const anchored = p.includes('/');
  p = p.replace(/^\//, '');
  const re = p
    .split('/')
    .map((seg) => (seg === '**' ? '(?:.*/)?' : `${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}/`))
    .join('')
    .replace(/\/$/, '')
    .replace(/\(\?:\.\*\/\)\?\//g, '(?:.*/)?');
  const full = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}(?:/.*)?$`);
  return (rel, isDir) => (dirOnly ? isDir || rel.includes('/') : true) && full.test(rel.replace(/\/$/, ''));
}

// The ignored files and folders of root that .worktreeinclude (or the default) names.
export async function includedPaths(root) {
  let lines = DEFAULT_INCLUDE;
  try {
    lines = fs.readFileSync(path.join(root, '.worktreeinclude'), 'utf8').split(/\r?\n/);
  } catch {}
  const tests = lines.map(matcher).filter(Boolean);
  if (!tests.length) return [];
  // --directory: an ignored folder is one entry (node_modules/), not its thousands of files
  const out = await run(gitBin(), ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: root, timeout: 30_000 }).catch(() => '');
  return out.split('\0').filter(Boolean).filter((rel) => tests.some((t) => t(rel, rel.endsWith('/'))));
}

// The setup a new worktree of root runs, and the one place that decides it (the trust card lists
// the same): { file, commands, problem? }. Cursor stays ahead of Conductor: a repo that works keeps
// what it runs, and isn't asked again.
export function repoSetup(root) {
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
    } catch {
      return null;
    }
  };
  const steps = (list) => (Array.isArray(list) ? list : [list]).filter((c) => typeof c === 'string' && c.trim());
  const own = read('.wisp/worktree.json')?.setup;
  if (own != null) return { file: '.wisp/worktree.json', commands: steps(own) };
  const cursor = read('.cursor/worktrees.json')?.['setup-worktree'];
  if (cursor != null) return { file: '.cursor/worktrees.json', commands: steps(cursor) };
  const c = conductorScripts(root);
  if (!c) return { file: null, commands: [] };
  return { file: c.file, commands: c.setup ? [c.setup] : [], ...(c.problem && { problem: c.problem }) };
}

export const setupCommands = (root) => repoSetup(root).commands;

// What a setup from `file` is told besides ROOT_WORKTREE_PATH. The port is the one a Run of this
// workspace asks for first (routes/workspace.js), so a .env that setup writes it to stays right.
export function setupEnv(file, { root, dir, branch }) {
  return isConductorFile(file) ? conductorEnv({ root, dir, branch, port: taskPort(path.basename(dir)) }) : {};
}

// How to run the app from a folder (the side panel's Preview, server/runs.js): .wisp/worktree.json's
// { "run": "npm run dev", "port": 5173 } in dir, else the Conductor run script of the checkout `top`
// (with the folder to start in, and problem with no command when its file can't be read: a guess
// wouldn't be what the repo asked for), else a guess from package.json (scripts.dev, then
// scripts.start), marked as one. null: nothing to go on.
export function runCommand(dir, top = dir) {
  let own = null;
  try {
    own = JSON.parse(fs.readFileSync(path.join(dir, '.wisp/worktree.json'), 'utf8'));
  } catch {}
  const port = Number.isInteger(own?.port) && own.port > 0 && own.port < 65536 ? own.port : null;
  if (typeof own?.run === 'string' && own.run.trim()) return { command: own.run.trim(), port, source: 'config' };
  const c = conductorScripts(top);
  if (c?.problem) return { command: null, port, source: 'conductor', file: c.file, problem: c.problem };
  if (c?.run) return { command: c.run.command, port, source: 'conductor', file: c.file, cwd: c.run.cwd ? path.resolve(top, c.run.cwd) : top };
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {}
  const s = pkg?.scripts || {};
  if (typeof s.dev === 'string') return { command: 'npm run dev', port, source: 'package.json' };
  if (typeof s.start === 'string') return { command: 'npm start', port, source: 'package.json' };
  return null;
}

// Copy, then set up. Never throws: a worktree that couldn't be prepared still works, and what went
// wrong is returned (the task says so) rather than stopping the launch.
// hold: the setup steps the repo isn't trusted for (server/project-trust.js): they don't run now but
// wait in `held` for Trust and start (runSetup) or Run without them.
export async function prepareWorktree(root, dir, { hold = null, branch = null } = {}) {
  const { copied, problems, cloned } = await copyIncluded(root, dir);
  const { file, commands, problem } = repoSetup(root);
  if (problem) problems.push(problem);
  const shared = cloned ? { cloned } : {};
  if (hold?.length) return { copied, ran: [], problems, held: hold, ...shared };
  const setup = await runSetup(root, dir, commands, setupEnv(file, { root, dir, branch }));
  return { copied, ran: setup.ran, problems: [...problems, ...setup.problems], ...shared };
}

// The ignored files .worktreeinclude names, from the checkout into dir. Never throws. cloned: the
// bytes that share the checkout's blocks rather than take new ones (Settings → This Mac says so).
export async function copyIncluded(root, dir, opts) {
  const copied = [];
  const problems = [];
  let cloned = 0;
  for (const rel of await includedPaths(root)) {
    const from = path.join(root, rel).replace(/[\\/]+$/, ''); // `cp -R dir/` would copy what's in it
    const to = path.join(dir, rel).replace(/[\\/]+$/, '');
    if (fs.existsSync(to)) continue;
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (await cloneOrCopy(from, to, opts)) cloned += await diskBytes(from);
      copied.push(rel.replace(/\/$/, ''));
    } catch (err) {
      problems.push(`couldn't copy ${rel}: ${err.message}`);
    }
  }
  return { copied, problems, cloned };
}

// Copy-on-write where the file system has it: the copy shares the checkout's blocks until one side
// writes, so a node_modules costs next to no disk (time is about the same: 100k files are metadata
// either way), and cp runs beside the server where cpSync stopped it. Node's
// COPYFILE_FICLONE doesn't do it on macOS (libuv writes the bytes: measured on Node 20, 22 and 25),
// so it's the system's cp: `cp -c` (clonefile) on APFS, which falls back to copying by itself, and
// `--reflink=always` on Linux (btrfs, XFS, bcachefs), which fails where there's none and then gets
// a plain copy, as Windows (and a cp without the flag, BusyBox's) does. true: the blocks are shared.
export async function cloneOrCopy(from, to, { platform = process.platform, cp = 'cp' } = {}) {
  const viaCp = async (args) => {
    try {
      await run(cp, [...args, from, to], { timeout: SETUP_TIMEOUT });
      return true;
    } catch {
      fs.rmSync(to, { recursive: true, force: true }); // what it got through before it gave up
      return false;
    }
  };
  if (platform === 'darwin' && (await viaCp(['-c', '-R']))) return sameApfs(from, path.dirname(to));
  if (platform === 'linux' && (await viaCp(['-R', '--reflink=always']))) return true;
  fs.cpSync(from, to, { recursive: true, errorOnExist: false, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
  return false;
}

// cp -c clones only within one APFS volume and copies quietly otherwise. The system volume is APFS
// on every macOS wisp runs on, so its file system type stands for APFS (an HFS+ or exFAT disk differs).
function sameApfs(a, b) {
  try {
    return fs.lstatSync(a).dev === fs.statSync(b).dev && fs.statfsSync(b).type === fs.statfsSync('/').type;
  } catch {
    return false;
  }
}

// The disk a file or tree takes, each inode once (pnpm's hard links), symlinks not followed. Async:
// a big node_modules is 100k files, and the server shouldn't stop for them.
async function diskBytes(p, seen = new Set()) {
  const st = await fs.promises.lstat(p).catch(() => null);
  if (st?.isDirectory()) {
    const names = await fs.promises.readdir(p).catch(() => []);
    let total = 0;
    for (let i = 0; i < names.length; i += 64) total += (await Promise.all(names.slice(i, i + 64).map((n) => diskBytes(path.join(p, n), seen)))).reduce((a, b) => a + b, 0);
    return total;
  }
  if (!st?.isFile() || seen.has(st.ino)) return 0;
  seen.add(st.ino);
  return st.blocks != null ? st.blocks * 512 : st.size;
}

// A step can be a whole script: a problem names its first line.
const firstLine = (cmd) => {
  const [first, ...more] = cmd.trim().split(/\r?\n/);
  return more.length ? `${first}…` : first;
};

// The setup steps, in order, in the new worktree dir; stops at the first that fails.
export async function runSetup(root, dir, commands, env = {}) {
  const ran = [];
  const problems = [];
  const shell = process.platform === 'win32' ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c']] : [process.env.SHELL || '/bin/sh', ['-c']];
  for (const cmd of commands) {
    try {
      await run(shell[0], [...shell[1], cmd], { cwd: dir, timeout: SETUP_TIMEOUT, env: { ...process.env, ROOT_WORKTREE_PATH: root, ...env } });
      ran.push(cmd);
    } catch (err) {
      problems.push(`setup \`${firstLine(cmd)}\` failed: ${(err.stderr || err.message).trim().split('\n').slice(-3).join(' ')}`);
      break; // the next step likely needs this one
    }
  }
  return { ran, problems };
}
