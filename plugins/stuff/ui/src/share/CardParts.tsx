// The share card's two faces: locked (the passkey box) and open (who, what, what runs it here, what
// importing adds, and the hint that Enter imports it).

import { Button, Checkbox, Icon, Inline, Input, Link, Stack, Text } from '@wisp/ui';
import { createSignal, Show, type JSX } from 'solid-js';
import { cardFacts, whoOf, type CardChoice, type T } from './model.ts';
import type { ShareCardInfo } from './types.ts';

export function LockedBody(props: { t: T; card: ShareCardInfo | undefined; busy: boolean; onUnlock: (passkey: string) => void }): JSX.Element {
  const t = props.t;
  const [passkey, setPasskey] = createSignal('');
  const go = (): void => props.onUnlock(passkey());
  return (
    <Stack part="share.card.locked" gap="2" grow>
      <Text weight="medium" truncate>
        {t('stuff.share.card.locked', { who: whoOf(t, props.card) })}
      </Text>
      <Text size="sm" tone="muted">
        {props.card?.wrong ? t('stuff.share.card.wrong') : t('stuff.share.card.typePasskey')}
      </Text>
      <Inline gap="2">
        <Input type="password" aria-label={t('stuff.share.passkey')} placeholder={t('stuff.share.passkey')} autocomplete="off" autofocus value={passkey()} onInput={setPasskey} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), go())} />
        <Button size="sm" icon="lock" loading={props.busy} onClick={go}>
          {t('stuff.share.card.unlock')}
        </Button>
      </Inline>
    </Stack>
  );
}

const runWords = (c: ShareCardInfo, r: NonNullable<ShareCardInfo['run']>): string => [r.agent, r.model].filter(Boolean).join(' · ') || c.agent || '';

export function OpenBody(props: { t: T; card: ShareCardInfo; choice: CardChoice; onChoice: (c: CardChoice) => void; onOpen: (id: string) => void }): JSX.Element {
  const t = props.t;
  const c = (): ShareCardInfo => props.card;
  const r = (): ShareCardInfo['run'] => props.choice.run ?? c().run;
  return (
    <Stack part="share.card.open" gap="1" grow>
      <Inline gap="1">
        <Text size="sm" tone="muted" nowrap>
          {t('stuff.share.card.shared', { who: whoOf(t, c()) })}
        </Text>
        <Show when={c().locked}>
          <Icon name="lock" size="sm" tone="muted" label={t('stuff.share.card.withPasskey')} />
        </Show>
      </Inline>
      <Text part="share.card.title" weight="medium" truncate title={c().title ?? ''}>
        {c().title ?? ''}
      </Text>
      <Text size="sm" tone="muted" truncate title={cardFacts(t, c())}>
        {cardFacts(t, c())}
      </Text>
      <Text size="sm" truncate>
        {(() => {
          const run = r();
          return run ? t('stuff.share.card.carriesOn', { run: runWords(c(), run) }) : t('stuff.share.card.noAgentHere');
        })()}
      </Text>
      <Show when={!props.choice.run && c().run?.note}>
        {(note) => (
          <Text size="sm" tone="muted">
            {note()}
          </Text>
        )}
      </Show>
      <Checks t={t} card={c()} choice={props.choice} onChoice={props.onChoice} />
      <Show when={c().imported}>
        {(id) => (
          <Inline gap="1">
            <Text size="sm" tone="muted" nowrap>
              {t('stuff.share.card.importedBefore')}
            </Text>
            <Link href="#" tone="accent" onClick={(e) => (e.preventDefault(), props.onOpen(id()))}>
              {t('stuff.share.card.openIt')}
            </Link>
          </Inline>
        )}
      </Show>
      <Text size="sm" tone="faint">
        {t('stuff.share.card.hint')}
      </Text>
    </Stack>
  );
}

function Checks(props: { t: T; card: ShareCardInfo; choice: CardChoice; onChoice: (c: CardChoice) => void }): JSX.Element {
  const t = props.t;
  return (
    <>
      <Show when={props.card.newConnectors?.length}>
        <Stack gap="0">
          <Checkbox label={t('stuff.share.card.addConnectors')} checked={props.choice.connectors} onChange={(v) => props.onChoice({ ...props.choice, connectors: v })} />
          <Text size="sm" tone="muted">
            {t('stuff.share.card.addConnectorsHint', { names: (props.card.newConnectors ?? []).join(', ') })}
          </Text>
        </Stack>
      </Show>
      <Show when={props.card.newCrew?.length}>
        <Stack gap="0">
          <Checkbox label={t('stuff.share.card.addCrew', { names: (props.card.newCrew ?? []).join(', ') })} checked={props.choice.crew} onChange={(v) => props.onChoice({ ...props.choice, crew: v })} />
          <Text size="sm" tone="muted">
            {t('stuff.share.card.addCrewHint', { count: props.card.newCrew?.length ?? 0 })}
          </Text>
        </Stack>
      </Show>
    </>
  );
}
