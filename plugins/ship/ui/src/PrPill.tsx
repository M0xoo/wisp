// A task row's PR pill (v1 ship.js prPill / shipPill): `● #412` in the PR's tone, the line in its
// tooltip; a tap opens the side panel on PR beside the task. While a ship is in flight the row says
// Shipping instead, with the stage in its tooltip.

import { Match, Switch, type JSX } from 'solid-js';
import type { EntityKey } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { Pill, ToneChip } from '@wisp/ui';
import { t } from './i18n.ts';
import { pillTitle, prOf, prTone } from './model/pr.ts';
import { TONE } from './tones.ts';
import { useSession, useShip } from './use.ts';

const DOING = { commit: 'wisp.ship.doing.commit', push: 'wisp.ship.doing.push', pr: 'wisp.ship.doing.pr', start: 'wisp.ship.doing.start' } as const;

export default function PrPill(props: ExtensionProps): JSX.Element {
  const key = (): EntityKey | undefined => (props.id ?? props.session?.()?.id) as EntityKey | undefined;
  const s = useSession(props.client, key);
  const k = key();
  const opener = k ? useShip(props.client, k) : undefined; // a row's task never changes under it
  return (
    <Switch>
      <Match when={s()?.shipping}>
        {(sh) => (
          <Pill part="card.ship" tone="accent" dot live title={t('wisp.ship.pill.shipping', { what: t(DOING[sh().step]), repo: sh().repo ? ` ${sh().repo}` : '' })}>
            {t('wisp.ship.pill.shippingLabel')}
          </Pill>
        )}
      </Match>
      <Match when={prOf(s())}>
        {(pr) => (
          <ToneChip
            part="card.pr"
            label={`#${pr().number}`}
            tone={TONE[prTone(pr(), s()?.pr ? s()?.conflictFix : undefined)]}
            live={!!pr().checks?.pending && pr().state === 'OPEN'}
            title={pillTitle(t, pr(), s()?.pr ? s()?.conflictFix : undefined)}
            onClick={() => opener?.openPane()}
          />
        )}
      </Match>
    </Switch>
  );
}
