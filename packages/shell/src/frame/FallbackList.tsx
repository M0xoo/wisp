// The list the shell shows until a list plugin (shell-list) fills `shell.sidebar:list`: every
// task not archived, newest first, as kit rows in a VirtualList (one row repaints per patch; 5k rows
// scroll with no long tasks). Selecting follows the open task; the row the keyboard is on is the
// shell's selection.

import { Show, createMemo, type JSX } from 'solid-js';
import { byKeys, filterBy, sortBy, type EntityKey } from '@wisp/client';
import type { Tone } from '@wisp/tokens';
import { EmptyState, ListRow, Pill, Time, VirtualList, useSignal } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { useNow } from '../clock.ts';
import { SESSION, type SessionRow } from '../rows.ts';

const TONE: Record<string, Tone> = { running: 'info', review: 'warn', done: 'good', error: 'bad' };

export function FallbackList(): JSX.Element {
  const shell = useShell();
  const rows = sortBy(filterBy(shell.client.entities.list<SessionRow>(SESSION), (s) => !s.archived), byKeys<SessionRow>({ of: (s) => s.updatedAt, desc: true }));
  const list = useSignal(rows);
  const nav = useSignal(shell.nav);
  const open = createMemo(() => {
    const m = nav().main;
    return m.kind === 'task' ? m.id : undefined;
  });
  const selected = useSignal(() => shell.selection.get());
  const now = useNow(shell.client);
  return (
    <Show when={list().length > 0} fallback={<EmptyList />}>
    <VirtualList
      items={list()}
      key={(s) => s.id}
      estimate={56}
      grow
      part="shell.fallback.list"
      aria-label={shell.t('shell.list')}
    >
      {(s) => (
        <ListRow
          part="shell.fallback.row"
          title={s().title}
          sub={s().live || s().preview}
          pills={<Pill tone={TONE[s().state] ?? 'neutral'} dot live={s().state === 'running'}>{shell.t(`shell.state.${s().state}`)}</Pill>}
          time={<Time at={s().updatedAt} now={now()} layout="column" />}
          current={open() === s().id}
          selected={selected() === s().id}
          onOpen={() => {
            shell.selection.set(s().id);
            shell.navigate({ t: 'openTask', id: s().id as EntityKey as never });
          }}
        />
      )}
    </VirtualList>
    </Show>
  );
}

export function EmptyList(): JSX.Element {
  const shell = useShell();
  return <EmptyState icon="feed" title={shell.t('shell.fallback.list.empty')} compact />;
}
