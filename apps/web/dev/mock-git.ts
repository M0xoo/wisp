// The mock's wisp-git (git.changes, git.stage, git.revert, git.commit): a task's diff built from its turns' own
// changes (each one's file before and its edits, as v1's seed has them), so the Changes pane shows what v1's did
// (qa/parity.mjs task.changes). Stage, revert and commit answer as the server does, and change what the next read says.

type Args = Record<string, unknown>;
interface Row {
  op: string;
  text?: string;
  a?: number;
  b?: number;
  count?: number;
}
interface Change {
  file?: string;
  op?: string;
  beforeFile?: string;
  edits?: { before?: string; after?: string }[];
}

const str = (a: Args, k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '');

/** wisp-git's mask (plugins/git/core/src/mask.rs): `.env`, `.env.*` but not `.example`/`.sample`; KEY=•••• */
export const isEnvFile = (path: string): boolean => {
  const base = path.split(/[\\/]/).pop() ?? path;
  return /^\.env(\.[\w.-]+)?$/.test(base) && !/\.(example|sample)$/i.test(base);
};
export const maskLine = (line: string): string => {
  const t = line.trimStart();
  if (!t || t.startsWith('#')) return line;
  const m = /^(\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*[=:]\s*)(.*)$/.exec(line);
  if (m) return m[2] ? `${m[1]}••••` : line;
  return `${line.slice(0, line.length - t.length)}••••`;
};

/** before → after as git's rows: the common start and end as context, the middle removed then added. */
export function rowsOf(before: string, after: string): Row[] {
  const lines = (t: string): string[] => (t === '' ? [] : t.replace(/\n$/, '').split('\n')); // an empty file has no lines
  const a = lines(before);
  const b = lines(after);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const rows: Row[] = [];
  for (let i = 0; i < s; i++) rows.push({ op: ' ', text: a[i] ?? '', a: i + 1, b: i + 1 });
  for (let i = s; i < a.length - e; i++) rows.push({ op: '-', text: a[i] ?? '', a: i + 1 });
  for (let i = s; i < b.length - e; i++) rows.push({ op: '+', text: b[i] ?? '', b: i + 1 });
  for (let i = 0; i < e; i++) rows.push({ op: ' ', text: a[a.length - e + i] ?? '', a: a.length - e + i + 1, b: b.length - e + i + 1 });
  return rows;
}

interface FileState {
  staged: boolean;
  gone: boolean;
}
const state = new Map<string, FileState>(); // `${dir}\n${path}`
const committedAll = new Set<string>(); // dirs whose every change went in one `git.commit {all}`

export interface GitCtx {
  /** every turn row of every task: their bodies carry `changes` */
  turnsOf(dir: string): readonly { changes?: Change[] }[] | undefined;
  base(dir: string): string;
}

export function gitChanges(a: Args, g: GitCtx): unknown {
  const dir = str(a, 'path');
  const turns = g.turnsOf(dir);
  if (!turns) return null;
  if (committedAll.has(dir)) return { base: g.base(dir), at: 'a1b2c3d', stats: [], body: { kind: 'inline', files: [] }, untracked: 0, staged: 0 };
  const files = new Map<string, { before: string; after: string }>();
  for (const t of turns)
    for (const c of t.changes ?? []) {
      if (!c.file) continue;
      const cur = files.get(c.file) ?? { before: c.beforeFile ?? '', after: c.beforeFile ?? '' };
      let after = cur.after;
      for (const e of c.edits ?? []) if (e.before !== undefined && e.after !== undefined) after = after.replace(e.before, e.after);
      files.set(c.file, { before: cur.before, after });
    }
  const out = [...files]
    .filter(([path]) => !state.get(`${dir}\n${path}`)?.gone)
    .map(([path, f]) => {
      // git.changes masks a .env file unless the page revealed it (`reveal`), and says so (`masked`)
      const masked = a['mask'] !== false && isEnvFile(path) && !(Array.isArray(a['reveal']) && (a['reveal'] as unknown[]).includes(path));
      const rows = rowsOf(f.before, f.after).map((r) => (masked && r.text !== undefined ? { ...r, text: maskLine(r.text) } : r));
      const st = state.get(`${dir}\n${path}`);
      const staged = st?.staged === true;
      return {
        path,
        status: f.before ? 'M' : 'A',
        add: rows.filter((r) => r.op === '+').length,
        del: rows.filter((r) => r.op === '-').length,
        binary: false,
        rows,
        more: 0,
        generated: false,
        staged,
        unstaged: !staged,
        hunkStage: [{ staged, unstaged: !staged }],
        ...(masked && { masked: true }),
      };
    });
  return {
    base: g.base(dir),
    at: '0000000',
    stats: out.map((f) => ({ path: f.path, status: f.status, add: f.add, del: f.del, binary: false, generated: false })),
    body: { kind: 'inline', files: out },
    untracked: 0,
    staged: out.filter((f) => f.staged).length,
  };
}

export function gitStage(a: Args): unknown {
  state.set(`${str(a, 'dir')}\n${str(a, 'path')}`, { staged: a['unstage'] !== true, gone: false });
  return { ok: true };
}

export function gitRevert(a: Args): unknown {
  state.set(`${str(a, 'dir')}\n${str(a, 'path')}`, { staged: false, gone: true });
  return { ok: true, hash: null };
}

export function gitCommit(a: Args): unknown {
  const dir = str(a, 'dir');
  if (a['all'] === true) committedAll.add(dir);
  for (const [k, v] of state) if (k.startsWith(`${dir}\n`) && (v.staged || a['all'] === true)) state.set(k, { staged: false, gone: true });
  return { ok: true, sha: 'a1b2c3d' };
}

/** The mock starts over (POST /__mock/reset). */
export function resetGit(): void {
  state.clear();
  committedAll.clear();
}
