// A task until the task plugin (shell-task) fills `shell.screen:task`: its title and state, and
// its activity as it streams (the transcript opens at the tail; older pages load on scroll up).
// Lazy: it costs nothing until a task opens.

import { Show, createMemo, onCleanup, type JSX } from 'solid-js';
import { ownerOf, type EntityKey } from '@wisp/client';
import { EmptyState, Heading, Inline, Pill, Stack, Text, VirtualList, useSignal } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { SESSION, type EventRow, type SessionRow } from '../rows.ts';

const label = (e: EventRow): string => e.body.text ?? e.body.label ?? e.kind;

export default function FallbackTask(props: { readonly id: string }): JSX.Element {
  const shell = useShell();
  const key = props.id as EntityKey;
  const row = useSignal(shell.client.entities.row<SessionRow>(SESSION, key));
  const scope = shell.client.scope.child(`task:${key}`);
  onCleanup(() => scope.dispose());
  const peer = ownerOf(key);
  const tr = shell.client.transcripts.open<EventRow>(peer, key, scope);
  const events = useSignal(tr.events);
  const shown = createMemo(() => events().filter((e) => e.kind === 'text' || e.kind === 'tool' || e.kind === 'notice'));
  return (
    <Show when={row()} fallback={<EmptyState icon="info" title={shell.t('shell.fallback.task.missing')} compact />}>
      {(s) => (
        <Stack gap="4" pad="7" grow part="shell.fallback.task">
          <Inline gap="4">
            <Heading level={2} lines={2}>{s().title}</Heading>
            <Pill tone={s().state === 'running' ? 'info' : 'neutral'} live={s().state === 'running'} dot>{shell.t(`shell.state.${s().state}`)}</Pill>
          </Inline>
          <Text tone="muted" size="sm">{shell.t('shell.fallback.task.turns', { count: s().summary.turnCount })}</Text>
          <VirtualList items={shown()} key={(e) => String(e.seq)} anchor="bottom" estimate={48} grow part="shell.fallback.events" aria-label={s().title}>
            {(e) => (
              <Text as="p" tone={e().kind === 'text' ? 'ink' : 'muted'} size={e().kind === 'text' ? 'md' : 'sm'} mono={e().kind === 'tool'}>
                {label(e())}
              </Text>
            )}
          </VirtualList>
        </Stack>
      )}
    </Show>
  );
}
