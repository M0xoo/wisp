// A ship in flight on the task's row (v1 ship.js renderShipRun): the stages as a track that fills
// in as the peer reports them. Keyed by stage, so a new stage moves nothing and replays nothing. A
// failure stays here with Retry (the dialog again, with what was typed) and Dismiss.

import { Index, Show, type JSX } from 'solid-js';
import { Card, Icon, Inline, Pill, Stack, Text, Toolbar, type ToolbarItem } from '@wisp/ui';
import { t } from './i18n.ts';
import { stepLabel, type Track } from './model/ship.ts';

const STEP_TONE = { done: 'good', current: 'accent', pending: 'neutral', failed: 'bad' } as const;
const STEP_ICON = { done: 'check', failed: 'x' } as const;

export function ShipRun(props: { readonly track: Track; readonly onRetry: () => void; readonly onDismiss: () => void }): JSX.Element {
  const items = (): ToolbarItem[] => [
    { id: 'retry', icon: 'replay', label: t('wisp.ship.run.retry'), priority: 'pin', onSelect: props.onRetry },
    { id: 'dismiss', icon: 'x', label: t('wisp.ship.run.dismiss'), priority: 1, onSelect: props.onDismiss },
  ];
  return (
    <Card part="pr.strip" tone={props.track.failed ? 'bad' : 'accent'} pad="4">
      <Stack gap="3">
        <Inline gap="3">
          <Icon name="send" size="md" tone={props.track.failed ? 'bad' : 'accent-ink'} />
          <Text part="ship.run.what" truncate title={props.track.what} tone={props.track.failed ? 'bad' : 'ink'}>
            {props.track.what}
          </Text>
        </Inline>
        <Inline gap="2" part="ship.track" aria-label={t('wisp.ship.run.stages')}>
          {/* by position: a stage that moves on updates its pill in place */}
          <Index each={props.track.steps}>
            {(s) => (
              <Pill part="ship.track.step" tone={STEP_TONE[s().status]} dot={s().status === 'current'} live={s().status === 'current'} {...(s().status === 'done' || s().status === 'failed' ? { icon: STEP_ICON[s().status as 'done' | 'failed'] } : {})}>
                {stepLabel(t, s().step)}
              </Pill>
            )}
          </Index>
        </Inline>
        <Show when={props.track.failed}>
          <Toolbar aria-label={t('wisp.ship.run.actions')} items={items()} compact part="ship.run.bar" />
        </Show>
      </Stack>
    </Card>
  );
}
