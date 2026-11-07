// Pure helpers the content blocks share (v1 web/js/blocks.js splitPath, CHANGE, fmtDuration, md.js
// langOf). No DOM, no IO: each one is tested on its own (test/blocks-content-util.test.ts).

/** `src/auth/login.ts` → [`src/auth/`, `login.ts`]: the folder is drawn faint, the name strong. */
export function splitPath(p: string): readonly [string, string] {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

export type ChangeKind = 'add' | 'mod' | 'del' | 'ren';

/** What an agent wrote in `change` (v1 CHANGE): its one-letter mark and its kind. */
const CHANGE: Readonly<Record<string, readonly [string, ChangeKind]>> = {
  added: ['A', 'add'],
  create: ['A', 'add'],
  modified: ['M', 'mod'],
  edit: ['M', 'mod'],
  write: ['M', 'mod'],
  deleted: ['D', 'del'],
  renamed: ['R', 'ren'],
};

/** An unknown word is the fallback's change (files: modified; tree: added, as v1). */
export function changeOf(v: unknown, fallback: 'added' | 'modified'): { readonly mark: string; readonly kind: ChangeKind } {
  const hit = typeof v === 'string' && Object.hasOwn(CHANGE, v) ? CHANGE[v] : CHANGE[fallback];
  const [mark, kind] = hit ?? ['M', 'mod'];
  return { mark, kind };
}

/** v1 fmtDuration: 820ms, 4s, 2m 05s, 1h 3m. Nothing for a missing or negative time. */
export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 1) return `${Math.round(ms)}ms`;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** `test/auth.test.ts:42` (or `:42:7`) → the path and the line; a path alone has no line. */
export function fileLine(s: string): { readonly path: string; readonly line: number | undefined } {
  const m = /^(.+?):(\d+)(?::\d+)?$/.exec(s.trim());
  if (!m) return { path: s.trim(), line: undefined };
  return { path: m[1] ?? '', line: Number(m[2]) };
}

/** A file's language for highlighting, from its extension (v1 md.js langOf). */
export function langOf(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  const ext = base.slice(dot + 1).toLowerCase();
  const alias: Readonly<Record<string, string>> = { mjs: 'js', cjs: 'js', jsx: 'js', tsx: 'ts', yml: 'yaml' };
  return alias[ext] ?? ext;
}

/** The digits after the point a value was written with: `1.50` → 2, so a count keeps them. */
export function decimalsOf(v: unknown): number {
  if (typeof v !== 'string' && typeof v !== 'number') return 0;
  const frac = String(v).split('.')[1];
  return frac && /^\d+$/.test(frac) ? Math.min(frac.length, 6) : 0;
}

// eslint-disable-next-line no-control-regex -- terminal colour codes are what this strips
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** A command's output as it reads: colour codes gone, trailing blank lines and spaces trimmed. */
export function cleanOutput(s: string): string {
  return s.replace(ANSI, '').replace(/\s+$/, '');
}

/** The last `keep` lines, and how many came before them (a long output shows its end). */
export function tailLines(s: string, keep: number): { readonly text: string; readonly hidden: number } {
  const lines = s.split('\n');
  if (lines.length <= keep) return { text: s, hidden: 0 };
  return { text: lines.slice(-keep).join('\n'), hidden: lines.length - keep };
}

/** Consecutive slices of `size`: long lists render in chunks the browser lays out near the screen. */
export function chunksOf<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const n = Math.max(1, Math.floor(size));
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** A commit hash as v1 showed it: its first 7 characters. */
export const shortHash = (h: string): string => h.slice(0, 7);
