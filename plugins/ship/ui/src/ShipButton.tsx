// Ship it in the open task's bar (v1's `[data-a="ship"]` on the action row): only on a finished
// worktree task with something to ship, named as the menus and ⌘K name it ("Push to PR #412").
// In the bar's icon form the words move to the tooltip; in More it's the same action.

import { Show, type JSX } from 'solid-js';
import type { EntityKey } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { Button, IconButton, useSignal } from '@wisp/ui';
import { t } from './i18n.ts';
import { shipLabel, shippable } from './model/pr.ts';
import { useSession, useShip } from './use.ts';

export default function ShipButton(props: ExtensionProps): JSX.Element {
  const key = props.session?.()?.id as EntityKey | undefined;
  return <Show when={key}>{(k) => <Inner {...props} k={k()} />}</Show>;
}

function Inner(props: ExtensionProps & { readonly k: EntityKey }): JSX.Element {
  const s = useSession(props.client, () => props.k);
  const ship = useShip(props.client, props.k);
  const state = useSignal(ship.flows.ship.state);
  const label = (): string => {
    const row = s();
    return row ? shipLabel(t, row) : t('wisp.ship.action.ship');
  };
  return (
    <Show when={shippable(s(), state() === 'sending')}>
      <Show when={props.form !== 'icon'} fallback={<IconButton icon="send" size="sm" label={label()} onClick={() => ship.openShip(s())} part="split.ship" />}>
        <Button variant="ghost" size="sm" icon="send" onClick={() => ship.openShip(s())} part="split.ship">{label()}</Button>
      </Show>
    </Show>
  );
}
