// The Changes pane's pure half (v1 features/panel.js changes): what the task's turns changed, file by file,
// as the kit's Diff reads it. A turn's `body.changes` (runtime's FileChange: file, op, edits of before → after)
// becomes one DiffFile per file, its edits in order, each edit a hunk of a line diff (kept lines as context).
import { isEnvFile, maskEdit, type DiffFile, type DiffHunk, type DiffLine, type DiffStatus } from '@wisp/ui';

export interface FileChange {
  readonly file: string;
  readonly op?: 'add' | 'modify' | 'delete' | 'rename' | string;
  readonly edits?: readonly { readonly before: string; readonly after: string }[];
}

/** A server turn row, as far as the pane reads it. */
export interface ChangeTurn {
  /** the turn's id: what Reveal names to the server */
  readonly id?: string;
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

type Edits = readonly { readonly before: string; readonly after: string }[];

/** The task's changes, file by file, in the order they were first changed; `session` is its bare id, `cwd` its
 *  folder (paths show from there). `mask`: a file (as shown) whose edits read KEY=•••• (a .env file, not revealed).
 *  `shown`: a revealed file's edits as the server keeps them (Reveal asked: the turn rows carry them masked). */
export function filesOf(
  turns: readonly ChangeTurn[],
  session: string,
  cwd = '',
  mask: (path: string) => boolean = () => false,
  shown: (turn: string, file: string) => Edits | undefined = () => undefined,
): DiffFile[] {
  const byFile = new Map<string, { status: DiffStatus; hunks: DiffHunk[] }>();
  for (const turn of [...turns].filter((t) => t.session_id === session).sort((x, y) => x.idx - y.idx)) {
    for (const raw of changesOf(turn)) {
      const c = { ...raw, file: relative(raw.file, cwd) };
      const f = byFile.get(c.file) ?? { status: STATUS[c.op ?? ''] ?? 'modified', hunks: [] };
      const hide = mask(c.file);
      const edits = (!hide && turn.id !== undefined ? shown(turn.id, raw.file) : undefined) ?? c.edits ?? [];
      for (const raw of edits) {
        const e = hide ? maskEdit(raw) : raw;
        f.hunks.push(hunkOf(e.before, e.after));
      }
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

/** A row of `git.changes` (wisp-git's FileDiff): ' ', '+', '-', or '…' for a gap of `count` unchanged lines. */
export interface GitRow {
  readonly op: string;
  readonly text?: string;
  readonly a?: number;
  readonly b?: number;
  readonly count?: number;
}
export interface GitFile {
  readonly path: string;
  readonly from?: string | null;
  readonly status: string;
  readonly add: number;
  readonly del: number;
  readonly binary: boolean;
  readonly rows: readonly GitRow[];
}
/** `git.changes`' answer: every file the work changed since it left `base`, committed or not. */
export interface GitChanges {
  readonly base: string;
  readonly at: string;
  readonly body: { readonly kind: 'inline'; readonly files: readonly GitFile[] } | { readonly kind: 'blob' };
}

const GIT_STATUS: Readonly<Record<string, DiffStatus>> = { A: 'added', D: 'deleted', R: 'renamed', '?': 'added' };

/** The git diff as the kit's Diff reads it: a file's rows as hunks, a new hunk after each gap. Null when the
 *  answer is too big to come inline (a blob). */
export function gitFiles(c: GitChanges): DiffFile[] | null {
  if (c.body.kind !== 'inline') return null;
  return c.body.files.map((f) => {
    const hunks: DiffHunk[] = [];
    let cur: DiffLine[] = [];
    let start: { a: number; b: number } | undefined;
    const close = (): void => {
      if (cur.length && start) hunks.push({ header: `@@ -${start.a} +${start.b} @@`, oldStart: start.a, newStart: start.b, lines: cur });
      cur = [];
      start = undefined;
    };
    for (const r of f.rows) {
      if (r.op === '…') {
        close();
        continue;
      }
      start ??= { a: r.a ?? r.b ?? 1, b: r.b ?? r.a ?? 1 };
      const kind = r.op === '+' ? 'add' : r.op === '-' ? 'del' : 'ctx';
      cur.push({ kind, text: r.text ?? '', old: r.op === '+' ? null : (r.a ?? null), new: r.op === '-' ? null : (r.b ?? null) });
    }
    close();
    const status = GIT_STATUS[f.status] ?? 'modified';
    return { oldPath: status === 'added' ? null : (f.from ?? f.path), newPath: status === 'deleted' ? null : f.path, path: f.path, status, binary: f.binary, additions: f.add, deletions: f.del, hunks };
  });
}

/** The .env files whose Reveal is on, per task (v1 changes.js `unmaskedPaths`): for this tab's life, so the pane
 *  opened again or a refresh of the task doesn't hide them again. `git.changes` sends these unmasked. */
const revealedByTask = new Map<string, ReadonlySet<string>>();
export const revealedOf = (task: string): ReadonlySet<string> => revealedByTask.get(task) ?? new Set<string>();
export function setRevealed(task: string, path: string, on: boolean): ReadonlySet<string> {
  const s = new Set(revealedOf(task));
  if (on) s.add(path);
  else s.delete(path);
  revealedByTask.set(task, s);
  return s;
}

/** A file's .env line (v1 env-mask.js maskBar): 'hidden' when git sent it masked, 'shown' once revealed (git then
 *  sends it as it is, unmarked), none for any other file. */
/** A file wisp saw edited (no git): masked when it's a .env file, masking is on and it isn't revealed. */
export const seenMasked = (path: string, maskOn: boolean, revealed: ReadonlySet<string>): boolean => maskOn && isEnvFile(path) && !revealed.has(path);

export function envState(f: { readonly path: string; readonly masked?: boolean | null }, revealed: ReadonlySet<string>): 'hidden' | 'shown' | undefined {
  if (revealed.has(f.path)) return 'shown';
  return f.masked ? 'hidden' : undefined;
}
