// Bring in (v1 bring-in.js, copy.md): worktrees another tool left in a project, offered once per
// project. v1 put the line in the launcher for the project picked; here every project with an
// offer has its row, with the same two answers. The row goes at once on either answer.
import { For, Show, type JSX } from 'solid-js';
import { Button, Inline, SettingsGroup, SettingsRow } from '@wisp/ui';
import { offerFacts } from '../format.ts';
import { t } from '../i18n.ts';
import type { Offer } from '../types.ts';

export interface BringInProps {
  readonly offers: readonly Offer[];
  readonly onTake: (o: Offer) => void;
  readonly onSkip: (o: Offer) => void;
}

function OfferRow(props: { readonly o: Offer; readonly on: BringInProps }): JSX.Element {
  const facts = () => offerFacts(props.o);
  // what v1 left to the line's tooltip, in the row's one line; the branches stay in the tooltip
  const line = (): string => [t('worktrees.bring.in', { project: props.o.name }), facts().said, facts().stuck].filter(Boolean).join(' · ');
  return (
    <SettingsRow
      part="worktrees.offer"
      title={t('worktrees.bring.offer', { count: props.o.items.length, from: props.o.from })}
      description={<span title={facts().branches.join('\n')}>{line()}</span>}
      control={
        <Inline gap="2">
          <Button size="sm" variant="ghost" part="worktrees.offer.skip" onClick={() => props.on.onSkip(props.o)}>
            {t('worktrees.bring.skip')}
          </Button>
          <Button size="sm" icon="branch" part="worktrees.offer.take" onClick={() => props.on.onTake(props.o)}>
            {t('worktrees.bring.take')}
          </Button>
        </Inline>
      }
    />
  );
}

export function BringIn(props: BringInProps): JSX.Element {
  return (
    <Show when={props.offers.some((o) => o.items.length > 0)}>
      <SettingsGroup part="worktrees.bring" title={t('worktrees.bring.title')} description={t('worktrees.bring.description')}>
        <For each={props.offers.filter((o) => o.items.length > 0)}>{(o) => <OfferRow o={o} on={props} />}</For>
      </SettingsGroup>
    </Show>
  );
}
