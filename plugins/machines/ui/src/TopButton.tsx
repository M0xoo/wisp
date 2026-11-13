// Machines in the top bar (v1 #machinesBtn): how many are online, the tone when one is in trouble, and the tooltip's
// summary; a click opens Machines. Collapsed, the icon alone.
import { createSignal, onCleanup, Show, type JSX } from 'solid-js';
import type { ExtensionProps } from '@wisp/shell/contract';
import { Button, IconButton, Text, useSignal } from '@wisp/ui';
import { PEER, STATUS, TOPIC, type PeerBody, type StatusBody } from './commands.ts';
import { t } from './i18n.ts';
import { MachinesDialog } from './panes/Manager.tsx';
import { barOf } from './view.ts';

type Doc<T> = { readonly id: string; readonly body: T };

export default function TopButton(props: ExtensionProps): JSX.Element {
  const c = props.client;
  const scope = c.scope.child('machines-bar');
  onCleanup(() => scope.dispose());
  c.watch(c.home, TOPIC, scope);
  const peers = useSignal(c.entities.list<Doc<PeerBody>>(PEER));
  const statuses = useSignal(c.entities.list<Doc<StatusBody>>(STATUS));
  const [open, setOpen] = createSignal(false);
  const bar = () =>
    barOf(
      (peers() as readonly Doc<PeerBody>[]).map((p) => p.body).filter((p) => !p.data?.['sandbox']),
      (statuses() as readonly Doc<StatusBody>[]).map((s) => s.body),
    );
  const label = (): string => (bar().count ? t('machines.bar.summary', { count: bar().count, online: bar().online }) : t('machines.bar.none'));
  return (
    <>
      <Show
        when={props.form !== 'icon'}
        fallback={<IconButton icon="server" label={label()} size="sm" {...(bar().trouble && { tone: 'bad' as const })} onClick={() => setOpen(true)} part="machines.bar" />}
      >
        <Button variant="ghost" size="sm" icon="server" title={label()} aria-label={label()} onClick={() => setOpen(true)} part="machines.bar">
          {t('machines.title')}
          <Show when={bar().online > 0}>
            <Text tone={bar().trouble ? 'bad' : 'good'} numeric weight="semibold">
              {bar().online}
            </Text>
          </Show>
        </Button>
      </Show>
      <Show when={open()}>
        <MachinesDialog client={c} withGrid onClose={() => setOpen(false)} />
      </Show>
    </>
  );
}
