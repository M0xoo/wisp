// `shell-task.foot`: over the reply box, what waits on you (v1 turns.js renderAskCard, the queue under the
// composer): the agent's question with its choices (or a tool's Allow / Always / Deny). The queued follow-ups
// under it are shell-composer's extension in the same slot (edit, combine, move, send now, cancel). Each control
// answers at once (design/feedback.md); a refusal brings it back with the shell's toast.
import { For, Show, createMemo, type JSX } from 'solid-js';
import { defineCommand, type EntityKey } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { Box, Button, Stack, Text, Wrap, useSignal } from '@wisp/ui';
import { useShell } from '../shell.ts';
import { keyOf } from '../open-task.ts';
import { KIND } from '../types.ts';
import { askOf } from './model.ts';

const bare = (key: string): string => key.slice(key.indexOf(':') + 1);
const askPath = '/body/ext/wisp.runtime/ask';

/** runtime.answer: the question's answer (a choice, typed text, allow / always / deny). */
const answer = defineCommand<{ key: EntityKey; id: string; text: string }>({
  id: 'runtime.answer',
  owner: (a) => a.key,
  optimistic: (_b, a) => [{ e: KIND.session, id: a.key, op: 'patch', ops: [{ op: 'replace', path: askPath, value: null }] }],
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
    </Stack>
  );
}
