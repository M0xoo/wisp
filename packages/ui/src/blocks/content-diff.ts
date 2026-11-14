// A `diff` block's own before/after (v1 web/js/diff.js): a line diff (LCS, common ends trimmed so
// the table stays small), cut into hunks with 3 lines of context, as the kit Diff's DiffFile.
import { parseDiff, type DiffFile, type DiffHunk, type DiffLine } from '../content/diff/parse.ts';

export interface LineOp {
  readonly op: ' ' | '+' | '-';
  readonly text: string;
  /** line in before (context and removed lines) */
  readonly a: number | null;
  /** line in after (context and added lines) */
  readonly b: number | null;
}

const split = (s: string): string[] => (s === '' ? [] : s.split('\n'));
/** Past this many cells the LCS table costs too much: the middle shows as removed then added. */
const MAX_CELLS = 4_000_000;

function lcs(a: readonly string[], b: readonly string[], start: number, out: LineOp[]): void {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) {
    a.forEach((t, i) => out.push({ op: '-', text: t, a: start + i + 1, b: null }));
    b.forEach((t, j) => out.push({ op: '+', text: t, a: null, b: start + j + 1 }));
    return;
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as Uint32Array;
    const next = dp[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] ?? '', a: start + ++i, b: start + ++j });
    } else if (j < m && (i >= n || (dp[i]?.[j + 1] ?? 0) > (dp[i + 1]?.[j] ?? 0))) {
      out.push({ op: '+', text: b[j] ?? '', a: null, b: start + ++j });
    } else {
      out.push({ op: '-', text: a[i] ?? '', a: start + ++i, b: null });
    }
  }
}

/** Every line of before and after, in order, as kept, removed or added. */
export function diffLines(before: string, after: string): LineOp[] {
  const a = split(before);
  const b = split(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: LineOp[] = [];
  for (let i = 0; i < start; i++) out.push({ op: ' ', text: a[i] ?? '', a: i + 1, b: i + 1 });
  lcs(a.slice(start, endA), b.slice(start, endB), start, out);
  for (let k = 0; k < a.length - endA; k++) out.push({ op: ' ', text: a[endA + k] ?? '', a: endA + k + 1, b: endB + k + 1 });
  return out;
}

/** Runs of ops kept around the changes (`context` lines each side); the rest is dropped. */
export function hunkRuns(ops: readonly LineOp[], context = 3): LineOp[][] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.op === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const runs: LineOp[][] = [];
  let cur: LineOp[] | undefined;
  ops.forEach((o, i) => {
    if (!keep[i]) {
      cur = undefined;
      return;
    }
    if (!cur) runs.push((cur = []));
    cur.push(o);
  });
  return runs;
}

const KIND = { ' ': 'ctx', '+': 'add', '-': 'del' } as const;

function hunkOf(run: readonly LineOp[]): DiffHunk {
  const firstA = run.find((o) => o.a !== null)?.a ?? 0;
  const firstB = run.find((o) => o.b !== null)?.b ?? 0;
  const nA = run.filter((o) => o.op !== '+').length;
  const nB = run.filter((o) => o.op !== '-').length;
  const lines: DiffLine[] = run.map((o) => ({ kind: KIND[o.op], text: o.text, old: o.a, new: o.b }));
  // An empty side starts at 0, as git writes it (`-0,0`).
  const oldStart = nA ? firstA : 0;
  const newStart = nB ? firstB : 0;
  return { header: `@@ -${oldStart},${nA} +${newStart},${nB} @@`, oldStart, newStart, lines };
}

/** A hand-picked before/after as one file of the kit Diff. */
export function diffFileOf(path: string, before: string, after: string): DiffFile {
  const ops = diffLines(before, after);
  const additions = ops.filter((o) => o.op === '+').length;
  const deletions = ops.filter((o) => o.op === '-').length;
  const status = before === '' && after !== '' ? 'added' : after === '' && before !== '' ? 'deleted' : 'modified';
  return {
    oldPath: status === 'added' ? null : path,
    newPath: status === 'deleted' ? null : path,
    path,
    status,
    binary: false,
    additions,
    deletions,
    hunks: hunkRuns(ops).map(hunkOf),
  };
}

/**
 * The diff a block (or a files row) carries itself: `diff`, a unified diff (the file named, else
 * its first), or a hand-picked `before`/`after`. undefined: it carries none.
 */
export function ownDiff(o: Readonly<Record<string, unknown>>, path: string): DiffFile | undefined {
  const text = typeof o['diff'] === 'string' ? o['diff'] : '';
  if (text.trim()) {
    const files = parseDiff(text);
    const named = path ? files.find((f) => f.path === path || f.path.endsWith(`/${path}`) || path.endsWith(`/${f.path}`)) : undefined;
    const file = named ?? files[0];
    if (file) return file;
  }
  const before = o['before'];
  const after = o['after'];
  if (typeof before !== 'string' && typeof after !== 'string') return undefined;
  return diffFileOf(path, typeof before === 'string' ? before : '', typeof after === 'string' ? after : '');
}
