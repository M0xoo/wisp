// Recent picks: the task, what Auto ran and why, and how it went so far.

import { For, Show, type JSX } from 'solid-js';
import { entityKey, type PluginClient, type SessionId } from '@wisp/client';
import { Heading, Icon, ListRow, Pill, Stack, Text, useSignal } from '@wisp/ui';
import { t } from '../i18n.ts';
import { outcomeOf, typeWord, type Outcome } from '../rules.ts';
import { KIND, type RecentPick, type SessionRow } from '../types.ts';

const TONE: Readonly<Record<Outcome, 'neutral' | 'good' | 'warn' | 'bad'>> = { waiting: 'neutral', worked: 'good', finished: 'neutral', partly: 'warn', failed: 'bad' };

function Row(props: { readonly client: PluginClient; readonly pick: RecentPick }): JSX.Element {
  const row = useSignal(props.client.entities.row<SessionRow>(KIND.session, entityKey(props.client.home, props.pick.id)));
  const out = (): Outcome => outcomeOf(props.pick.r);
  const sub = (): string => [props.pick.label ?? props.pick.key, typeWord(props.pick.type), props.pick.trying ? t('wisp.router.learned.trying') : props.pick.explored ? t('wisp.router.learned.exploring') : ''].filter(Boolean).join(' · ');
  return (
    <ListRow
      part="router.recent"
      title={row()?.title ?? t('wisp.router.learned.task')}
      lead={<Icon name="agent" />}
      sub={<Text size="sm" tone="muted" truncate>{sub()}</Text>}
      pills={<Pill tone={TONE[out()]}>{t(`wisp.router.outcome.${out()}`)}</Pill>}
      onOpen={() => props.client.navigate({ t: 'openTask', id: entityKey(props.client.home, props.pick.id) as string as SessionId })}
    />
  );
}

export function RecentPicks(props: { readonly client: PluginClient; readonly recent: readonly RecentPick[] }): JSX.Element {
  return (
    <Stack gap="2" part="router.recents">
      <Heading level={4} size="sm">
        {t('wisp.router.learned.recent')}
      </Heading>
      <Show when={props.recent.length > 0} fallback={<Text tone="muted">{t('wisp.router.learned.recent-empty')}</Text>}>
        <Stack gap="1">
          <For each={props.recent}>{(p) => <Row client={props.client} pick={p} />}</For>
        </Stack>
      </Show>
    </Stack>
  );
}
