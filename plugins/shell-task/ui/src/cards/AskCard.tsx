// The agent's live question or a tool's approval over the reply box (v1 turns.js renderAskCard): Needs you,
// answered here with a choice, Allow / Always / Deny, or typed text below. The card goes at once on an answer.
import { For, Show, type JSX } from 'solid-js';
import { Box, Button, Stack, Text, Wrap } from '@wisp/ui';
import type { Ask } from '../foot/model.ts';

export function AskCard(props: { readonly ask: Ask; readonly t: (k: string) => string; readonly onAnswer: (text: string) => void }): JSX.Element {
  const t = props.t;
  return (
    <Box part="task.ask" pad="3" radius="md" border="line" surface="surface" aria-label={t('shell-task.ask.label')}>
      <Stack gap="2">
        <Text size="sm" tone="muted">
          {t(props.ask.approval ? 'shell-task.ask.approval' : 'shell-task.ask.needs')}
        </Text>
        <Text weight="medium">{props.ask.question}</Text>
        <Wrap gap="2">
          <Show
            when={props.ask.approval}
            fallback={
              <For each={props.ask.options}>
                {(o, i) => (
                  <Button size="sm" variant={i() === 0 ? 'primary' : 'secondary'} onClick={() => props.onAnswer(o)}>
                    {o}
                  </Button>
                )}
              </For>
            }
          >
            <Button size="sm" variant="primary" onClick={() => props.onAnswer('allow')}>
              {t('shell-task.ask.allow')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => props.onAnswer('always')}>
              {t('shell-task.ask.always')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => props.onAnswer('deny')}>
              {t('shell-task.ask.deny')}
            </Button>
          </Show>
        </Wrap>
        <Show when={!props.ask.approval}>
          <Text size="sm" tone="muted">
            {t('shell-task.ask.orType')}
          </Text>
        </Show>
      </Stack>
    </Box>
  );
}
