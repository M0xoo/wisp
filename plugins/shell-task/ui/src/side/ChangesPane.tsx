// The side panel's Changes (v1 features/changes.js, F-page-21/22): git's diff of the task's work since it left its
// base, committed or not, in the kit's ChangesList. In a worktree a file or a hunk is staged or unstaged, what's
// staged is committed (nothing staged: everything changed), and a hunk or a whole file is reverted. Each answers at
// once (design/feedback.md): the toggle flips, the reverted hunk goes, the committed files go; then git's own read
// comes back. A refusal puts it back as it was, with the error. Without git, the edits wisp saw, per file.
import { Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, type JSX } from 'solid-js';
import { defineCommand, entityKey, ownerOf, type EntityKey, type SettingRow } from '@wisp/client';
import { ChangesList, CommentCard, EmptyState, isEnvFile, rowKey, useSignal, type ChangeFile, type ChangeRow, type StageState } from '@wisp/ui';
import { openFinder } from './open-file.ts';
import { added, commentStore, isLine, lineKey, lineLabel, placeOf, waiting } from '../comments.ts';
import { isStub, keepTurnsWhole } from '@wisp/shell';
import { useShell } from '../shell.ts';
import { useTask } from '../task-context.tsx';
import { changesOf, envState, filesOf, relative, revealedOf, seenMasked, setRevealed, type ChangeTurn } from './changes.ts';

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
  /** a .env file's values sent as KEY=•••• */
  readonly masked?: boolean | null;
}
interface GitRead {
  readonly base: string;
  readonly body: { readonly kind: 'inline'; readonly files: readonly GitFileRow[] } | { readonly kind: 'blob' };
}

