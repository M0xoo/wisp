// A new worktree is a fresh checkout: what git ignores (.env, local config, a built cache) isn't in
// it, and some repos need a step before an agent can work there. So, as Claude Code, Cursor and
// Conductor do, wisp brings both along:
//
//   .worktreeinclude          gitignore-style lines: the ignored files and folders to copy over
//                             (without one: the repo root's .env files)
//   .wisp/worktree.json       { "setup": "npm ci" | ["npm ci", "…"] } run in the new worktree, and
//                             { "run": "npm run dev", "port": 5173 } the app, for the panel's Preview
//   .cursor/worktrees.json    { "setup-worktree": [...] } the same, for a repo set up for Cursor
//
// Setup runs with ROOT_WORKTREE_PATH set to the checkout it came from (Cursor's name for it).

import fs from 'node:fs';
import path from 'node:path';
import { gitBin } from './git.js';
import { execFile } from './proc.js';

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

export function setupCommands(root) {
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
    } catch {
      return null;
    }
  };
  const own = read('.wisp/worktree.json')?.setup;
  const cursor = read('.cursor/worktrees.json')?.['setup-worktree'];
  const list = own ?? cursor ?? [];
  return (Array.isArray(list) ? list : [list]).filter((c) => typeof c === 'string' && c.trim());
}

// How to run the app from a folder (the side panel's Preview, server/runs.js): .wisp/worktree.json's
// { "run": "npm run dev", "port": 5173 }, else a guess from package.json (scripts.dev, then
// scripts.start), marked as one. null: nothing to go on.
export function runCommand(root) {
  let own = null;
  try {
    own = JSON.parse(fs.readFileSync(path.join(root, '.wisp/worktree.json'), 'utf8'));
  } catch {}
  const port = Number.isInteger(own?.port) && own.port > 0 && own.port < 65536 ? own.port : null;
  if (typeof own?.run === 'string' && own.run.trim()) return { command: own.run.trim(), port, source: 'config' };
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
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
export async function prepareWorktree(root, dir, { hold = null } = {}) {
  const copied = [];
  const problems = [];
  for (const rel of await includedPaths(root)) {
    const from = path.join(root, rel);
    const to = path.join(dir, rel);
    if (fs.existsSync(to)) continue;
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true, errorOnExist: false, verbatimSymlinks: true });
      copied.push(rel.replace(/\/$/, ''));
    } catch (err) {
      problems.push(`couldn't copy ${rel}: ${err.message}`);
    }
  }
  if (hold?.length) return { copied, ran: [], problems, held: hold };
  const setup = await runSetup(root, dir, setupCommands(root));
  return { copied, ran: setup.ran, problems: [...problems, ...setup.problems] };
}

// The setup steps, in order, in the new worktree dir; stops at the first that fails.
export async function runSetup(root, dir, commands) {
  const ran = [];
  const problems = [];
  const shell = process.platform === 'win32' ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c']] : [process.env.SHELL || '/bin/sh', ['-c']];
  for (const cmd of commands) {
    try {
      await run(shell[0], [...shell[1], cmd], { cwd: dir, timeout: SETUP_TIMEOUT, env: { ...process.env, ROOT_WORKTREE_PATH: root } });
      ran.push(cmd);
    } catch (err) {
      problems.push(`setup \`${cmd}\` failed: ${(err.stderr || err.message).trim().split('\n').slice(-3).join(' ')}`);
      break; // the next step likely needs this one
    }
  }
  return { ran, problems };
}
