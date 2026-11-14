// Under a turn (`shell.turn:foot`, the turn's key as its id): the crew members asked on it and their answers (v1
// btw.js crew entries). Each shows who, what you asked and what they said (working… meanwhile); Reply carries the
// same job on, and its answer lands right under it. Nothing shows on a turn nobody was asked on.
import { createSignal, For, Show, type JSX } from 'solid-js';
import { defineCommand, ownerOf, type EntityKey } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { Button, Card, Face, Inline, Input, Markdown, Stack, Text, useSignal } from '@wisp/ui';
import { answersOf, isReply, type CrewAnswer } from './answers.ts';
import { crewData } from './data.ts';
import { t } from './i18n.ts';

const bare = (k: string): string => k.slice(k.indexOf(':') + 1);

export const replyTo = defineCommand<{ task: EntityKey; entry: string; text: string }, CrewAnswer>({
  id: 'crew.reply',
  owner: (a) => a.task,
  wire: (a) => ({ sessionId: bare(a.task), entry: a.entry, text: a.text }),
  optimistic: 'none',
  pending: 'the reply box under the answer, cleared at once',
});

function Entry(props: { readonly a: CrewAnswer; readonly avatar: string; readonly color?: string; readonly onReply: (text: string) => void }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [text, setText] = createSignal('');
  const send = (): void => {
    const v = text().trim();
    if (!v) return;
    setText('');
    setOpen(false);
    props.onReply(v);
  };
  return (
    <Stack gap="1" part="crew.answer">
      <Show when={!isReply(props.a)}>
        <Inline gap="2">
          <Face avatar={props.avatar} name={props.a.member} {...(props.color !== undefined && { color: props.color })} size="xs" mood={props.a.status === 'running' ? 'live' : 'idle'} />
          <Text size="sm" weight="semibold">
            {props.a.member}
          </Text>
        </Inline>
      </Show>
      <Text size="sm" tone="muted">
        {props.a.question}
      </Text>
      <Show
        when={props.a.status !== 'running'}
        fallback={
          <Text size="sm" tone="faint">
            {t('wisp.crew.answer.working')}
          </Text>
        }
      >
        <Show
          when={props.a.status === 'done'}
          fallback={
            <Text size="sm" tone="bad">
              {props.a.answer || t('wisp.crew.answer.failed')}
            </Text>
          }
        >
          <Markdown source={props.a.answer || t('wisp.crew.answer.empty')} />
        </Show>
      </Show>
      <Show
        when={open()}
        fallback={
          <Show when={props.a.status !== 'running' && props.a.job}>
            <span>
              <Button size="sm" variant="ghost" icon="comment" onClick={() => setOpen(true)}>
                {t('wisp.crew.answer.reply')}
              </Button>
            </span>
          </Show>
        }
      >
        <Inline gap="2" part="crew.answer.box">
          <Input
            size="sm"
            value={text()}
            onInput={setText}
            onKeyDown={(e) => e.key === 'Enter' && !e.isComposing && (e.preventDefault(), send())}
            placeholder={t('wisp.crew.answer.replyPlaceholder')}
            aria-label={t('wisp.crew.answer.reply')}
          />
          <Button size="sm" variant="primary" disabled={!text().trim()} onClick={send}>
            {t('wisp.crew.answer.send')}
          </Button>
        </Inline>
      </Show>
    </Stack>
  );
}

export default function Answers(props: ExtensionProps): JSX.Element {
  const c = props.client;
  const turnKey = (props.id ?? '') as EntityKey;
  const row = useSignal(c.entities.row<unknown>('turn', turnKey));
  const members = useSignal(crewData(c).members);
  const list = (): readonly CrewAnswer[] => answersOf(row());
  const face = (id: string): { avatar: string; color?: string } => {
    const m = members().find((x) => x.id === id);
    return { avatar: m?.avatar ?? '', ...(m?.color && { color: m.color }) };
  };
  const task = (): EntityKey => `${ownerOf(turnKey)}:${bare(String(props.session?.()?.id ?? ''))}` as EntityKey;
  return (
    <Show when={list().length > 0}>
      <Card part="crew.answers" pad="5" as="section" aria-label={t('wisp.crew.answer.title')}>
        <Stack gap="3">
          <For each={list()}>{(a) => <Entry a={a} {...face(a.crew)} onReply={(text) => void c.run(replyTo, { task: task(), entry: a.id, text }).catch(() => undefined)} />}</For>
        </Stack>
      </Card>
    </Show>
  );
}
