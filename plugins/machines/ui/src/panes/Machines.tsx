// Settings → Machines (v1 settings.js machines, design/v1-reference/settings.machines): other computers that
// run agents for you over SSH (each with its state, Connect / Disconnect / Remove, and Add), reaching this
// computer from anywhere through a wisp Grid, and what another computer needs to reach this one over SSH.
import { createResource, createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import { type PluginClient } from '@wisp/client';
import { Button, Dialog, Field, Inline, Input, Menu, Pill, SettingsGroup, SettingsRow, Stack, Text, useSignal } from '@wisp/ui';
import { addMachine, connect, disconnect, PEER, reachable, removeMachine, STATUS, TOPIC, type PeerBody, type StatusBody } from '../commands.ts';
import { t } from '../i18n.ts';

type Doc<T> = { readonly id: string; readonly body: T };
const quiet = (p: Promise<unknown>): void => {
  p.catch(() => {}); // the shell's onError shows the rollback toast
};

const TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { online: 'good', connecting: 'neutral', reconnecting: 'warn', asleep: 'neutral', off: 'neutral', error: 'bad', incompatible: 'bad' };

function Add(props: { readonly onAdd: (name: string, address: string) => void; readonly onClose: () => void }): JSX.Element {
  const [name, setName] = createSignal('');
  const [address, setAddress] = createSignal('');
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && props.onClose()}
      title={t('machines.add.title')}
      description={t('machines.add.description')}
      part="machines.add"
      footer={
        <Inline gap="3" justify="end">
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            {t('machines.cancel')}
          </Button>
          <Button size="sm" variant="primary" disabled={address().trim() === ''} onClick={() => props.onAdd(name().trim() || address().trim(), address().trim())}>
            {t('machines.add.go')}
          </Button>
        </Inline>
      }
    >
      <Stack gap="3">
        <Field label={t('machines.add.address')} hint={t('machines.add.address.hint')}>
          <Input mono value={address()} onInput={setAddress} placeholder="me@build-box.local" />
        </Field>
        <Field label={t('machines.add.name')}>
          <Input value={name()} onInput={setName} placeholder={t('machines.add.name.placeholder')} />
        </Field>
      </Stack>
    </Dialog>
  );
}

export default function Machines(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const peer = c.home;
  const scope = c.scope.child('machines-pane');
  onCleanup(() => scope.dispose());
  c.watch(peer, TOPIC, scope);
  const peers = useSignal(c.entities.list<Doc<PeerBody>>(PEER));
  const statuses = useSignal(c.entities.list<Doc<StatusBody>>(STATUS));
  const [adding, setAdding] = createSignal(false);
  const [reach, { refetch }] = createResource(() => c.run(reachable, { peer }).catch(() => undefined));
  const stateOf = (id: string): StatusBody | undefined => (statuses() as readonly Doc<StatusBody>[]).find((s) => s.body.id === id || s.id === id)?.body;
  // a sandbox belongs to its owner (ADR-0047): never a machine you pick or manage here (Settings → Cloud lists them)
  const list = (): PeerBody[] =>
    (peers() as readonly Doc<PeerBody>[])
      .map((p) => p.body)
      .filter((p) => !p.data?.['sandbox'])
      .sort((a, b) => a.name.localeCompare(b.name));
  const act = (id: string, v: string): void => {
    if (v === 'connect') quiet(c.run(connect, { peer, id }));
    else if (v === 'disconnect') quiet(c.run(disconnect, { peer, id }));
    else if (v === 'remove') quiet(c.run(removeMachine, { peer, id }));
  };
  const r = () => reach();
  return (
    <>
      <Text as="p" tone="muted" part="machines.lede">
        {t('machines.lede')}
      </Text>
      <SettingsGroup
        part="machines.list"
        title={t('machines.title')}
        description={t('machines.description')}
        actions={
          <Button size="sm" variant="ghost" icon="plus" part="machines.add.open" onClick={() => setAdding(true)}>
            {t('machines.add.title')}
          </Button>
        }
      >
        <Show when={list().length > 0} fallback={<SettingsRow part="machines.empty" title={t('machines.none')} description={t('machines.none.description')} control={<span />} />}>
          <For each={list()}>
            {(m) => {
              const s = () => stateOf(m.id)?.state ?? 'off';
              return (
                <SettingsRow
                  part="machines.row"
                  title={m.name}
                  description={stateOf(m.id)?.error || m.address}
                  control={
                    <Inline gap="2">
                      <Pill tone={TONE[s()] ?? 'neutral'} dot live={s() === 'connecting' || s() === 'reconnecting'} variant="outline">
                        {t(`machines.state.${s() as 'off'}`)}
                      </Pill>
                      <Menu
                        trigger={{ icon: 'dots', 'aria-label': t('machines.more', { name: m.name }), variant: 'ghost', size: 'sm' }}
                        items={[
                          s() === 'off' || s() === 'error' ? { value: 'connect', label: t('machines.connect'), icon: 'play' } : { value: 'disconnect', label: t('machines.disconnect'), icon: 'stop' },
                          { kind: 'separator' },
                          { value: 'remove', label: t('machines.remove'), icon: 'trash', danger: true },
                        ]}
                        onSelect={(v) => act(m.id, v)}
                      />
                    </Inline>
                  }
                />
              );
            }}
          </For>
        </Show>
      </SettingsGroup>
      <SettingsGroup
        part="machines.ssh"
        title={t('machines.ssh.title')}
        description={t('machines.ssh.description')}
        actions={
          <Button size="sm" variant="ghost" icon="rerun" onClick={() => void refetch()}>
            {t('machines.recheck')}
          </Button>
        }
      >
        <Show when={r()} fallback={<Text tone="muted">{t('machines.ssh.looking')}</Text>}>
          {(x) => (
            <>
              <SettingsRow part="machines.ssh.server" title={t('machines.ssh.server')} description={x().ssh.running ? x().ssh.banner || t('machines.on') : t('machines.ssh.server.off')} control={<Pill tone={x().ssh.running ? 'good' : 'bad'} dot variant="outline">{x().ssh.running ? t('machines.on') : t('machines.off')}</Pill>} />
              <SettingsRow
                part="machines.ssh.tailscale"
                title="Tailscale"
                description={x().tailscale.running ? t('machines.tailscale.on', { name: x().tailscale.name ?? '' }) : x().tailscale.installed ? t('machines.tailscale.stopped') : t('machines.tailscale.none')}
                control={<Pill tone={x().tailscale.running ? 'good' : 'neutral'} dot variant="outline">{x().tailscale.running ? t('machines.on') : t('machines.off')}</Pill>}
              />
              <SettingsRow
                part="machines.ssh.keys"
                title={t('machines.keys')}
                description={
                  <Stack gap="1">
                    <Text tone="muted">{t('machines.keys.description', { count: x().keys })}</Text>
                    <Text mono>{`ssh-copy-id ${x().target}`}</Text>
                  </Stack>
                }
                control={<Pill tone={x().keys > 0 ? 'good' : 'warn'} dot variant="outline">{x().keys > 0 ? t('machines.ready') : t('machines.keys.none')}</Pill>}
              />
            </>
          )}
        </Show>
      </SettingsGroup>
      <Show when={adding()}>
        <Add
          onClose={() => setAdding(false)}
          onAdd={(name, address) => {
            setAdding(false);
            quiet(c.run(addMachine, { peer, name, address }));
          }}
        />
      </Show>
    </>
  );
}
