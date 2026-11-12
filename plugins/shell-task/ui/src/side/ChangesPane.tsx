// The side panel's Changes (v1 features/changes.js, F-page-21/22): git's diff of the task's work since it left its
// base, committed or not, in the kit's ChangesList. In a worktree a file or a hunk is staged or unstaged, what's
// staged is committed (nothing staged: everything changed), and a hunk or a whole file is reverted. Each answers at
// once (design/feedback.md): the toggle flips, the reverted hunk goes, the committed files go; then git's own read
// comes back. A refusal puts it back as it was, with the error. Without git, the edits wisp saw, per file.
import { Show, createMemo, createResource, createSignal, type JSX } from 'solid-js';
import { defineCommand, type EntityKey } from '@wisp/client';
import { ChangesList, EmptyState, useSignal, type ChangeFile, type ChangeRow, type StageState } from '@wisp/ui';
import { useShell } from '../shell.ts';
import { useTask } from '../task-context.tsx';
import { filesOf, type ChangeTurn } from './changes.ts';

interface GitFileRow {
  readonly path: string;
  readonly from?: string | null;
  readonly status: string;
  readonly add: number;
  readonly del: number;
  readonly binary: boolean;
  readonly rows: readonly ChangeRow[];
  readonly staged?: boolean | null;
  readonly unstaged?: boolean | null;
  readonly hunkStage?: readonly { readonly staged: boolean; readonly unstaged: boolean }[] | null;
}
interface GitRead {
  readonly base: string;
  readonly body: { readonly kind: 'inline'; readonly files: readonly GitFileRow[] } | { readonly kind: 'blob' };
}

const read = defineCommand<{ key: EntityKey; path: string; base: string }, GitRead | null>({
  id: 'git.changes',
  owner: (a) => a.key,
  wire: (a) => ({ path: a.path, base: a.base, stageState: true }),
  optimistic: 'none',
  pending: 'the Changes pane',
});
const stage = defineCommand<{ key: EntityKey; dir: string; base: string; path: string; hunk?: number; hunkKey?: string; unstage: boolean }, { ok: boolean }>({
  id: 'git.stage',
  owner: (a) => a.key,
  wire: (a) => ({ dir: a.dir, base: a.base, path: a.path, unstage: a.unstage, ...(a.hunk !== undefined && { hunk: a.hunk, key: a.hunkKey }) }),
  optimistic: 'none',
  pending: 'the Stage toggle (flipped at once)',
});
const revert = defineCommand<{ key: EntityKey; dir: string; base: string; path: string; hunk?: number; hunkKey?: string }, { ok: boolean }>({
  id: 'git.revert',
  owner: (a) => a.key,
  wire: (a) => ({ dir: a.dir, base: a.base, path: a.path, ...(a.hunk !== undefined && { hunk: a.hunk, key: a.hunkKey }) }),
  optimistic: 'none',
  pending: 'the hunk or file (hidden at once)',
});
const commit = defineCommand<{ key: EntityKey; dir: string; message: string; all: boolean }, { ok: boolean; sha: string }>({
  id: 'git.commit',
  owner: (a) => a.key,
  wire: (a) => ({ dir: a.dir, message: a.message, all: a.all }),
  optimistic: 'none',
  pending: 'the committed files (gone at once)',
});

type Wt = { baseRef?: string; base?: string; path?: string; cwd?: string };
type Raw = { cwd?: string; title?: string; summary?: { worktree?: Wt | null }; body?: { cwd?: string; ext?: Record<string, Wt | undefined> } };

const stageOf = (f: GitFileRow): StageState => (!f.staged && !f.unstaged ? 'none' : f.staged && !f.unstaged ? 'staged' : f.staged ? 'part' : 'stage');

