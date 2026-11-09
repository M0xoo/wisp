// The side panel beside the open task (v1 features/panel.js). Changes: every file the task changed, with its
// diff, from the task's turns. Shell, PR and Watch aren't built yet; the shell shows its own note for them.
import { Show, createMemo, type JSX } from 'solid-js';
import { Diff, EmptyState, Inline, Stack, Text, useSignal } from '@wisp/ui';
import type { SidePane } from '../open-task.ts';
import { useShell } from '../shell.ts';
import { useTask } from '../task-context.tsx';
import { filesOf, type ChangeTurn } from './changes.ts';

function Changes(): JSX.Element {
  const shell = useShell();
  const task = useTask();
  const t = shell.t;
  const turns = useSignal(task.client.entities.list<ChangeTurn>('turn'));
  const cwd = (): string => String((task.task() as { cwd?: string; body?: { cwd?: string } } | undefined)?.body?.cwd ?? (task.task() as { cwd?: string } | undefined)?.cwd ?? '');
  const files = createMemo(() => filesOf(turns() as readonly ChangeTurn[], task.id, cwd()));
  const totals = createMemo(() => files().reduce((n, f) => ({ add: n.add + f.additions, del: n.del + f.deletions }), { add: 0, del: 0 }));
  return (
    <Stack gap="3" part="side.changes" grow>
      <Inline gap="2" align="center">
        <Text weight="medium">{t('shell-task.side.changes.title')}</Text>
        <Show when={files().length > 0}>
          <Text size="sm" tone="muted" numeric nowrap>
            {t('shell-task.side.changes.count', { count: files().length, add: totals().add, del: totals().del })}
          </Text>
        </Show>
      </Inline>
      <Show when={files().length > 0} fallback={<EmptyState icon="file" title={t('shell-task.side.changes.empty')} compact />}>
        <Diff files={files()} />
      </Show>
    </Stack>
  );
}

export function SidePanel(props: { readonly pane: SidePane }): JSX.Element {
  return (
    <Show when={props.pane === 'changes'}>
      <Changes />
    </Show>
  );
}
