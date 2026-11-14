// The inspector (plan §4.6.8; Settings → Diagnostics, and the palette's Diagnostics): the peers and
// their states, how many rows each store holds, the commands in flight, every live flow's state and
// the last 500 frames, commands, acks, rejects and transitions. Copy report puts the same JSON a bug
// report attaches on the clipboard. The log is read once a second while this is open, not on every
// frame: watching must not slow down what it watches.

import { For, Show, createSignal, onCleanup, type JSX } from 'solid-js';
import type { DevEntry, PeerId, PluginClient } from '@wisp/client';
import { Button, Inline, Pill, Section, SettingsRow, Stack, Text, Time, VirtualList, useSignal } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { STORE_KINDS, describe, newestFirst } from './summary.ts';

function Peer(props: { readonly peer: PeerId }): JSX.Element {
  const shell = useShell();
  const status = useSignal(shell.client.peers.status(props.peer));
  const info = useSignal(shell.client.peers.info(props.peer));
  return (
    <SettingsRow
      title={shell.client.peers.name(props.peer)}
      description={info() ? `${info()?.version ?? ''} · ${info()?.build ?? ''} · ${(info()?.plugins ?? []).length} plugins` : props.peer}
      control={<Pill tone={status().kind === 'online' ? 'good' : status().kind === 'incompatible' ? 'bad' : 'warn'} dot>{status().kind}</Pill>}
    />
  );
}

function Store(props: { readonly kind: string }): JSX.Element {
  const shell = useShell();
  const keys = useSignal(shell.client.entities.keys(props.kind));
  return <SettingsRow title={props.kind} control={<Text numeric tone="muted">{shell.t('shell.diag.rows', { count: keys().length })}</Text>} />;
}

export default function Inspector(_p: { readonly client: PluginClient; readonly params?: unknown }): JSX.Element {
  const shell = useShell();
  const dev = shell.client.devtools;
  const peers = useSignal(shell.client.peers.list());
  const pending = useSignal(shell.client.commands.pending());
  const [log, setLog] = createSignal<readonly (DevEntry & { at: number; key: string })[]>(newestFirst(dev.entries()));
  const [flows, setFlows] = createSignal(Object.entries(dev.machines()));
  const scope = shell.client.scope.child('inspector');
  scope.interval(1000, () => {
    setLog(newestFirst(dev.entries()));
    setFlows(Object.entries(dev.machines()));
  });
  onCleanup(() => scope.dispose());
  const copy = async (): Promise<void> => {
    const peersNow = peers().map((p) => ({ peer: p, status: shell.client.peers.status(p)() }));
    const ok = await shell.platform.copy(dev.export({ peers: peersNow, nav: shell.nav() }));
    if (ok) shell.toast.success(shell.t('shell.diag.copied'));
  };
  return (
    <Stack gap="6" part="shell.devtools">
      <Inline gap="4" justify="between">
        <Text tone="muted" size="sm">{shell.t('shell.diag.title')}</Text>
        <Button size="sm" icon="copy" onClick={() => void copy()}>{shell.t('shell.diag.export')}</Button>
      </Inline>
      <Section title={shell.t('shell.diag.peers')} level={3}>
        <For each={peers()}>{(p) => <Peer peer={p} />}</For>
      </Section>
      <Section title={shell.t('shell.diag.stores')} level={3}>
        <For each={STORE_KINDS}>{(k) => <Store kind={k} />}</For>
      </Section>
      <Section title={shell.t('shell.diag.pending')} level={3}>
        <Show when={pending().length > 0} fallback={<Text tone="muted" size="sm">{shell.t('shell.diag.none')}</Text>}>
          <For each={pending()}>
            {(c) => <SettingsRow title={c.cmd} description={`${c.peer} · ${c.mid}`} control={<Pill tone={c.waiting ? 'warn' : 'info'}>{shell.t(c.waiting ? 'shell.diag.waiting' : 'shell.diag.sent')}</Pill>} />}
          </For>
        </Show>
      </Section>
      <Section title={shell.t('shell.diag.machines')} level={3}>
        <Show when={flows().length > 0} fallback={<Text tone="muted" size="sm">{shell.t('shell.diag.none')}</Text>}>
          <For each={flows()}>{([id, state]) => <SettingsRow title={id} control={<Pill>{state}</Pill>} />}</For>
        </Show>
      </Section>
      <Section title={shell.t('shell.diag.log', { count: log().length })} level={3}>
        <VirtualList items={log()} key={(e) => e.key} estimate={28} height="dialog-sm" part="shell.devtools.log" aria-label={shell.t('shell.diag.log', { count: log().length })}>
          {(e) => (
            <Inline gap="4">
              <Time at={e().at} layout="column" />
              <Text mono size="xs" truncate tone={e().kind === 'reject' || e().kind === 'warn' ? 'bad' : 'ink-2'}>{describe(e())}</Text>
            </Inline>
          )}
        </VirtualList>
      </Section>
    </Stack>
  );
}
