// `shell-task.foot`: over the reply box, what waits on you (v1 turns.js renderAskCard, the queue under the
// composer): the agent's question with its choices (or a tool's Allow / Always / Deny), then the queued
// follow-ups with Send now and Remove. Each control answers at once (design/feedback.md): the card goes, the
// item goes; a refusal brings it back with the shell's toast.
import { For, Show, createMemo, type JSX } from 'solid-js';
import { defineCommand, type EntityKey } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { Box, Button, IconButton, Inline, Stack, Text, Wrap, useSignal } from '@wisp/ui';
import { useShell } from '../shell.ts';
import { keyOf } from '../open-task.ts';
import { KIND } from '../types.ts';
import { askOf, queueOf } from './model.ts';

const bare = (key: string): string => key.slice(key.indexOf(':') + 1);
const askPath = '/body/ext/wisp.runtime/ask';

/** runtime.answer: the question's answer (a choice, typed text, allow / always / deny). */
const answer = defineCommand<{ key: EntityKey; id: string; text: string }>({
  id: 'runtime.answer',
  owner: (a) => a.key,
  optimistic: (_b, a) => [{ e: KIND.session, id: a.key, op: 'patch', ops: [{ op: 'replace', path: askPath, value: null }] }],
});
/** runtime.queue.sendNow: a queued follow-up goes now (the turn running is stopped for it). */
const sendNow = defineCommand<{ key: EntityKey; id: string; itemId: string }>({ id: 'runtime.queue.sendNow', owner: (a) => a.key, optimistic: 'none', pending: 'the Send now control' });
/** runtime.queue.edit: the queue as it should be (an item removed). */
const editQueue = defineCommand<{ key: EntityKey; id: string; items: readonly unknown[] }>({
  id: 'runtime.queue.edit',
  owner: (a) => a.key,
  optimistic: (_b, a) => [{ e: KIND.session, id: a.key, op: 'patch', ops: [{ op: 'replace', path: '/body/queue', value: a.items }] }],
});

export default function TaskFoot(props: ExtensionProps): JSX.Element {
  const shell = useShell();
  const t = shell.t;
  const key = (): EntityKey | undefined => {
    const id = props.id ?? props.session?.()?.id;
    return id ? (keyOf(shell.client, id) as EntityKey | undefined) : undefined;
  };
  const row = createMemo(() => {
    const k = key();
    return k ? useSignal(props.client.entities.row<unknown>(KIND.session, k)) : () => undefined;
  });
  const ask = createMemo(() => askOf(row()()));
  const queue = createMemo(() => queueOf(row()()));
  const raw = (): readonly unknown[] => ((row()() as { body?: { queue?: readonly unknown[] } } | undefined)?.body?.queue ?? []);
  const reply = (text: string): void => {
    const k = key();
    if (k) void props.client.run(answer, { key: k, id: bare(k), text }).catch(() => undefined);
  };
  return (
    <Stack gap="2" part="task.foot">
      <Show when={ask()}>
        {(a) => (
          <Box part="task.ask" pad="3" radius="md" border="line" surface="surface" aria-label={t('shell-task.ask.label')}>
            <Stack gap="2">
              <Text size="sm" tone="muted">
                {t(a().approval ? 'shell-task.ask.approval' : 'shell-task.ask.needs')}
              </Text>
              <Text weight="medium">{a().question}</Text>
              <Wrap gap="2">
                <Show
                  when={a().approval}
                  fallback={<For each={a().options}>{(o, i) => <Button size="sm" variant={i() === 0 ? 'primary' : 'secondary'} onClick={() => reply(o)}>{o}</Button>}</For>}
                >
                  <Button size="sm" variant="primary" onClick={() => reply('allow')}>{t('shell-task.ask.allow')}</Button>
                  <Button size="sm" variant="secondary" onClick={() => reply('always')}>{t('shell-task.ask.always')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => reply('deny')}>{t('shell-task.ask.deny')}</Button>
                </Show>
              </Wrap>
              <Show when={!a().approval}>
                <Text size="sm" tone="muted">{t('shell-task.ask.orType')}</Text>
              </Show>
            </Stack>
          </Box>
        )}
      </Show>
      <Show when={queue().length > 0}>
        <Stack gap="1" part="task.queue">
          <Text size="sm" tone="muted">{t('shell-task.queue.title', { count: queue().length })}</Text>
          <For each={queue()}>
            {(q) => (
              <Inline gap="2" align="center" part="task.queue.item">
                <Box grow>
                  <Text size="sm" truncate title={q.text}>{q.text}</Text>
                </Box>
                <Button size="xs" variant="ghost" onClick={() => { const k = key(); if (k) void props.client.run(sendNow, { key: k, id: bare(k), itemId: q.id }).catch(() => undefined); }}>
                  {t('shell-task.queue.now')}
                </Button>
                <IconButton icon="x" size="sm" label={t('shell-task.queue.remove')} onClick={() => { const k = key(); if (k) void props.client.run(editQueue, { key: k, id: bare(k), items: raw().filter((x) => (x as { id?: string }).id !== q.id) }).catch(() => undefined); }} />
              </Inline>
            )}
          </For>
        </Stack>
      </Show>
    </Stack>
  );
}
