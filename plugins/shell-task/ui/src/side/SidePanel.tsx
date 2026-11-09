// The side panel beside the open task (v1 features/panel.js): its head (Changes · PR · Shell, then close) and
// the pane. Changes: every file the work changed since it left its base, committed or not, from git
// (`git.changes`, the worktree's base, else HEAD); a folder that isn't a repo shows the turns' own edits.
import { Show, createMemo, createResource, type JSX } from 'solid-js';
import { defineCommand, type EntityKey } from '@wisp/client';
import { Box, Diff, EmptyState, IconButton, Inline, Stack, Tabs, Text, useSignal } from '@wisp/ui';
import type { SidePane } from '../open-task.ts';
import { useShell } from '../shell.ts';
import { useTask } from '../task-context.tsx';
import { filesOf, gitFiles, type ChangeTurn, type GitChanges } from './changes.ts';

/** wisp-git's read: the work's diff since `base` (its peer is the task's). */
const gitChanges = defineCommand<{ key: EntityKey; path: string; base: string }, GitChanges>({ id: 'git.changes', owner: (a) => a.key, optimistic: 'none', pending: 'the Changes pane' });

type Raw = { cwd?: string; body?: { cwd?: string; ext?: Record<string, { baseRef?: string; base?: string; path?: string } | undefined> } };

function Changes(): JSX.Element {
  const shell = useShell();
  const task = useTask();
  const t = shell.t;
  const raw = (): Raw | undefined => task.task() as Raw | undefined;
  const cwd = (): string => String(raw()?.body?.ext?.['wisp.worktrees']?.path ?? raw()?.body?.cwd ?? raw()?.cwd ?? '');
  const base = (): string => {
    const w = raw()?.body?.ext?.['wisp.worktrees'];
    return w?.baseRef || w?.base || 'HEAD';
  };
  const [git] = createResource(
    () => (cwd() ? { path: cwd(), base: base() } : undefined),
    (a) => task.client.run(gitChanges, { key: task.key, ...a }).catch(() => undefined),
  );
  const turns = useSignal(task.client.entities.list<ChangeTurn>('turn'));
  // git when it answered; the turns' own edits when it can't (not a repo, a peer without git)
  const files = createMemo(() => {
    const g = git();
    return (g && gitFiles(g)) ?? filesOf(turns() as readonly ChangeTurn[], task.id, cwd());
  });
  const totals = createMemo(() => files().reduce((n, f) => ({ add: n.add + f.additions, del: n.del + f.deletions }), { add: 0, del: 0 }));
  return (
    <Stack gap="3" part="side.changes" grow>
      <Show when={files().length > 0}>
        <Text size="sm" tone="muted" numeric nowrap>
          {t(git() ? 'shell-task.side.changes.vs' : 'shell-task.side.changes.count', { count: files().length, add: totals().add, del: totals().del, base: git()?.base ?? '' })}
        </Text>
      </Show>
      <Show when={files().length > 0} fallback={<EmptyState icon="file" title={t(git.loading ? 'shell-task.side.changes.loading' : 'shell-task.side.changes.empty')} compact />}>
        <Diff files={files()} />
      </Show>
    </Stack>
  );
}

const PANES: readonly SidePane[] = ['changes', 'pr', 'shell'];

export function SidePanel(props: { readonly pane: SidePane }): JSX.Element {
  const shell = useShell();
  const task = useTask();
  const t = shell.t;
  const open = (pane: string): void => {
    if (pane === 'changes' || pane === 'pr' || pane === 'shell') shell.navigate({ t: 'openSide', side: { kind: pane, id: task.key as never } });
  };
  return (
    <Stack gap="4" part="side.panel" grow>
      <Inline gap="2" align="center" part="side.head">
        <Tabs variant="pill" aria-label={t('shell-task.side.label')} value={props.pane} onChange={open} items={PANES.map((p) => ({ value: p, label: t(`shell-task.side.${p}`), icon: p === 'changes' ? 'file' : p === 'pr' ? 'merge' : 'terminal' }))} />
        <Box grow />
        <IconButton icon="x" size="sm" label={t('shell-task.side.close')} onClick={() => shell.navigate({ t: 'closeSide' })} />
      </Inline>
      <Show when={props.pane === 'changes'} fallback={<EmptyState icon="panel" title={t('shell-task.side.later')} compact />}>
        <Changes />
      </Show>
    </Stack>
  );
}
