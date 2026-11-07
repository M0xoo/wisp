// A file's hunks in the Changes panel (v1 server/hunks.js), pure: the page, the workspace routes and
// git's staging all cut a file's rows the same way. rows are a DiffFile's.

import type { DiffRow } from './rows.ts';

export interface Hunk {
  /** the hunk's first line in the file as it is now (1-based), counted even when all of it is removed */
  start: number;
  rows: Exclude<DiffRow, { op: '…' }>[];
  /** what the file holds now */
  after: string[];
  /** what the base had */
  before: string[];
}

/** A file's hunks: the runs of rows between '…' gaps. */
export function hunksOf(rows: readonly DiffRow[] = []): Hunk[] {
  const out: { start: number; rows: Hunk['rows'] }[] = [];
  let h: { start: number; rows: Hunk['rows'] } | null = null;
  let next = 1; // the file's next line after what we've walked
  for (const r of rows) {
    if (r.op === '…') {
      h = null;
      next += r.count || 0;
      continue;
    }
    if (!h) {
      h = { start: next, rows: [] };
      out.push(h);
    }
    h.rows.push(r);
    if (r.b !== undefined && r.b !== null) next = r.b + 1;
  }
  return out.map((x) => ({ ...x, after: x.rows.filter((r) => r.op !== '-').map((r) => r.text), before: x.rows.filter((r) => r.op !== '+').map((r) => r.text) }));
}

/**
 * The key the page sends for the hunk it showed (the same sum as the page's hash()), so a hunk that
 * moved or changed since is refused rather than reverting the one now at that index.
 */
export function hunkKey(rows: readonly DiffRow[] = []): string {
  let h = 5381;
  for (const r of rows) for (const c of `${r.op}${'text' in r ? r.text : r.count}\n`) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

function linesOf(text: string): { lines: string[]; nl: boolean } {
  const nl = text.endsWith('\n');
  const body = nl ? text.slice(0, -1) : text;
  return { lines: body === '' && !nl ? [] : body.split('\n'), nl };
}

/**
 * The file with hunk i of its diff put back, or null when the file's lines there aren't the hunk's
 * any more (edited since the diff was read) or there's no such hunk. Keeps the last newline.
 */
export function revertHunk(text: unknown, rows: readonly DiffRow[], i: number): string | null {
  const h = hunksOf(rows)[i];
  if (!h || typeof text !== 'string') return null;
  const { lines, nl } = linesOf(text);
  const at = h.start - 1;
  if (at < 0 || at + h.after.length > lines.length) return null;
  for (let k = 0; k < h.after.length; k++) if (lines[at + k] !== h.after[k]) return null;
  lines.splice(at, h.after.length, ...h.before);
  return lines.length ? lines.join('\n') + (nl ? '\n' : '') : '';
}

/** Hunk staging is for a file Changes shows hunk by hunk and git tracks: changed, not new or binary. */
export const hunkable = (f: { status: string; binary: boolean; rows?: readonly DiffRow[] }): boolean => (f.status === 'M' || f.status === 'R') && !f.binary && (f.rows?.length ?? 0) > 0;
