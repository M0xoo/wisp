// Ship it (v1 ship.js shipDialog), an overlay view: it opens on the click in its final shape (the
// route, the fields, the button), guessed from the row; what would ship (git and gh, a second or
// so) fills it in place. Confirm closes it at once and the row follows the stages. A failed ship's
// words come back here on Retry.

import { createSignal, For, Match, onCleanup, Show, Switch, type JSX } from 'solid-js';
import type { EntityKey, PluginClient } from '@wisp/client';
import { Button, Checkbox, Field, Icon, Inline, Input, Skeleton, Stack, Text, TextArea } from '@wisp/ui';
import { prepare } from './commands.ts';
import { flowsFor } from './flows.ts';
import { t } from './i18n.ts';
import { unsentLine } from './model/merge.ts';
import { footLine, goLabel, infoGuess, routeFacts, shipBlock, stepsFor, type ShipGuess } from './model/ship.ts';
import { useShell } from './shell.ts';
import type { ShipInfo, ShipRepo } from './types.ts';
import { SHIP_VIEW, useSession } from './use.ts';

export interface ShipParams {
  readonly key: EntityKey;
  readonly guess: ShipGuess;
}

const isGuess = (g: unknown): g is ShipGuess => !!g && typeof g === 'object' && typeof (g as ShipGuess).repos === 'number' && typeof (g as ShipGuess).update === 'boolean' && Array.isArray((g as ShipGuess).branches);

export function parseShipParams(v: unknown): ShipParams {
  const o = (v ?? {}) as { key?: unknown; guess?: unknown };
  if (typeof o.key !== 'string' || !o.key.includes(':')) throw new Error('Ship it needs the task’s key');
  return { key: o.key as EntityKey, guess: isGuess(o.guess) ? o.guess : { repos: 1, update: false, branches: [] } };
}

function Route(props: { readonly r?: ShipRepo; readonly branch?: string; readonly several: boolean }): JSX.Element {
  return (
    <Stack gap="1" part="ship.route">
      <Inline gap="3">
        <Icon name="branch" size="sm" tone="muted" />
        <Show when={props.several && props.r?.repo}>{(repo) => <Text weight="semibold" nowrap>{repo()}</Text>}</Show>
        <Text mono truncate title={props.r?.branch ?? props.branch ?? ''}>{props.r?.branch ?? props.branch ?? ''}</Text>
        <Icon name="arrow" size="sm" tone="faint" />
        <Show when={props.r} fallback={<Skeleton shape="line" width="1/4" />}>
          {(r) => <Text mono truncate>{`${r().remote || t('wisp.ship.dialog.noRemoteName')}/${r().base}`}</Text>}
        </Show>
      </Inline>
      <Show when={props.r} fallback={<Skeleton shape="line" width="1/2" />}>
        {(r) => <Text size="sm" tone="muted" truncate>{routeFacts(t, r(), props.several)}</Text>}
      </Show>
    </Stack>
  );
}

