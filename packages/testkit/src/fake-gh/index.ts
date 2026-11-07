// @wisp/testkit/fake-gh: the fake GitHub CLI (v1 test/fixtures/fake-gh.mjs, unchanged: its state file
// and FAKE_RECORD log are what the v1 tests read), the temp git repos v1's test/helpers.js made, and
// what the git plugins' tests run on: a real proc service and a small plugin bus.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export { nodeProc } from './proc.ts';
export type { RecordedCall } from './proc.ts';
export { Bus, createBus, memoryBlobs } from './bus.ts';
export type { CallOptions, HttpReply } from './bus.ts';
export { fakeRuntime } from './runtime.ts';
export type { FakeRuntime, FakeSession, FakeTurn } from './runtime.ts';

const GH = fileURLToPath(new URL('./gh.mjs', import.meta.url));
export const win = process.platform === 'win32';

export const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `wisp-${prefix}-`));

export interface FakeGh {
  /** the launcher to run as gh (WISP_GH_BIN) */
  bin: string;
  /** the state file the fake reads: { prs, runs, issues, checks, review, mergeable, … } */
  state: string;
  /** the folder each call is logged to (gh.jsonl) */
  record: string;
  /** env for a process that should see this gh */
  env: Record<string, string>;
  read(): Record<string, unknown>;
  write(state: Record<string, unknown>): void;
  calls(): { argv: string[]; cwd: string }[];
}

/** A fake gh in a fresh folder. Also sets process.env (WISP_GH_BIN, FAKE_GH_STATE, FAKE_RECORD). */
export function installFakeGh(): FakeGh {
  const dir = tmp('gh');
  const lib = path.join(dir, 'gh.mjs');
  fs.copyFileSync(GH, lib);
  const bin = path.join(dir, win ? 'gh.cmd' : 'gh');
  if (win) fs.writeFileSync(bin, `@"${process.execPath}" "${lib}" %*\r\n`);
  else {
    // A node launcher, not /bin/sh: sh rewrites $PWD, which would hide PWD bugs.
    const shebang = /\s/.test(process.execPath) ? '/usr/bin/env node' : process.execPath;
    fs.writeFileSync(bin, `#!${shebang}\nimport(${JSON.stringify(pathToFileURL(lib).href)});\n`);
    fs.chmodSync(bin, 0o755);
  }
  const state = path.join(dir, 'state', 'gh.json');
  fs.mkdirSync(path.dirname(state), { recursive: true });
  const record = path.join(dir, 'record');
  const env = { WISP_GH_BIN: bin, FAKE_GH_STATE: state, FAKE_RECORD: record };
  Object.assign(process.env, env);
  return {
    bin,
    state,
    record,
    env,
    read: () => (fs.existsSync(state) ? (JSON.parse(fs.readFileSync(state, 'utf8')) as Record<string, unknown>) : {}),
    write: (s) => fs.writeFileSync(state, JSON.stringify(s, null, 2)),
    calls: () => records(record, 'gh') as { argv: string[]; cwd: string }[],
  };
}

const gitIn = (cwd: string, ...a: string[]): void => void execFileSync('git', a, { cwd, stdio: 'ignore' });

/** A git repo with a committed buggy math.js plus one uncommitted line (v1 makeRepo). */
export function makeRepo(): string {
  const dir = tmp('repo');
  gitIn(dir, 'init', '-q');
  gitIn(dir, 'config', 'core.autocrlf', 'false');
  gitIn(dir, 'config', 'user.email', 'test@example.com');
  gitIn(dir, 'config', 'user.name', 'wisp test');
  fs.writeFileSync(path.join(dir, 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-qm', 'init');
  fs.appendFileSync(path.join(dir, 'math.js'), '// uncommitted\n');
  return dir;
}

export interface Clone {
  dir: string;
  remote: string;
  git(...a: string[]): string;
}

/** A clean repo on `main` with a bare `origin`, as a real clone looks (v1 makeClone). */
export function makeClone(): Clone {
  const remote = tmp('origin');
  const dir = tmp('clone');
  gitIn(remote, 'init', '-q', '--bare', '-b', 'main');
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'config', 'core.autocrlf', 'false');
  gitIn(dir, 'config', 'user.email', 'test@example.com');
  gitIn(dir, 'config', 'user.name', 'wisp test');
  fs.writeFileSync(path.join(dir, 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-qm', 'init');
  gitIn(dir, 'remote', 'add', 'origin', remote);
  gitIn(dir, 'push', '-q', '-u', 'origin', 'main');
  gitIn(dir, 'remote', 'set-head', 'origin', 'main');
  return { dir, remote, git: (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim() };
}

/** A git command in `cwd`, its output trimmed (test setup only: it blocks). */
export const gitOut = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** The JSON lines a fake logged to <dir>/<bin>.jsonl. */
export function records(dir: string, bin: string): unknown[] {
  const f = path.join(dir, `${bin}.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown) : [];
}

export const same = (a: string, b: string): boolean => fs.realpathSync.native(a).toLowerCase() === fs.realpathSync.native(b).toLowerCase();

/** Poll fn until it returns something truthy; errors count as "not yet". */
export async function until<T>(fn: () => T | Promise<T>, { timeout = 20_000, every = 25, what = '' } = {}): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`timed out waiting${what ? ` for ${what}` : ''}${last instanceof Error ? `: ${last.message}` : ''}`);
    await new Promise((r) => setTimeout(r, every));
  }
}
