// Merge's confirm (v1 ship.js mergePr → ask()): the question names what merges and what happens
// after; warnings are lines under it, never a hold. Red, and *Merge anyway*, only for what's wrong
// with the PR. Driven by the task's merge flow: confirming → merging → idle.

import { createSignal, For, Show, type Accessor, type JSX } from 'solid-js';
import { Button, Dialog, Inline, Stack, Text, useSignal } from '@wisp/ui';
import type { TaskFlows } from './flows.ts';
import { t } from './i18n.ts';
import { mergePlan } from './model/merge.ts';
import type { ReviewContext } from './model/review.ts';
import type { ShipShell } from './shell.ts';
import type { ShipSession } from './types.ts';

export interface MergeAsk {
  /** Asks (opens the confirm here). */
  ask(): void;
  readonly merging: Accessor<boolean>;
  /** The confirm, rendered by whoever asked. */
  readonly Confirm: () => JSX.Element;
}

export function useMerge(flows: TaskFlows, s: Accessor<ShipSession | undefined>, ctx: Accessor<ReviewContext>, shell: ShipShell): MergeAsk {
  const state = useSignal(flows.merge.state);
  // Two places can ask (the row and the pane): the confirm opens by the one that did.
  const [asked, setAsked] = createSignal(false);
  const plan = () => mergePlan(t, s(), ctx());
  const close = (): void => {
    setAsked(false);
    flows.merge.send('cancel');
  };
  const go = (): void => {
    const p = plan();
    // confirm first: closing the dialog may report a close, which must not cancel the merge
    const went = flows.merge.send('confirm');
    setAsked(false);
    if (went && p) shell.toast.show(p.merging);
  };
  const Confirm = (): JSX.Element => (
    <Show when={plan()}>
      {(p) => (
        <Dialog
          open={asked() && state() === 'confirming'}
          onOpenChange={(open) => !open && close()}
          role="alertdialog"
          size="sm"
          title={p().ok}
          part="ship.merge.confirm"
          footer={
            <Inline gap="3" justify="end">
              <Button variant="secondary" size="sm" onClick={close}>{t('wisp.ship.cancel')}</Button>
              <Button variant={p().danger ? 'danger' : 'primary'} size="sm" icon="check" onClick={go} part="ship.merge.go">
                {p().danger ? t('wisp.ship.merge.anyway') : p().ok}
              </Button>
            </Inline>
          }
        >
          <Stack gap="3">
            <Text as="p">{p().question}</Text>
            <For each={p().lines}>{(line) => <Text as="p" size="sm" tone="warn">{line}</Text>}</For>
          </Stack>
        </Dialog>
      )}
    </Show>
  );
  return {
    ask() {
      if (!plan()) return;
      setAsked(true);
      flows.merge.send('ask');
    },
    merging: () => state() === 'merging',
    Confirm,
  };
}
