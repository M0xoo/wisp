// The shared vocabulary of the command describer: what a stage's description looks like, and the
// argv helpers every per-command table reads its flags and operands with.

import { clip } from '../text.ts';
import { rel, type RunPaths } from '../paths.ts';

/**
 * One stage's sentence. `weak` ones (`cd x`, `echo ---`) only count when nothing better was found;
 * `unknown` ones are the raw command echoed back, which the caller may replace with its fallback.
 */
export interface Desc {
  text: string;
  weak?: boolean;
  unknown?: boolean;
}

export type Paths = RunPaths | string;

export type ShowPath = (p: string | null | undefined) => string;

/** What a per-command describer gets: one stage, already peeled, with its paths helpers. */
export interface Ctx {
  /** The command's base name (`/usr/bin/git` → `git`). */
  cmd: string;
  argv: string[];
  args: string[];
  out: string | null;
  input: string | null | undefined;
  paths: Paths;
  /** Whether the stage is one of several in a pipe, where filters say less than producers. */
  piped: boolean;
  /** A path as the ticker shows it. */
  f: ShowPath;
  /** The stage's operands, and the first two of them shown as paths. */
  files: string[];
  target: string;
  /** Describes the stage made of these words (`while <cond>`). */
  stage: (words: string[]) => Desc | null;
  /** Describes a whole script (`bash -c '<script>'`). */
  script: (script: string | undefined) => Desc;
}

export type Describer = (c: Ctx) => Desc | null;

/** Command names and the describer they share. */
export type Table = ReadonlyArray<readonly [readonly string[], Describer]>;

export const result = (text: string, extra?: { weak?: boolean }): Desc => ({ text, ...extra });
export const weak = (text: string): Desc => ({ text, weak: true });

/**
 * `table[key]` when the table has it as its own entry. v1 indexed plain objects, so a subcommand
 * named `constructor` or `toString` came back as an Object.prototype function: those now get the
 * caller's fallback instead.
 */
export function pick(table: Record<string, string>, key: string | undefined): string | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

// Arguments that aren't flags, skipping the value of `-n 20`-style options.
export function operands(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-')) {
      const next = args[i + 1];
      if (/^-[nABCmdeoItLX]$/.test(a) && next !== undefined && !next.startsWith('-')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

// Drop leading flags (and --flag=value) so the subcommand comes first.
export function stripFlags(args: readonly string[]): string[] {
  const out = [...args];
  while (out[0]?.startsWith('-')) out.shift();
  return out;
}

/** The value after the first of `names` (`-m msg`, `--message=msg`); undefined when it has none. */
export function valueOf(args: readonly string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (names.includes(a)) return args[i + 1];
    for (const n of names) if (n.startsWith('--') && a.startsWith(`${n}=`)) return a.slice(n.length + 1);
  }
  return undefined;
}

// `head -n 20`, `head -20`, `head -n20`, `--lines=20`
export function countArg(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    const next = args[i + 1] ?? '';
    if ((a === '-n' || a === '-c') && /^\+?\d+$/.test(next)) return next.replace('+', '');
    const m = a.match(/^-n?(\d+)$/) ?? a.match(/^--lines=(\d+)$/);
    if (m?.[1] !== undefined) return m[1];
  }
  return null;
}

/** The host a URL points at; localhost keeps its port, since that's what tells dev servers apart. */
export function host(url: string): string {
  try {
    const u = new URL(/^https?:/.test(url) ? url : `https://${url}`);
    const local = u.hostname === 'localhost' || /^127\./.test(u.hostname);
    return u.hostname.replace(/^www\./, '') + (local && u.port ? `:${u.port}` : '');
  } catch {
    return clip(url, 40);
  }
}

// Paths relative to the project, and long ones shortened to their tail. An empty cwd means "don't
// relativise" (v1 called this without one for `python -m <tool>`).
export function short(p: string | null | undefined, paths: Paths): string {
  if (!p) return '';
  const base = typeof paths === 'string' ? paths : paths.cwd;
  let s = base ? rel(p, paths) : p;
  if (!p.includes('\\')) s = s.replace(/\\/g, '/'); // path.relative on Windows turns server/a.js into server\a.js
  if (s.length > 48) {
    const parts = s.split(/[\\/]/).filter(Boolean);
    s = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : clip(s, 48);
  }
  return s;
}

/** Up to two paths, then `+N` for the rest: `a.js, b.js +3`. */
export function listed(files: readonly string[], f: (p: string) => string): string {
  if (!files.length) return '';
  return files.map(f).slice(0, 2).join(', ') + (files.length > 2 ? ` +${files.length - 2}` : '');
}
