// Settings → Machines (v1 settings.js machines, design/v1-reference/settings.machines): other computers that
// run agents for you over SSH (each with its state, Connect / Disconnect / Remove, and Add), reaching this
// computer from anywhere through a wisp Grid, and what another computer needs to reach this one over SSH.
import { createResource, createSignal, onCleanup, Show, type JSX } from 'solid-js';
import { type PluginClient } from '@wisp/client';
import { Slot } from '@wisp/shell';
import { Button, Code, CopyCommand, Link, Pill, SettingsGroup, SettingsNote, SettingsRow, useSignal } from '@wisp/ui';
import { PEER, reachable, STATUS, TOPIC, type PeerBody, type StatusBody } from '../commands.ts';
import { MachinesDialog } from './Manager.tsx';
import { t } from '../i18n.ts';

type Doc<T> = { readonly id: string; readonly body: T };
export default function Machines(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const peer = c.home;
  const scope = c.scope.child('machines-pane');
  onCleanup(() => scope.dispose());
  c.watch(peer, TOPIC, scope);
  const peers = useSignal(c.entities.list<Doc<PeerBody>>(PEER));
  const statuses = useSignal(c.entities.list<Doc<StatusBody>>(STATUS));
  const [reach, { refetch }] = createResource(() => c.run(reachable, { peer }).catch(() => undefined));
  const stateOf = (id: string): StatusBody | undefined => (statuses() as readonly Doc<StatusBody>[]).find((s) => s.body.id === id || s.id === id)?.body;
  // a sandbox belongs to its owner (ADR-0047): never a machine you pick or manage here (Settings → Cloud lists them)
  const list = (): PeerBody[] =>
    (peers() as readonly Doc<PeerBody>[])
      .map((p) => p.body)
      .filter((p) => !p.data?.['sandbox'])
      .sort((a, b) => a.name.localeCompare(b.name));
  const r = () => reach();
  const [managing, setManaging] = createSignal(false);
  const copy = (cmd: string): void => {
    void navigator.clipboard?.writeText(cmd).catch(() => {});
  };
  // v1 places.js machinesSummary: "None yet · run agents…", or how many and how many are online
  const summary = (): string => {
    const n = list().length;
    if (!n) return t('machines.summary.none');
    const on = list().filter((m) => stateOf(m.id)?.state === 'online').length;
    return t('machines.summary', { count: n, online: on ? t('machines.summary.online', { count: on }) : t('machines.summary.noneOnline') });
  };
  return (
    <>
      {/* v1: one row (how many, Manage), the line on where they show, this computer on a grid, then SSH */}
      <SettingsGroup part="machines.summary">
        <SettingsRow
          part="machines.open"
          title={t('machines.title')}
          description={summary()}
          control={
            <Button size="sm" variant="ghost" part="machines.manage" onClick={() => setManaging(true)}>
              {t('machines.manage')}
            </Button>
          }
        />
      </SettingsGroup>
      <SettingsNote part="machines.hint">{t('machines.description')}</SettingsNote>
      <Slot input="shell.settings:machines" layout="contents" />
      <SettingsGroup
        part="machines.ssh"
        bodyPart="settings.reachable"
        title={t('machines.ssh.title')}
        description={t('machines.ssh.description')}
        actions={
          <Button size="sm" variant="ghost" icon="replay" onClick={() => void refetch()}>
            {t('machines.recheck')}
          </Button>
        }
      >
        <Show when={r()} fallback={<SettingsRow part="machines.ssh.looking" title={t('machines.ssh.looking')} />}>
          {(x) => (
            <>
              <SettingsRow
                part="machines.ssh.server"
                title={t('machines.ssh.server')}
                description={x().ssh.running ? x().ssh.banner || t('machines.on') : t('machines.ssh.server.off')}
                control={
                  <Pill tone={x().ssh.running ? 'good' : 'bad'} dot variant="plain">
                    {x().ssh.running ? t('machines.on') : t('machines.off')}
                  </Pill>
                }
              />
              <SettingsRow
                part="machines.ssh.tailscale"
                title="Tailscale"
                description={
                  x().tailscale.running ? (
                    <>
                      {t('machines.tailscale.on.pre')}
                      <Code>{x().tailscale.name ?? ''}</Code>
                    </>
                  ) : x().tailscale.installed ? (
                    t('machines.tailscale.stopped')
                  ) : (
                    t('machines.tailscale.none')
                  )
                }
                control={
                  <Pill tone={x().tailscale.running ? 'good' : 'neutral'} dot variant="plain">
                    {x().tailscale.running ? t('machines.on') : t('machines.off')}
                  </Pill>
                }
              />
              <SettingsRow
                part="machines.ssh.keys"
                title={t('machines.keys')}
                description={
                  <>
                    {t('machines.keys.pre', { count: x().keys })}
                    <Code>~/.ssh/authorized_keys</Code>
                    {t('machines.keys.post')}
                    <CopyCommand command={`ssh-copy-id ${x().target}`} label={t('machines.copy')} onCopy={copy} />
                  </>
                }
                control={
                  <Pill tone={x().keys > 0 ? 'good' : 'neutral'} dot variant="plain">
                    {x().keys > 0 ? t('machines.ready') : t('machines.keys.none')}
                  </Pill>
                }
              />
              <SettingsRow
                part="machines.ssh.target"
                title={t('machines.connectWith')}
                description={
                  <>
                    {t('machines.connectWith.description')}{' '}
                    <Link href="https://trywisp.dev/guides/connect-machines-with-tailscale.html" external>
                      {t('machines.guide')}
                    </Link>
                    <CopyCommand command={x().target} bare label={t('machines.copy')} onCopy={copy} />
                  </>
                }
              />
            </>
          )}
        </Show>
      </SettingsGroup>
      <Show when={managing()}>
        <MachinesDialog client={c} onClose={() => setManaging(false)} />
      </Show>
    </>
  );
}
