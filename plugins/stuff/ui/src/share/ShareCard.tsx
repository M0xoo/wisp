// A share link pasted in New task's box shows as a card above it (v1 shareCard): who shared it,
// what it carries and what runs it here. Enter imports it, and whatever else was typed is its first
// follow-up. The card reads the box from the drafts store (New task's draft, `<home>:launcher` →
// text) and leaves what Send should do in the same draft (`share`): the import's body, or why it
// can't go yet. × leaves the link as text.

import { entityKey, type Json, type PluginClient } from '@wisp/client';
import { Avatar, Card, IconButton, Icon, Inline, Skeleton, Stack, Text, useSignal } from '@wisp/ui';
import { createEffect, createSignal, on, Show, type JSX } from 'solid-js';
import { cardMachine, type CardCtx, type CardState } from './card-machine.ts';
import { sharePeek } from './commands.ts';
import { LockedBody, OpenBody } from './CardParts.tsx';
import { launcherKey, SHARE_FIELD, TEXT_FIELD } from './launcher.ts';
import { shareLinkIn } from './link.ts';
import { takeImport, type CardChoice } from './model.ts';


// size-ok: the card's wiring: the box, the flow, the choices and what Send reads
export default function ShareCard(props: { client: PluginClient }): JSX.Element {
  const c = props.client;
  const t = (k: string, v?: Readonly<Record<string, string | number>>): string => c.t(k, v);
  const key = launcherKey(c);
  const text = useSignal(c.drafts.get<string>(key, TEXT_FIELD));
  const ctx: CardCtx = { link: '', passkey: '', card: undefined, error: '', peek: (url, passkey) => c.run(sharePeek, { home: c.home, url, ...(passkey && { passkey }) }) };
  const flow = c.machine(cardMachine, ctx);
  const state = useSignal(flow.state);
  const [dismissed, setDismissed] = createSignal('');
  const [choice, setChoice] = createSignal<CardChoice>({ passkey: '', run: null, connectors: true, crew: true });

  // Reads the box as you type: a new link shows its card, a link taken out takes it away.
  createEffect(
    on(text, (value) => {
      const found = shareLinkIn(value);
      if (found === ctx.link) return;
      ctx.link = found;
      ctx.card = undefined;
      ctx.passkey = '';
      ctx.error = '';
      setChoice({ passkey: '', run: null, connectors: true, crew: true });
      flow.send(!found || found === dismissed() ? 'clear' : 'link');
    }),
  );
  // What Send does with the box: import this, or the reason it can't yet (the launcher says it).
  createEffect(() => {
    const s = state();
    if (s === 'off') return c.drafts.set(key, SHARE_FIELD, undefined);
    const take = takeImport(s === 'unlocking' ? 'loading' : s, ctx.card, ctx.error, ctx.link, text() ?? '', choice());
    c.drafts.set(key, SHARE_FIELD, take as unknown as Json);
  });

  const dismiss = (): void => {
    setDismissed(ctx.link);
    flow.send('clear');
  };
  const unlock = (passkey: string): void => {
    if (!passkey) return;
    ctx.passkey = passkey;
    setChoice((x) => ({ ...x, passkey }));
    flow.send('unlock');
  };
  const x = (): JSX.Element => <IconButton part="share.card.dismiss" icon="x" size="sm" label={t('stuff.share.card.dismiss')} onClick={dismiss} />;
  const face = (): JSX.Element => <Avatar name={ctx.card?.from?.name || ctx.card?.from?.handle || '?'} {...(ctx.card?.from?.avatar && { src: ctx.card.from.avatar })} size="md" />;

  return (
    <Show when={state() !== 'off'}>
      <Card part="share.card" pad="5" tone={state() === 'error' ? 'bad' : 'neutral'} aria-busy={state() === 'loading' ? 'true' : undefined} aria-label={t('stuff.share.card.label')}>
        <Inline gap="4" align="start">
          <Body state={state()} ctx={ctx} t={t} client={c} face={face} choice={choice()} onChoice={setChoice} onUnlock={unlock} />
          {x()}
        </Inline>
      </Card>
    </Show>
  );
}

function Body(props: { state: CardState; ctx: CardCtx; t: (k: string, v?: Readonly<Record<string, string | number>>) => string; client: PluginClient; face: () => JSX.Element; choice: CardChoice; onChoice: (c: CardChoice) => void; onUnlock: (p: string) => void }): JSX.Element {
  const t = props.t;
  return (
    <>
      <Show when={props.state === 'loading'}>
        <Skeleton shape="circle" width="avatar-md" />
        <Stack gap="2" grow>
          <Skeleton shape="line" width="1/3" />
          <Skeleton shape="line" width="2/3" />
        </Stack>
      </Show>
      <Show when={props.state === 'error'}>
        <Icon name="warn" tone="bad" />
        <Stack gap="1" grow>
          <Text weight="medium">{t('stuff.share.card.cant')}</Text>
          <Text size="sm" tone="muted">
            {props.ctx.error}
          </Text>
        </Stack>
      </Show>
      <Show when={props.state === 'locked' || props.state === 'unlocking'}>
        {props.face()}
        <LockedBody t={t} card={props.ctx.card} busy={props.state === 'unlocking'} onUnlock={props.onUnlock} />
      </Show>
      <Show when={props.state === 'open' && props.ctx.card}>
        {(card) => (
          <>
            {props.face()}
            <OpenBody t={t} card={card()} choice={props.choice} onChoice={props.onChoice} onOpen={(id) => props.client.navigate({ t: 'openTask', id: entityKey(props.client.home, id) as never })} />
          </>
        )}
      </Show>
    </>
  );
}
