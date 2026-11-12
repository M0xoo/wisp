// What a peer's status means, over the list (v1 reconnecting.js, plan §7.2.3, §7.3.2): your own
// wisp reconnecting, a box asleep (with Wake), a peer to update. Rows from the last cursor stay on
// screen under it either way: nothing goes empty while a computer is away.

import { For, Show, createMemo, type JSX } from 'solid-js';
import type { PeerId, PeerStatus } from '@wisp/client';
import { Banner, Button, useSignal } from '@wisp/ui';
import { useShell } from '../context.tsx';

function PeerNote(props: { readonly peer: PeerId }): JSX.Element {
  const shell = useShell();
  const status = useSignal(shell.client.peers.status(props.peer));
  const name = (): string => shell.client.peers.name(props.peer);
  const note = createMemo((): { tone: 'info' | 'warn' | 'bad'; text: string; wake?: boolean } | undefined => {
    const s: PeerStatus = status();
    switch (s.kind) {
      case 'online':
        return undefined;
      case 'connecting':
        return { tone: 'info', text: shell.t('shell.peer.connecting', { name: name() }) };
      case 'asleep':
        return { tone: 'info', text: shell.t('shell.peer.asleep', { name: name() }), wake: true };
      case 'waking':
        return { tone: 'info', text: shell.t('shell.peer.waking', { name: name() }) };
      case 'unreachable':
        return { tone: 'warn', text: shell.t('shell.peer.offline', { name: name() }) };
      case 'incompatible':
        return { tone: 'bad', text: shell.t(s.update === 'app' ? 'shell.peer.updateApp' : 'shell.peer.update', { name: name() }) };
    }
  });
  return (
    <Show when={note()}>
      {(n) => (
        <Banner
          tone={n().tone}
          part="shell.peer.banner"
          action={
            n().wake ? (
              <Button size="sm" variant="secondary" onClick={() => void shell.client.peers.wake(props.peer)}>
                {shell.t('shell.peer.wake')}
              </Button>
            ) : undefined
          }
        >
          {n().text}
        </Banner>
      )}
    </Show>
  );
}

export function PeerBanner(): JSX.Element {
  const shell = useShell();
  const peers = useSignal(shell.client.peers.list());
  return <For each={peers()}>{(p) => <PeerNote peer={p} />}</For>;
}
