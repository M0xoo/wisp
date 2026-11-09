// The Changes pane's pure half (v1 features/panel.js changes): what the task's turns changed, file by file,
// as the kit's Diff reads it. A turn's `body.changes` (runtime's FileChange: file, op, edits of before → after)
// becomes one DiffFile per file, its edits in order, each edit a hunk of a line diff (kept lines as context).
import type { DiffFile, DiffHunk, DiffLine, DiffStatus } from '@wisp/ui';

export interface FileChange {
  readonly file: string;
  readonly op?: 'add' | 'modify' | 'delete' | 'rename' | string;
  readonly edits?: readonly { readonly before: string; readonly after: string }[];
}

/** A server turn row, as far as the pane reads it. */
export interface ChangeTurn {
  readonly session_id: string;
  readonly idx: number;
  readonly body?: { readonly changes?: readonly FileChange[]; readonly ext?: { readonly 'wisp.runtime'?: { readonly changes?: readonly FileChange[] } } };
}

/** A turn's changes: runtime keeps them in its ext (`ext["wisp.runtime"].changes`); `changes` is the older place. */
export const changesOf = (t: ChangeTurn): readonly FileChange[] => t.body?.ext?.['wisp.runtime']?.changes ?? t.body?.changes ?? [];

/** macOS resolves /tmp, /var and /etc to /private/…: a recorded path may carry it when the task's cwd doesn't */
const canonical = (p: string): string => p.replace(/^\/private(?=\/(tmp|var|etc)\/)/, '').replace(/\/$/, '');

/** A path as the task's folder sees it (`/w/api/src/a.ts` → `src/a.ts`). */
export function relative(file: string, cwd: string): string {
  const [f, c] = [canonical(file), canonical(cwd)];
  return c && f.startsWith(`${c}/`) ? f.slice(c.length + 1) : file;
}

const lines = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));

/** One edit as a hunk: what stayed around the change as context, the removed lines, then the added ones. */
export function hunkOf(before: string, after: string, at = 1): DiffHunk {
  const a = lines(before);
  const b = lines(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const out: DiffLine[] = [];
  let o = at;
  let n = at;
  for (const t of a.slice(0, pre)) out.push({ kind: 'ctx', text: t, old: o++, new: n++ });
  for (const t of a.slice(pre, a.length - suf)) out.push({ kind: 'del', text: t, old: o++, new: null });
  for (const t of b.slice(pre, b.length - suf)) out.push({ kind: 'add', text: t, old: null, new: n++ });
  for (const t of a.slice(a.length - suf)) out.push({ kind: 'ctx', text: t, old: o++, new: n++ });
  return { header: `@@ -${at},${a.length} +${at},${b.length} @@`, oldStart: at, newStart: at, lines: out };
}

const STATUS: Readonly<Record<string, DiffStatus>> = { add: 'added', delete: 'deleted', rename: 'renamed' };

/** The task's changes, file by file, in the order they were first changed; `session` is its bare id, `cwd` its
 *  folder (paths show from there). */
export function filesOf(turns: readonly ChangeTurn[], session: string, cwd = ''): DiffFile[] {
  const byFile = new Map<string, { status: DiffStatus; hunks: DiffHunk[] }>();
  for (const turn of [...turns].filter((t) => t.session_id === session).sort((x, y) => x.idx - y.idx)) {
    for (const raw of changesOf(turn)) {
      const c = { ...raw, file: relative(raw.file, cwd) };
      const f = byFile.get(c.file) ?? { status: STATUS[c.op ?? ''] ?? 'modified', hunks: [] };
      for (const e of c.edits ?? []) f.hunks.push(hunkOf(e.before, e.after));
      if (c.op === 'delete') f.status = 'deleted';
      byFile.set(c.file, f);
    }
  }
  return [...byFile].map(([path, f]) => ({
    oldPath: f.status === 'added' ? null : path,
    newPath: f.status === 'deleted' ? null : path,
    path,
    status: f.status,
    binary: false,
    additions: f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'add').length, 0),
    deletions: f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'del').length, 0),
    hunks: f.hunks,
  }));
}
