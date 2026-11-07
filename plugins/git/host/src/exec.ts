// Running git and gh through the kernel's proc service. Nothing here blocks: the binary is found once,
// asynchronously, and every call is proc.exec (or proc.spawn for output streamed as it comes).

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExecResult, ProcService } from '@wisp/kernel';

// Never wait on a credential or confirmation prompt nobody can see. No optional locks: a `git status`
// polled for a card would otherwise take index.lock to refresh the index, and Ship it's `git add` in
// the same worktree fails with "index.lock: File exists".
export const QUIET_ENV: Readonly<Record<string, string>> = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_EDITOR: 'true', GIT_OPTIONAL_LOCKS: '0' };

export interface RunOptions {
  cwd?: string | undefined;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  input?: string;
  /** keep stdout as git wrote it (patches end on a blank context line) */
  raw?: boolean;
}

/** A failed git or gh: the line that says why, the exit code, and what it printed. */
export class ToolError extends Error {
  readonly exit: number | null;
  readonly stdout: string;
  readonly missing: boolean;
  constructor(why: string, exit: number | null, stdout: string, missing = false) {
    super(why);
    this.name = 'ToolError';
    this.exit = exit;
    this.stdout = stdout;
    this.missing = missing;
  }
}

// git and gh lead with "fatal:" / "error:"; otherwise the tail is the useful part.
export function whyOf(stderr: string, fallback: string): string {
  const lines = stderr.trim().split('\n').filter(Boolean);
  return lines.find((l) => /^(fatal|error)\b/i.test(l)) ?? (lines.slice(-3).join(' ') || fallback);
}

export interface Tools {
  readonly proc: ProcService;
  git(cwd: string | undefined, args: readonly string[], opts?: RunOptions): Promise<string>;
  gh(cwd: string | undefined, args: readonly string[], opts?: RunOptions): Promise<string>;
  /** the raw result: callers that read exit codes (merge-tree, diff --quiet) */
  gitResult(cwd: string | undefined, args: readonly string[], opts?: RunOptions): Promise<ExecResult>;
  gitBin(): Promise<string>;
  ghBin(): string;
}

export const quiet = (p: Promise<string>): Promise<string> => p.catch(() => '');

const isFile = (p: string): Promise<boolean> => fs.stat(p).then((s) => s.isFile(), () => false);

/**
 * git by its full path, found once: a bare `git` makes every spawn walk PATH (about 50 ms a call on
 * macOS, against 3 ms), and macOS's /usr/bin/git is a shim that asks xcrun on every call. v1 found it
 * with sync fs calls and an `xcrun --find` that held the server ~200 ms at boot; this is all async.
 */
export async function findGit(proc: ProcService, platform: string = process.platform): Promise<string | null> {
  const found = await proc.which('git');
  if (!found || platform !== 'darwin' || found !== '/usr/bin/git') return found;
  // The developer folder xcode-select points at, read from its link.
  try {
    const real = path.join(await fs.realpath('/var/db/xcode_select_link'), 'usr', 'bin', 'git');
    if (await isFile(real)) return real;
  } catch {}
  const r = await proc.exec('/usr/bin/xcrun', ['--find', 'git'], { timeoutMs: 3000 });
  const real = r.code === 0 ? r.stdout.trim() : '';
  return real && (await isFile(real)) ? real : found;
}

export function createTools(proc: ProcService, env: Readonly<Record<string, string | undefined>> = process.env): Tools {
  let bin: Promise<string> | null = null;
  const gitBin = (): Promise<string> => {
    const fixed = env['WISP_GIT_BIN'];
    if (fixed) return Promise.resolve(fixed);
    // not installed (yet): look again next time
    bin ??= findGit(proc).then((b) => {
      if (!b) bin = null;
      return b ?? 'git';
    });
    return bin;
  };
  const ghBin = (): string => env['WISP_GH_BIN'] || 'gh';
  const exec = (b: string, args: readonly string[], o: RunOptions, timeoutMs: number): Promise<ExecResult> =>
    proc.exec(b, args, { ...(o.cwd !== undefined && { cwd: o.cwd }), timeoutMs: o.timeoutMs ?? timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...QUIET_ENV, ...o.env }, ...(o.input !== undefined && { input: o.input }) });
  const out = (r: ExecResult, o: RunOptions): string => {
    if (r.code === 0) return o.raw ? r.stdout : r.stdout.trim();
    const missing = r.code === null && /ENOENT/.test(r.stderr);
    throw new ToolError(whyOf(r.stderr, r.timedOut ? 'timed out' : `exited with ${String(r.code)}`), r.code, r.stdout, missing);
  };
  return {
    proc,
    gitBin,
    ghBin,
    gitResult: async (cwd, args, o = {}) => exec(await gitBin(), args, { ...o, cwd }, 60_000),
    git: async (cwd, args, o = {}) => out(await exec(await gitBin(), args, { ...o, cwd }, 60_000), o),
    gh: async (cwd, args, o = {}) => out(await exec(ghBin(), args, { ...o, cwd }, 120_000), o),
  };
}
