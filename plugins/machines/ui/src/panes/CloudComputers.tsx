// Settings → Cloud, under the account (v1 cloud.js cloudPane .cg-list): each cloud computer the grid runs for you, with
// its account and grid, its state, Open (your cloud wisp in the browser), Wake / Try again or Put to sleep, and its
// coding agents signed in to from here (the login runs on the cloud computer and stays there; wisp.accounts fills
// `shell.machine:agents`). Asleep: one line says to wake it first, on the first asleep one only.
import { createMemo, For, onCleanup, Show, type JSX } from 'solid-js';
import { peerId } from '@wisp/client';
import { Slot, useShell } from '@wisp/shell';
import type { ExtensionProps } from '@wisp/shell/contract';
import { Button, Inline, Pill, SettingsGroup, SettingsRow, Stack, Text, useSignal } from '@wisp/ui';
import { connect, PEER, STATUS, stopMachine, TOPIC, type PeerBody, type StatusBody } from '../commands.ts';
import { t } from '../i18n.ts';
import { cloudBoxes, cloudRow, firstAsleep, primaryOf } from '../view.ts';

type Doc<T> = { readonly id: string; readonly body: T };
const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
const TONE: Readonly<Record<string, 'good' | 'warn' | 'bad' | 'neutral'>> = { online: 'good', reconnecting: 'warn', error: 'bad', incompatible: 'bad' };

export default function CloudComputers(props: ExtensionProps): JSX.Element {
  const c = props.client;
  const peer = c.home;
  const shell = useShell();
  const scope = c.scope.child('cloud-computers');
  onCleanup(() => scope.dispose());
  c.watch(peer, TOPIC, scope);
  const peers = useSignal(c.entities.list<Doc<PeerBody>>(PEER));
  const statuses = useSignal(c.entities.list<Doc<StatusBody>>(STATUS));
  // the cards are keyed by the peer's own row, so a status change repaints a card in place (its agents' sign-in kept)
  const boxes = createMemo(() => cloudBoxes((peers() as readonly Doc<PeerBody>[]).map((p) => p.body)));
  const sts = (): StatusBody[] => (statuses() as readonly Doc<StatusBody>[]).map((s) => s.body);
  const first = createMemo(() => firstAsleep(boxes(), sts()));
  const sleep = (m: PeerBody): void =>
    void c.run(stopMachine, { peer, id: m.id, restart: false }).then(
      () => shell.toast.show(t('machines.cloud.asleep', { name: m.name })),
      () => undefined,
    );
  return (
    <Show when={boxes().length > 0}>
      <SettingsGroup part="machines.cloud.list" title={t('machines.cloud.title')}>
        <For each={boxes()}>
          {(box) => {
            const row = createMemo(() => cloudRow(box, sts().find((s) => s.id === box.id), first()));
            const st = (): string => row().state;
            const busy = (): boolean => st() === 'connecting' || st() === 'reconnecting';
            return (
              <Stack gap="2" part="machines.cloud.card">
                <SettingsRow
                  part="machines.cloud.row"
                  wideControl
                  tile="cloud"
                  title={box.name}
                  description={row().who}
                  control={
                    <Inline gap="2">
                      <Pill tone={TONE[st()] ?? 'neutral'} dot live={busy()} variant="plain">
                        {say(`machines.state.${st()}`)}
                      </Pill>
                      <Show when={row().open}>
                        {(u) => (
                          <Button size="sm" variant="ghost" icon="external" title={t('machines.cloud.open.title')} onClick={() => shell.platform.openExternal(u())} part="machines.cloud.open">
                            {t('machines.cloud.open')}
                          </Button>
                        )}
                      </Show>
                      <Show when={st() === 'online'}>
                        <Button size="sm" variant="ghost" title={t('machines.cloud.sleep.title')} onClick={() => sleep(box)} part="machines.cloud.sleep">
                          {t('machines.cloud.sleep')}
                        </Button>
                      </Show>
                      <Show when={st() !== 'online' && !busy()}>
                        <Button size="sm" variant="ghost" onClick={() => void c.run(connect, { peer, id: box.id }).catch(() => {})} part="machines.cloud.wake">
                          {say(primaryOf(box, st()).label)}
                        </Button>
                      </Show>
                    </Inline>
                  }
                />
                <Show when={st() === 'error' && row().error}>
                  <Text tone="bad" size="sm">
                    {row().error}
                  </Text>
                </Show>
                <Show when={row().wakeLine}>
                  <Text tone="muted" size="sm" part="machines.cloud.wakeFirst">
                    {t('machines.cloud.wakeFirst')}
                  </Text>
                </Show>
                <Show when={st() === 'online'}>
                  <Stack gap="1" part="machines.cloud.agents">
                    <Text size="sm" weight="semibold">
                      {t('machines.cloud.agents')}{' '}
                      <Text size="sm" tone="muted">
                        {t('machines.cloud.agents.note')}
                      </Text>
                    </Text>
                    <Slot input="shell.machine:agents" layout="stack" id={peerId(box.id)} />
                  </Stack>
                </Show>
              </Stack>
            );
          }}
        </For>
      </SettingsGroup>
    </Show>
  );
}
