// Installs monoflow for CI and fresh clones (ADR-0001, plan §9.4): the binary at
// .agents/bin/monoflow-bin and, in front of it, .agents/bin/monoflow: the wrapper every agent and CI
// calls. The wrapper refuses the commands that rewrite a shared worktree (checkpoint revert, commit,
// outer, ship, start, sync, push: they deleted other agents' files, docs/v2-team-brief.md) and turns
// off background speculation. It never runs `monoflow init`, so none of what wisp turns off (§9.4.3) gets
// installed: no git shield hooks in .git/hooks, no .agents/bin/git shim, no .claude/settings.json,
// no .opencode/. If any of those are found (an old `monoflow init`), it says so and how to remove them.
//
//   node tools/setup-monoflow.ts            install unless present (the wrapper is always brought up to date)
//   node tools/setup-monoflow.ts --force    reinstall
//   node tools/setup-monoflow.ts --build    build the pinned commit even when a local binary exists
//   node tools/setup-monoflow.ts --check    report only (exit 1 when missing)
//
// Source, in order: $MONOFLOW_BIN (a built binary), ~/Downloads/monoflow/bin/monoflow (a local
// checkout), else a build of https://github.com/M0xoo/monoflow at the pinned commit (needs git and go).

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const MONOFLOW_REPO = 'https://github.com/M0xoo/monoflow';
/** 8c6bc74, plan §9.4: bump it here (and in the CI cache key, which reads this file) to upgrade. */
export const MONOFLOW_COMMIT = '2a86d14ccce24eb7dc975c559e30076034c1aaf1';

const ROOT = join(import.meta.dirname, '..');
const EXE = process.platform === 'win32' ? 'monoflow-bin.exe' : 'monoflow-bin';
/** the binary */
export const DEST = join('.agents', 'bin', EXE);
/** what everyone runs */
export const WRAPPER = join('.agents', 'bin', 'monoflow');

/** The wrapper, byte for byte the one in the repo's shared worktrees. */
export const WRAPPER_SCRIPT = `#!/bin/sh
# wisp's shared worktrees: several agents edit one tree at once. Refuse every monoflow command that
# rewrites the working tree (they deleted other agents' files), and turn off background speculation.
case "$1 $2" in
  "checkpoint revert"*|"commit "*|"outer "*|"ship "*|"start "*|"sync "*|"push "*)
    echo "monoflow $1 $2: refused in this shared worktree (docs/v2-team-brief.md). Use graph, verify, checkpoint save." >&2
    exit 2 ;;
esac
export MONOFLOW_NO_SPECULATE=1 MONOFLOW_NO_ROOT_SPECULATE=1
exec "$(dirname "$0")/monoflow-bin" "$@"
`;

/** Writes the wrapper when it is missing or differs; true when it wrote. */
export function writeWrapper(root: string): boolean {
  const at = join(root, WRAPPER);
  if (existsSync(at) && readFileSync(at, 'utf8') === WRAPPER_SCRIPT) return false;
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(at, WRAPPER_SCRIPT);
  chmodSync(at, 0o755);
  return true;
}

function sh(cmd: string, args: readonly string[], cwd?: string): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`.trim() };
}

function say(msg: string): void {
  process.stdout.write(`setup-monoflow: ${msg}\n`);
}

/** What `monoflow init` would have left behind, relative to the repo. */
export function strays(root: string): string[] {
  const out: string[] = [];
  if (existsSync(join(root, '.agents/bin/git'))) out.push('.agents/bin/git (the git shim)');
  if (existsSync(join(root, '.opencode'))) out.push('.opencode/');
  const settings = join(root, '.claude/settings.json');
  if (existsSync(settings) && /monoflow/.test(readFileSync(settings, 'utf8'))) out.push('.claude/settings.json (monoflow hooks)');
  const hooks = sh('git', ['rev-parse', '--git-path', 'hooks'], root);
  const dir = hooks.ok ? join(root, hooks.out) : '';
  if (dir && existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (!f.endsWith('.sample') && /monoflow/i.test(readFileSync(p, 'utf8'))) out.push(`${join(hooks.out, f)} (a git shield hook)`);
    }
  }
  return out;
}

function fromLocal(dest: string): string | undefined {
  const candidates = [process.env['MONOFLOW_BIN'], join(homedir(), 'Downloads', 'monoflow', 'bin', process.platform === 'win32' ? 'monoflow.exe' : 'monoflow')].filter((p): p is string => !!p);
  const src = candidates.find((p) => existsSync(p));
  if (!src) return undefined;
  copyFileSync(src, dest);
  const checkout = dirname(dirname(src));
  const head = sh('git', ['-C', checkout, 'rev-parse', 'HEAD']);
  const note = head.ok ? (head.out === MONOFLOW_COMMIT ? ' (at the pinned commit)' : ` (its checkout is at ${head.out.slice(0, 7)}, the pin is ${MONOFLOW_COMMIT.slice(0, 7)})`) : '';
  return `copied ${src}${note}`;
}

function build(dest: string): string {
  for (const tool of ['git', 'go']) if (!sh(tool, ['version']).ok) throw new Error(`${tool} is not installed: install it, or set MONOFLOW_BIN to a built binary`);
  const tmp = mkdtempSync(join(tmpdir(), 'monoflow-src-'));
  try {
    // a blobless clone, then the one commit: the history isn't needed
    const steps: [string, string[]][] = [
      ['git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', MONOFLOW_REPO, tmp]],
      ['git', ['-C', tmp, 'checkout', '--quiet', MONOFLOW_COMMIT]],
      ['go', ['build', '-trimpath', '-ldflags=-s -w', '-o', dest, './cmd/monoflow']],
    ];
    for (const [cmd, args] of steps) {
      const r = sh(cmd, args, tmp);
      if (!r.ok) throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} failed:\n${r.out}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return `built ${MONOFLOW_REPO}@${MONOFLOW_COMMIT.slice(0, 7)}`;
}

export function install(root: string, opts: { force: boolean; build?: boolean }): string {
  const dest = join(root, DEST);
  const wrote = writeWrapper(root) ? `; wrote ${WRAPPER}` : '';
  if (existsSync(dest) && !opts.force) return `${DEST} is already installed (--force reinstalls)${wrote}`;
  mkdirSync(dirname(dest), { recursive: true });
  const how = (opts.build ? undefined : fromLocal(dest)) ?? build(dest);
  chmodSync(dest, 0o755);
  const run = sh(dest, ['help']);
  if (!run.ok) throw new Error(`${DEST} doesn't run: ${run.out.split('\n')[0] ?? ''}`);
  return `${how} → ${DEST}${wrote}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--check')) {
      const ok = existsSync(join(ROOT, DEST)) && existsSync(join(ROOT, WRAPPER)) && readFileSync(join(ROOT, WRAPPER), 'utf8') === WRAPPER_SCRIPT;
      say(ok ? `${DEST} and its wrapper ${WRAPPER} are installed` : `${DEST} or the ${WRAPPER} wrapper is missing or stale: run node tools/setup-monoflow.ts`);
      process.exitCode = ok ? 0 : 1;
    } else say(install(ROOT, { force: args.includes('--force'), build: args.includes('--build') }));
    const left = strays(ROOT);
    if (left.length) say(`found what \`monoflow init\` installs and wisp turns off (plan §9.4.3); remove it:\n  ${left.join('\n  ')}`);
  } catch (e) {
    say(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