const read = defineCommand<{ key: EntityKey; path: string; base: string; reveal: readonly string[] }, GitRead | null>({
  id: 'git.changes',
  owner: (a) => a.key,
  wire: (a) => ({ path: a.path, base: a.base, stageState: true, ...(a.reveal.length ? { reveal: [...a.reveal] } : {}) }),
  optimistic: 'none',
  pending: 'the Changes pane',
});
/** Reveal a .env file's captured edits in one turn (ADR-0050): the turn rows carry them masked. */
const unmasked = defineCommand<{ key: EntityKey; turnId: string; file: string }, { readonly edits?: readonly { readonly before: string; readonly after: string }[] }>({
  id: 'runtime.unmasked',
  owner: (a) => a.key,
  wire: (a) => ({ id: a.key.slice(a.key.indexOf(':') + 1), turnId: a.turnId, file: a.file }),
  optimistic: 'none',
  pending: 'the Reveal button, pressed at once; the masked edits stay until the values arrive',
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

type Edits = readonly { readonly before: string; readonly after: string }[];
const shownKey = (turn: string, file: string): string => `${turn}\n${file}`;
type Wt = { baseRef?: string; base?: string; path?: string; cwd?: string };
type Raw = { cwd?: string; title?: string; summary?: { worktree?: Wt | null }; body?: { cwd?: string; ext?: Record<string, Wt | undefined> } };

const stageOf = (f: GitFileRow): StageState => (!f.staged && !f.unstaged ? 'none' : f.staged && !f.unstaged ? 'staged' : f.staged ? 'part' : 'stage');

/** The edits wisp saw (no git), as the list's rows: each hunk's lines, a gap between hunks. A .env file's values read
 *  KEY=•••• under the Reveal line until it's revealed (v1 maskChange; git masks its own rows). */
function seenFiles(turns: readonly ChangeTurn[], id: string, cwd: string, maskOn: boolean, revealed: ReadonlySet<string>, shown: ReadonlyMap<string, Edits>): ChangeFile[] {
  return filesOf(turns, id, cwd, (p) => seenMasked(p, maskOn, revealed), (turn, file) => shown.get(shownKey(turn, file))).map((f) => ({
    path: f.path,
    status: f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'M',
    add: f.additions,
    del: f.deletions,
    binary: f.binary,
    revertable: false,
    ...(maskOn && isEnvFile(f.path) ? { env: revealed.has(f.path) ? ('shown' as const) : ('hidden' as const) } : {}),
    rows: f.hunks.flatMap((h, i) => [...(i ? [{ op: '…', count: 0 }] : []), ...h.lines.map((l) => ({ op: l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ', text: l.text }))]),
  }));
}

export function ChangesPane(): JSX.Element {
  const shell = useShell();
  const task = useTask();
  const t = shell.t;
  // comments on lines (v1 comments.js): the card under a line, the ones waiting for the next follow-up
  const comments = commentStore(task.client);
  const all = useSignal(comments.value);
  // every comment waiting (an answer's too): the numbers are the tray's; the lines' are those with a file
  const list = createMemo(() => waiting(all(), task.key));
  const mine = createMemo(() => list().flatMap((c, k) => (isLine(c) ? [{ ...c, n: k + 1 }] : [])));
  const [draft, setDraft] = createSignal<{ path: string; key: string; at: NonNullable<ReturnType<typeof placeOf>>; note: string } | undefined>();
  const raw = (): Raw | undefined => task.task() as Raw | undefined;
  // the task's worktree: wisp.worktrees' own ext, or the list row's summary (a task from v1's data has it there)
  const wt = (): Wt | undefined => raw()?.body?.ext?.['wisp.worktrees'] ?? raw()?.summary?.worktree ?? undefined;
  const dir = (): string => String(wt()?.path ?? wt()?.cwd ?? raw()?.body?.cwd ?? raw()?.cwd ?? '');
  const base = (): string => wt()?.baseRef || wt()?.base || 'HEAD';
  // .env files shown as they are (v1 Reveal): the button flips at once, git's unmasked read follows
  const [revealed, setRevealedHere] = createSignal(revealedOf(task.id));
  const [git, { refetch }] = createResource(
    () => (dir() ? { path: dir(), base: base(), reveal: [...revealed()] } : undefined),
    (a) => task.client.run(read, { key: task.key, ...a }).catch(() => null),
  );
  // every turn whole while the pane is open: the task's topic sends older turns as stubs, without their edits (v1 #788)
  const turns = useSignal(task.client.entities.list<ChangeTurn>('turn'));
  const whole = task.client.scope.child(`changes:${task.key}`);
  onCleanup(() => whole.dispose());
  keepTurnsWhole({
    scope: whole,
    bare: task.id,
    watch: (topic, sc) => task.client.watch(ownerOf(task.key), topic, sc),
    stubbed: () => turns().some((x) => x.session_id === task.id && isStub(x.body)),
  });
  // Settings → Privacy's Hide .env values (git masks its own rows by it; the edits wisp saw follow it here)
  const maskSetting = useSignal(task.client.entities.row<SettingRow>('setting', entityKey(ownerOf(task.key), 'git.maskEnvFiles')));
  const maskOn = (): boolean => !(maskSetting()?.value === false || maskSetting()?.value === 'off');
  // what you did before git answers again: a toggle flipped, a hunk or file reverted, files committed
  const [flipped, setFlipped] = createSignal(new Map<string, StageState>());
  const [going, setGoing] = createSignal(new Set<string>());
  const [open, setOpen] = createSignal<Set<string> | undefined>(undefined);
  const [viewed, setViewed] = createSignal(new Set<string>());
  const staging = (): boolean => !!wt()?.path || !!wt()?.cwd;
  // Hide: the line says hidden at once; the file's last read was unmasked (no `masked`) until git's masked one lands
  const [hiding, setHiding] = createSignal(new Set<string>());
  createEffect(on(git, () => setHiding(new Set<string>()), { defer: true }));
  const envOf = (f: GitFileRow): 'hidden' | 'shown' | undefined => envState(f, revealed()) ?? (hiding().has(f.path) ? 'hidden' : undefined);
  // what a revealed .env file's edits read unmasked (wisp saw them, no git): read by `files` as it's made
  const [seenShown, setSeenShown] = createSignal<ReadonlyMap<string, Edits>>(new Map());
  const files = createMemo((): ChangeFile[] => {
    const g = git();
    if (!g || g.body.kind !== 'inline') return seenFiles(turns() as readonly ChangeTurn[], task.id, dir(), maskOn(), revealed(), seenShown());
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
        ...(envOf(f) ? { env: envOf(f) as 'hidden' | 'shown' } : {}),
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
  // no git: the edits wisp saw come masked in the turn rows; Reveal asks for each turn's change to that file
  const revealSeen = (path: string, show: boolean): void => {
    const g = git();
    if (g && g.body.kind === 'inline') return;
    const mine = (turns() as readonly ChangeTurn[]).filter((x) => x.session_id === task.id && x.id !== undefined);
    for (const turn of mine) {
      for (const c of changesOf(turn).filter((x) => relative(x.file, dir()) === path)) {
        const k = shownKey(turn.id ?? '', c.file);
        if (!show) {
          const m = new Map(seenShown());
          m.delete(k);
          setSeenShown(m);
          continue;
        }
        task.client.run(unmasked, { key: task.key, turnId: turn.id ?? '', file: c.file }).then(
          (r) => revealed().has(path) && r.edits && setSeenShown(new Map(seenShown()).set(k, r.edits)),
          (e: unknown) => (setRevealedHere(setRevealed(task.id, path, false)), failed(e)),
        );
      }
    }
  };
  const onReveal = (path: string, show: boolean): void => {
    if (!show) setHiding(new Set(hiding()).add(path));
    setRevealedHere(setRevealed(task.id, path, show));
    revealSeen(path, show);
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
        onFind={() =>
          openFinder(
            task.client,
            task.key,
            files().map((f) => f.path),
            {
              placeholder: t('shell-task.files.placeholder'),
              title: t('shell-task.changes.openFile'),
              empty: t('shell-task.files.empty'),
              noGit: t('shell-task.files.noGit'),
              toast: (text) => shell.toast.show(text),
            },
          )
        }
        onEdit={(file) => shell.navigate({ t: 'openSide', side: { kind: 'changes', id: task.key as never, file } })}
        onStage={onStage}
        onHunkStage={onHunkStage}
        onRevertHunk={onRevertHunk}
        onReveal={onReveal}
        comment={{
          label: (o) => t(o.op === '-' ? 'shell-task.comment.onRemoved' : 'shell-task.comment.onLine', { n: (o.op === '-' ? o.a : o.b) ?? 0 }),
          onAdd: (path, o) => {
            const at = placeOf(path, o);
            if (at) setDraft({ path, key: rowKey(o) ?? '', at, note: mine().find((c) => c.file === path && lineKey(c.side, c.line) === rowKey(o))?.note ?? '' });
          },
          marks: (path) => new Map(mine().flatMap((c) => (c.file === path ? [[lineKey(c.side, c.line), c.n] as const] : []))),
          open: draft()
            ? {
                path: draft()?.path ?? '',
                key: draft()?.key ?? '',
                card: (
                  <CommentCard
                    n={(() => {
                      const d = draft();
                      const had = mine().find((c) => d && c.file === d.path && lineKey(c.side, c.line) === d.key);
                      return had ? had.n : list().length + 1;
                    })()}
                    where={draft() ? lineLabel({ file: draft()?.path ?? '', line: draft()?.at.line ?? 0, side: draft()?.at.side ?? 'new' }) : ''}
                    code={draft()?.at.code ?? ''}
                    value={draft()?.note ?? ''}
                    placeholder={t('shell-task.comment.placeholder')}
                    onInput={(v) => {
                      const d = draft();
                      if (d) setDraft({ ...d, note: v });
                    }}
                    onSave={() => {
                      const d = draft();
                      if (!d || !d.note.trim()) return;
                      comments.set((cur) => added(cur, task.key, { ...d.at, note: d.note.trim() }) as never);
                      setDraft(undefined);
                    }}
                    onCancel={() => setDraft(undefined)}
                    labels={{ save: t('shell-task.comment.save'), cancel: t('shell-task.comment.cancel'), hint: t('shell-task.comment.hint') }}
                  />
                ),
              }
            : undefined,
        }}
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
          envHidden: (name) => t('shell-task.changes.envHidden', { name }),
          envShown: (name) => t('shell-task.changes.envShown', { name }),
          reveal: t('shell-task.changes.reveal'),
          hide: t('shell-task.changes.hide'),
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