/** The edits wisp saw (no git), as the list's rows: each hunk's lines, a gap between hunks. */
function seenFiles(turns: readonly ChangeTurn[], id: string, cwd: string): ChangeFile[] {
  return filesOf(turns, id, cwd).map((f) => ({
    path: f.path,
    status: f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'M',
    add: f.additions,
    del: f.deletions,
    binary: f.binary,
    revertable: false,
    rows: f.hunks.flatMap((h, i) => [...(i ? [{ op: '…', count: 0 }] : []), ...h.lines.map((l) => ({ op: l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ', text: l.text }))]),
  }));
}

export function ChangesPane(): JSX.Element {
  const shell = useShell();
  const task = useTask();
  const t = shell.t;
  const raw = (): Raw | undefined => task.task() as Raw | undefined;
  // the task's worktree: wisp.worktrees' own ext, or the list row's summary (a task from v1's data has it there)
  const wt = (): Wt | undefined => raw()?.body?.ext?.['wisp.worktrees'] ?? raw()?.summary?.worktree ?? undefined;
  const dir = (): string => String(wt()?.path ?? wt()?.cwd ?? raw()?.body?.cwd ?? raw()?.cwd ?? '');
  const base = (): string => wt()?.baseRef || wt()?.base || 'HEAD';
  const [git, { refetch }] = createResource(
    () => (dir() ? { path: dir(), base: base() } : undefined),
    (a) => task.client.run(read, { key: task.key, ...a }).catch(() => null),
  );
  const turns = useSignal(task.client.entities.list<ChangeTurn>('turn'));
  // what you did before git answers again: a toggle flipped, a hunk or file reverted, files committed
  const [flipped, setFlipped] = createSignal(new Map<string, StageState>());
  const [going, setGoing] = createSignal(new Set<string>());
  const [open, setOpen] = createSignal<Set<string> | undefined>(undefined);
  const [viewed, setViewed] = createSignal(new Set<string>());
  const staging = (): boolean => !!wt()?.path || !!wt()?.cwd;
  const files = createMemo((): ChangeFile[] => {
    const g = git();
    if (!g || g.body.kind !== 'inline') return seenFiles(turns() as readonly ChangeTurn[], task.id, dir());
    return g.body.files
      .filter((f) => !going().has(f.path))
      .map((f) => ({
        path: f.path,
        status: f.status,
        add: f.add,
        del: f.del,
        binary: f.binary,
        rows: f.rows,
        ...(f.from ? { from: f.from } : {}),
        revertable: (f.status === 'M' || f.status === 'R') && !f.binary && f.rows.length > 0,
        ...(staging() ? { stage: flipped().get(f.path) ?? stageOf(f) } : {}),
        ...(staging() && f.hunkStage ? { hunkStage: f.hunkStage.map((h) => (h.unstaged ? ('stage' as const) : h.staged ? ('unstage' as const) : undefined)) } : {}),
      }));
  });
  // every diff opens by itself until you open, fold or view one (v1 opensNow)
  const isOpen = (p: string): boolean => open()?.has(p) ?? !viewed().has(p);
  const touch = (): Set<string> =>
    new Set(
      open() ??
        files()
          .filter((f) => !viewed().has(f.path))
          .map((f) => f.path),
    );
  const toggle = (p: string): void => {
    const s = touch();
    if (s.has(p)) s.delete(p);
    else s.add(p);
    setOpen(s);
  };
  const allOpen = (): boolean => files().every((f) => isOpen(f.path));
  const failed = (e: unknown): void => {
    shell.toast.show(e instanceof Error ? e.message : String(e), { tone: 'error' });
  };
  const after = (undo: () => void) => ({ ok: () => void refetch(), no: (e: unknown) => (undo(), failed(e)) });
  const onStage = (path: string, unstage: boolean): void => {
    const was = flipped();
    setFlipped(new Map(was).set(path, unstage ? 'stage' : 'staged'));
    const a = after(() => setFlipped(was));
    task.client.run(stage, { key: task.key, dir: dir(), base: base(), path, unstage }).then(() => (setFlipped(new Map()), a.ok()), a.no);
  };
  const onHunkStage = (path: string, hunk: number, hunkKey: string, unstage: boolean): void => {
    const a = after(() => undefined);
    task.client.run(stage, { key: task.key, dir: dir(), base: base(), path, hunk, hunkKey, unstage }).then(a.ok, a.no);
  };
  const [goingHunks, setGoingHunks] = createSignal(new Set<string>());
  const onRevertHunk = (path: string, hunk: number, hunkKey: string): void => {
    const k = `${path}#${hunk}`;
    setGoingHunks(new Set(goingHunks()).add(k));
    const back = (): void => {
      const s = new Set(goingHunks());
      s.delete(k);
      setGoingHunks(s);
    };
    task.client.run(revert, { key: task.key, dir: dir(), base: base(), path, hunk, hunkKey }).then(
      () => void Promise.resolve(refetch()).then(back),
      (e: unknown) => (back(), failed(e)),
    );
  };
  const revertFile = (path: string): void => {
    const was = going();
    setGoing(new Set(was).add(path));
    task.client.run(revert, { key: task.key, dir: dir(), base: base(), path }).then(
      () => (shell.toast.show(t('shell-task.changes.reverted', { path })), void refetch()),
      (e: unknown) => (setGoing(was), failed(e)),
    );
  };
  const changed = (): number => files().filter((f) => f.stage && f.stage !== 'none').length;
  const staged = (): number => files().filter((f) => f.stage === 'staged' || f.stage === 'part').length;
  const onCommit = (message: string): void => {
    const was = going();
    const all = staged() === 0;
    setGoing(
      new Set([
        ...was,
        ...files()
          .filter((f) => f.stage === 'staged' || (all && f.stage === 'stage'))
          .map((f) => f.path),
      ]),
    );
    task.client.run(commit, { key: task.key, dir: dir(), message, all }).then(
      (r) => (shell.toast.show(t('shell-task.changes.committed', { sha: r.sha })), void refetch()),
      (e: unknown) => (setGoing(was), failed(e)),
    );
  };
  const viewedOf = (): string | undefined => {
    const n = files().filter((f) => viewed().has(f.path)).length;
    return n ? t('shell-task.changes.viewedOf', { n, total: files().length }) : undefined;
  };
  return (
    <Show when={files().length > 0} fallback={<ChangesEmpty loading={git.loading} />}>
      <ChangesList
        part={'side.changes panel.changes' as `${string}.${string}`}
        files={files()}
        going={goingHunks()}
        open={isOpen}
        viewed={(p) => viewed().has(p)}
        onToggle={toggle}
        onViewed={(p) => {
          const s = new Set(viewed());
          if (s.has(p)) s.delete(p);
          else s.add(p);
          setViewed(s);
          const o = touch();
          if (s.has(p)) o.delete(p);
          setOpen(o);
        }}
        allOpen={allOpen()}
        onAll={() => setOpen(allOpen() ? new Set<string>() : new Set(files().map((f) => f.path)))}
        onFind={() => shell.palette.open()}
        onEdit={(file) => shell.navigate({ t: 'openSide', side: { kind: 'changes', id: task.key as never, file } })}
        onStage={onStage}
        onHunkStage={onHunkStage}
        onRevertHunk={onRevertHunk}
        fileMenu={(path) => ({
          menu: {
            items: [
              { value: 'revert', label: t('shell-task.changes.revertFile'), icon: 'replay', danger: true },
              { value: 'copy', label: t('shell-task.changes.copyPath'), icon: 'copy' },
            ],
            onSelect: (v: string) => (v === 'revert' ? revertFile(path) : void shell.platform.copy(path)),
          },
        })}
        {...(staging() && changed() > 0
          ? {
              commit: {
                count: staged() ? t('shell-task.changes.staged', { n: staged() }) : t('shell-task.changes.commitsAll', { n: changed() }),
                countTitle: staged() ? t('shell-task.changes.stagedTitle', { n: staged(), total: changed() }) : t('shell-task.changes.allTitle', { n: changed() }),
                placeholder: raw()?.title || t('shell-task.changes.message'),
                onCommit,
              },
            }
          : {})}
        labels={{
          files: (n) => t(n === 1 ? 'shell-task.changes.file' : 'shell-task.changes.files', { n }),
          vs: git() ? t('shell-task.changes.vs', { base: git()?.base ?? base() }) : t('shell-task.changes.seen'),
          vsTitle: git() ? t('shell-task.changes.vsTitle', { base: git()?.base ?? base() }) : t('shell-task.changes.seenTitle'),
          ...(viewedOf() ? { viewedOf: viewedOf() as string } : {}),
          expandAll: t('shell-task.changes.expandAll'),
          collapseAll: t('shell-task.changes.collapseAll'),
          openFile: t('shell-task.changes.openFile'),
          openFileTitle: t('shell-task.changes.openFileTitle'),
          stage: t('shell-task.changes.stage'),
          part: t('shell-task.changes.part'),
          staged: t('shell-task.changes.stagedOne'),
          viewed: t('shell-task.changes.viewed'),
          viewedTitle: (on) => t(on ? 'shell-task.changes.viewedOn' : 'shell-task.changes.viewedOff'),
          edit: t('shell-task.changes.edit'),
          more: t('shell-task.changes.more'),
          line: (n) => t('shell-task.changes.line', { n }),
          revert: t('shell-task.changes.revert'),
          revertTitle: t('shell-task.changes.revertTitle'),
          stageHunk: t('shell-task.changes.stage'),
          unstageHunk: t('shell-task.changes.unstage'),
          unchanged: (n) => t(n === 1 ? 'shell-task.changes.unchangedOne' : 'shell-task.changes.unchanged', { n }),
          commit: t('shell-task.changes.commit'),
          commitPlaceholder: t('shell-task.changes.message'),
        }}
      />
    </Show>
  );
}

/** Nothing changed (or not read yet): one line, as v1's .cx-msg. */
export function ChangesEmpty(props: { readonly loading: boolean }): JSX.Element {
  const shell = useShell();
  return <EmptyState icon="file" title={shell.t(props.loading ? 'shell-task.side.changes.loading' : 'shell-task.side.changes.empty')} compact />;
}
