// Unified diffs (git diff, diff -u) → files → hunks → lines with their old and new numbers.
// Hunk lines are counted from the @@ header, so a removed line that reads `-- a/x` is never
// taken for the next file's header.

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'note';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** Line number in the old file (deleted and context lines). */
  readonly old: number | null;
  /** Line number in the new file (added and context lines). */
  readonly new: number | null;
}

export interface DiffHunk {
  /** The whole `@@ -1,3 +1,4 @@ section` line. */
  readonly header: string;
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly DiffLine[];
}

export type DiffStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffFile {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  /** The path to show: the new one, or the old one for a deletion. */
  readonly path: string;
  readonly status: DiffStatus;
  readonly binary: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly DiffHunk[];
}

interface Draft {
  oldPath: string | null;
  newPath: string | null;
  gitOld: string | null;
  gitNew: string | null;
  added: boolean;
  deleted: boolean;
  renamed: boolean;
  binary: boolean;
  hunks: Array<{ header: string; oldStart: number; newStart: number; lines: DiffLine[] }>;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const draft = (): Draft => ({ oldPath: null, newPath: null, gitOld: null, gitNew: null, added: false, deleted: false, renamed: false, binary: false, hunks: [] });

/** `a/src/x.ts\t2024-…` → `src/x.ts`; `/dev/null` → null. */
function cleanPath(raw: string): string | null {
  let p = raw.split('\t')[0]?.trim() ?? '';
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

function finish(d: Draft): DiffFile {
  const oldPath = d.added ? null : (d.oldPath ?? d.gitOld);
  const newPath = d.deleted ? null : (d.newPath ?? d.gitNew);
  let status: DiffStatus = 'modified';
  if (oldPath === null && newPath !== null) status = 'added';
  else if (newPath === null && oldPath !== null) status = 'deleted';
  else if (d.renamed || (oldPath !== null && newPath !== null && oldPath !== newPath)) status = 'renamed';
  let additions = 0;
  let deletions = 0;
  for (const h of d.hunks) for (const l of h.lines) {
    if (l.kind === 'add') additions++;
    if (l.kind === 'del') deletions++;
  }
  return { oldPath, newPath, path: newPath ?? oldPath ?? '', status, binary: d.binary, additions, deletions, hunks: d.hunks };
}

/** Header lines between files: paths, modes, renames, binary markers. */
function header(d: Draft, line: string): void {
  if (line.startsWith('--- ')) d.oldPath = cleanPath(line.slice(4));
  else if (line.startsWith('+++ ')) d.newPath = cleanPath(line.slice(4));
  else if (line.startsWith('new file mode')) d.added = true;
  else if (line.startsWith('deleted file mode')) d.deleted = true;
  else if (line.startsWith('rename from ')) {
    d.renamed = true;
    d.gitOld = line.slice(12);
  } else if (line.startsWith('rename to ')) {
    d.renamed = true;
    d.gitNew = line.slice(10);
  } else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) d.binary = true;
  if (d.added) d.oldPath = null;
  if (d.deleted) d.newPath = null;
}

interface State {
  readonly files: DiffFile[];
  d: Draft | null;
  /** Lines still owed to the open hunk, by side. */
  oldLeft: number;
  newLeft: number;
  oldNo: number;
  newNo: number;
}

type DraftHunk = Draft['hunks'][number];

function openFile(st: State): Draft {
  if (st.d) st.files.push(finish(st.d));
  st.d = draft();
  st.oldLeft = 0;
  st.newLeft = 0;
  return st.d;
}

function hunkLine(st: State, hunk: DraftHunk, line: string): void {
  const sign = line[0];
  const body = line.slice(1);
  if (sign === '+') {
    hunk.lines.push({ kind: 'add', text: body, old: null, new: st.newNo++ });
    st.newLeft--;
  } else if (sign === '-') {
    hunk.lines.push({ kind: 'del', text: body, old: st.oldNo++, new: null });
    st.oldLeft--;
  } else if (sign === '\\') {
    hunk.lines.push({ kind: 'note', text: line, old: null, new: null });
  } else {
    // Some tools strip the space off an empty context line.
    hunk.lines.push({ kind: 'ctx', text: sign === ' ' ? body : line, old: st.oldNo++, new: st.newNo++ });
    st.oldLeft--;
    st.newLeft--;
  }
}

function step(st: State, line: string): void {
  const d = st.d;
  const hunk = d?.hunks[d.hunks.length - 1];
  // A line no hunk line starts with ends the hunk early: a header whose counts were wrong
  // (hand-edited, or cut by a tool) must not swallow the next file.
  const inHunk = st.oldLeft > 0 || st.newLeft > 0;
  if (hunk && inHunk && line !== '' && !'+- \\'.includes(line[0] ?? '')) {
    st.oldLeft = 0;
    st.newLeft = 0;
  } else if (hunk && (inHunk || line.startsWith('\\'))) return hunkLine(st, hunk, line);
  const m = HUNK.exec(line);
  if (m && d) {
    st.oldNo = Number(m[1]);
    st.newNo = Number(m[3]);
    st.oldLeft = m[2] === undefined ? 1 : Number(m[2]);
    st.newLeft = m[4] === undefined ? 1 : Number(m[4]);
    d.hunks.push({ header: line, oldStart: st.oldNo, newStart: st.newNo, lines: [] });
    return;
  }
  if (line.startsWith('diff --git ')) {
    const cur = openFile(st);
    const paths = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
    cur.gitOld = paths?.[1] ?? null;
    cur.gitNew = paths?.[2] ?? null;
    return;
  }
  // A plain unified diff has no `diff --git`: its `---` starts the next file.
  const target = line.startsWith('--- ') && (d === null || d.hunks.length > 0 || d.oldPath !== null) ? openFile(st) : d;
  if (target) header(target, line);
}

export function parseDiff(text: string): DiffFile[] {
  const st: State = { files: [], d: null, oldLeft: 0, newLeft: 0, oldNo: 0, newNo: 0 };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) step(st, line);
  if (st.d) st.files.push(finish(st.d));
  return st.files;
}