// size-ok: one form; each field is a line, and the loading shape mirrors it
export default function ShipDialog(props: { readonly client: PluginClient; readonly params: ShipParams }): JSX.Element {
  const shell = useShell();
  const key = props.params.key;
  const flows = flowsFor(props.client, () => shell, key);
  const s = useSession(props.client, () => key);
  const typed = flows.run()?.error !== undefined ? flows.run()?.values : undefined; // a failed ship's words, back for Retry
  const [info, setInfo] = createSignal<ShipInfo>();
  const [title, setTitle] = createSignal('');
  const [body, setBody] = createSignal('');
  const [draft, setDraft] = createSignal(typed?.draft ?? false);
  const scope = props.client.scope.child('ship-dialog');
  onCleanup(() => scope.dispose());
  const close = (): void => props.client.navigate({ t: 'closeOverlay', id: SHIP_VIEW as never });
  // A flow of its own: leaving (closing the dialog) drops a late answer.
  props.client.machine<'loading' | 'ready' | 'failed', 'loaded', void>(
    {
      id: `wisp.ship.prepare:${key}`,
      initial: 'loading',
      states: {
        loading: {
          async invoke() {
            const i = await props.client.run(prepare, { key });
            setTitle(typed?.title || i.title);
            setBody(typed?.body ?? i.body);
            setInfo(i);
            return 'loaded';
          },
          on: { loaded: 'ready' },
          onError: 'failed',
        },
        ready: {},
        // the shell's toast says why; nothing to ship from here
        failed: { invoke: () => close() },
      },
    },
    undefined,
    scope,
  );
  const guess = (): ShipGuess => {
    const i = info();
    return i ? infoGuess(i) : props.params.guess;
  };
  const repos = (): readonly ShipRepo[] => {
    const i = info();
    return i ? (i.repos ?? [i]) : [];
  };
  const several = (): boolean => guess().repos > 1;
  const block = () => {
    const i = info();
    return i ? shipBlock(i) : undefined;
  };
  let titleBox: HTMLInputElement | undefined;
  const go = (): void => {
    const i = info();
    if (!i) return;
    if (i.dirty && !title().trim()) {
      titleBox?.focus();
      shell.toast.error(t('wisp.ship.dialog.needTitle'));
      return;
    }
    const g = infoGuess(i);
    const values = { title: title() || i.title, body: g.update ? i.body : body(), draft: !g.update && draft() };
    close();
    flows.start({ steps: stepsFor(i.dirty > 0), values, update: g.update });
  };
  return (
    <Stack gap="6" part="ship.dialog">
      <Stack gap="4">
        <Show when={info()} fallback={<For each={props.params.guess.branches.length ? props.params.guess.branches : ['']}>{(b) => <Route branch={b} several={several()} />}</For>}>
          <For each={repos()}>{(r) => <Route r={r} several={several()} />}</For>
        </Show>
      </Stack>
      <Show when={!info() || info()?.dirty}>
        <Field label={guess().update ? t('wisp.ship.dialog.message') : t('wisp.ship.dialog.messageTitle')}>
          <Show when={info()} fallback={<Skeleton shape="block" height="control-md" width="full" />}>
            <Input value={title()} onInput={setTitle} maxLength={100} spellcheck={false} autofocus ref={(el) => (titleBox = el)} onKeyDown={(e) => e.key === 'Enter' && go()} />
          </Show>
        </Field>
      </Show>
      <Show when={!guess().update}>
        <Field label={t('wisp.ship.dialog.body')}>
          <Show when={info()} fallback={<Skeleton shape="block" height="avatar-lg" width="full" />}>
            <TextArea value={body()} onInput={setBody} mono spellcheck={false} minRows={6} maxRows={14} />
          </Show>
        </Field>
        <Checkbox checked={draft()} onChange={setDraft} label={t('wisp.ship.dialog.draft')} disabled={!info()} />
      </Show>
      <Show when={s()?.overlap}>{(o) => <Text as="p" size="sm" tone="warn" breakAnywhere>{o()}</Text>}</Show>
      <Show when={unsentLine(t, s()?.unsentComments)}>{(line) => <Text as="p" size="sm" tone="warn">{line()}</Text>}</Show>
      <Switch>
        <Match when={block() === 'noRemote'}>
          <Text as="p" size="sm" tone="bad">{several() ? t('wisp.ship.dialog.noRemoteMany') : t('wisp.ship.dialog.noRemote')}</Text>
        </Match>
        <Match when={block() === 'nothing'}>
          <Text as="p" size="sm" tone="muted">{t('wisp.ship.dialog.nothing')}</Text>
        </Match>
      </Switch>
      <Stack gap="3">
        <Text as="p" size="xs" tone="muted">{footLine(t, guess())}</Text>
        <Inline gap="3" justify="end">
          <Button variant="secondary" size="sm" onClick={close}>{t('wisp.ship.cancel')}</Button>
          <Button variant="primary" size="sm" icon="send" disabled={!info() || block() !== undefined} onClick={go} part="ship.go">
            {goLabel(t, guess())}
          </Button>
        </Inline>
      </Stack>
    </Stack>
  );
}
